package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/metadata-service/handler"
	"github.com/myflix/metadata-service/store"
	"github.com/myflix/metadata-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "metadata-service",
		ServerAddress:   "http://pyroscope:4040",
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileGoroutines,
		},
	})

	shutdown := telemetry.InitTracer("metadata-service")
	defer shutdown()

	db := store.Connect(os.Getenv("DATABASE_URL"))
	if err := db.Use(telemetry.NewGormPlugin()); err != nil {
		log.Fatalf("gorm plugin: %v", err)
	}
	store.Migrate(db)

	h := handler.New(db)

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	meta := r.Group("/api/metadata")
	meta.GET("", h.ListMedia)               // list / filter
	meta.POST("", h.CreateMedia)            // create
	meta.GET("/search", h.SearchMedia)      // full-text search
	meta.GET("/by-path", h.GetByPath)       // lookup by file path
	meta.GET("/title/:title", h.GetByTitle) // TMDB-proxy lookup by title (frontend compat)
	meta.POST("/bulk", h.BulkUpsert)        // bulk upsert
	meta.GET("/discover", discoverHandler)  // chained: recommendations + watch-history
	meta.GET("/:id", h.GetMedia)            // get by id
	meta.PUT("/:id", h.UpdateMedia)         // update
	meta.DELETE("/:id", h.DeleteMedia)      // delete

	port := os.Getenv("PORT")
	if port == "" {
		port = "8088"
	}
	log.Printf("Metadata service listening on :%s", port)
	log.Fatal(r.Run(":" + port))
}

// discoverHandler fans out to recommendation-service and watchhistory-service
// within the same distributed trace.
//
// GET /api/metadata/discover?userId=123
func discoverHandler(c *gin.Context) {
	userID := c.Query("userId")
	if userID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId query param is required"})
		return
	}

	ctx := c.Request.Context()

	// Instrumented HTTP client — creates child spans automatically.
	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}

	// ── 1. Call recommendation-service ──────────────────────────────────────
	recURL := fmt.Sprintf("%s/api/recommendations/get?userId=%s",
		getEnv("RECOMMENDATION_BASE_URL", "http://recommendation-service:8087"), userID)

	recReq, err := http.NewRequestWithContext(ctx, http.MethodGet, recURL, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to build recommendation request"})
		return
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(recReq.Header))

	recResp, err := client.Do(recReq)
	var recommendations interface{}
	if err == nil {
		defer recResp.Body.Close()
		body, _ := io.ReadAll(recResp.Body)
		_ = json.Unmarshal(body, &recommendations)
	} else {
		log.Printf("recommendation-service call failed: %v", err)
		recommendations = []interface{}{}
	}

	// ── 2. Call watchhistory-service (user-scoped) ──────────────────────────
	whURL := fmt.Sprintf("%s/api/watch-history/user?userId=%s",
		getEnv("WATCHHISTORY_BASE_URL", "http://watchhistory-service:8090"), userID)

	whReq, err := http.NewRequestWithContext(ctx, http.MethodGet, whURL, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to build watchhistory request"})
		return
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(whReq.Header))

	whResp, err := client.Do(whReq)
	var watchHistory interface{}
	if err == nil {
		defer whResp.Body.Close()
		body, _ := io.ReadAll(whResp.Body)
		_ = json.Unmarshal(body, &watchHistory)
	} else {
		log.Printf("watchhistory-service call failed: %v", err)
		watchHistory = []interface{}{}
	}

	c.JSON(http.StatusOK, gin.H{
		"userId":          userID,
		"recommendations": recommendations,
		"watchHistory":    watchHistory,
	})
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("metadata-service")

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
