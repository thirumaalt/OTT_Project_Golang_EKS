package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/media-library-service/handler"
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

	// Configuration
	mediaDir := os.Getenv("MEDIA_DATA_DIR")
	if mediaDir == "" {
		mediaDir = "/media"
	}

	// Initialize scanner
	s := scanner.New(mediaDir)

	// Initialize handler
	h := handler.New(s)

	shutdown := telemetry.InitTracer("media-library-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	// Health check
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "media_dir": mediaDir})
	})

	// Media routes
	media := r.Group("/api/media")
	media.GET("/library", h.GetLibrary)
	media.GET("/search", h.Search)
	media.GET("/stream", h.Stream)
	media.GET("/hls/:file_id/:filename", h.GetHLSFile)
	media.POST("/upload", h.Upload)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8001"
	}

	log.Printf("Media Library Service listening on :%s", port)
	log.Printf("Media directory: %s", mediaDir)
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
