package main

import (
	"context"
	"log"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/media-library-service/handler"
	"github.com/myflix/media-library-service/localstore"
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

	// Configuration. STORAGE_BACKEND selects where media lives:
	//   "s3"    (default) - STORAGE_PATH is the bucket name; credentials come
	//                       from the AWS default chain (IRSA on EKS).
	//   "local"           - STORAGE_PATH is a directory (e.g. /media on a PVC).
	backend := os.Getenv("STORAGE_BACKEND")
	if backend == "" {
		backend = "s3"
	}
	storagePath := os.Getenv("STORAGE_PATH")
	if storagePath == "" {
		log.Fatal("STORAGE_PATH environment variable is required")
	}

	var store s3store.Store
	switch backend {
	case "local":
		ls, err := localstore.New(storagePath)
		if err != nil {
			log.Fatalf("Failed to initialize local store: %v", err)
		}
		store = ls
		log.Printf("Storage: local directory %s", storagePath)
	case "s3":
		awsRegion := os.Getenv("AWS_REGION")
		if awsRegion == "" {
			awsRegion = "ap-south-1"
		}
		// s3store.New calls config.LoadDefaultConfig, which picks up IRSA
		// credentials via the pod's ServiceAccount - no keys passed here.
		c, err := s3store.New(context.Background(), storagePath, awsRegion)
		if err != nil {
			log.Fatalf("Failed to initialize S3 store: %v", err)
		}
		store = c
		log.Printf("Storage: S3 bucket %s (region %s)", storagePath, awsRegion)
	default:
		log.Fatalf("Unknown STORAGE_BACKEND %q (use \"s3\" or \"local\")", backend)
	}

	s := scanner.New(store)
	h := handler.New(s, store)

	shutdown := telemetry.InitTracer("media-library-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "STORAGE_BACKEND": backend, "STORAGE_PATH": storagePath})
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
