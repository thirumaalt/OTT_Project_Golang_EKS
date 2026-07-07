package main

import (
	"context"
	"log"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/media-library-service/handler"
	"github.com/myflix/media-library-service/s3store"
	"github.com/myflix/media-library-service/scanner"
	"github.com/myflix/media-library-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "media-library-service",
		ServerAddress:   "http://pyroscope:4040",
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileGoroutines,
		},
	})

	// Configuration — MEDIA_DATA_DIR is gone; media now lives in S3.
	bucketName := os.Getenv("S3_BUCKET_NAME")
	if bucketName == "" {
		log.Fatal("S3_BUCKET_NAME environment variable is required")
	}
	awsRegion := os.Getenv("AWS_REGION")
	if awsRegion == "" {
		awsRegion = "ap-south-1"
	}

	// s3store.New calls config.LoadDefaultConfig, which picks up IRSA
	// credentials automatically via the pod's ServiceAccount — no keys
	// passed here. context.Background() is fine for this one-time setup
	// call; it's not tied to any single request's lifecycle.
	store, err := s3store.New(context.Background(), bucketName, awsRegion)
	if err != nil {
		log.Fatalf("Failed to initialize S3 store: %v", err)
	}

	s := scanner.New(store)
	h := handler.New(s, store)

	shutdown := telemetry.InitTracer("media-library-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "s3_bucket": bucketName})
	})

	media := r.Group("/api/media")
	media.GET("/library", h.GetLibrary)
	media.GET("/search", h.Search)
	media.GET("/stream", h.Stream)
	media.GET("/hls/:file_id/*filepath", h.GetHLSFile)
	media.POST("/upload", h.Upload)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8001"
	}

	log.Printf("Media Library Service listening on :%s", port)
	log.Printf("S3 bucket: %s (region %s)", bucketName, awsRegion)
	log.Fatal(r.Run(":" + port))
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("user-service")

	return func(c *gin.Context) {

		ctx := otel.GetTextMapPropagator().Extract(
			c.Request.Context(),
			propagation.HeaderCarrier(c.Request.Header),
		)

		ctx, span := tracer.Start(
			ctx,
			c.Request.Method+" "+c.FullPath(),
		)

		defer span.End()

		c.Request = c.Request.WithContext(ctx)

		c.Next()
	}
}
