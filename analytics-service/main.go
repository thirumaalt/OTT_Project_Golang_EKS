package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/analytics-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Analytics struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint      `gorm:"not null;index"           json:"userId"`
	Action    string    `gorm:"not null"                 json:"action"`
	ContentID string    `gorm:"not null"                 json:"contentId"`
	CreatedAt time.Time `json:"createdAt"`
}

var db *gorm.DB

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "analytics-service",
		ServerAddress:   "http://pyroscope:4040",
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileGoroutines,
		},
	})
	var err error
	db, err = gorm.Open(postgres.Open(os.Getenv("DATABASE_URL")), &gorm.Config{})
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	if err := db.Use(telemetry.NewGormPlugin()); err != nil {
		log.Fatalf("otelgorm plugin: %v", err)
	}
	db.AutoMigrate(&Analytics{})

	shutdown := telemetry.InitTracer("analytics-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	a := r.Group("/api/analytics")
	a.POST("/record", recordAction)
	a.GET("/all", getAll)
	a.GET("/stats", getStats)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8086"
	}
	log.Fatal(r.Run(":" + port))
}

func recordAction(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	action := c.Query("action")
	contentID := c.Query("contentId")
	if action == "" || contentID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "action and contentId required"})
		return
	}
	a := Analytics{UserID: uint(userID), Action: action, ContentID: contentID, CreatedAt: time.Now()}
	db.WithContext(c.Request.Context()).Create(&a)
	c.JSON(http.StatusCreated, a)
}

func getAll(c *gin.Context) {
	var list []Analytics
	db.WithContext(c.Request.Context()).Order("created_at desc").Find(&list)
	c.JSON(http.StatusOK, list)
}

func getStats(c *gin.Context) {
	var results []struct {
		Action string
		Count  int64
	}
	db.WithContext(c.Request.Context()).Model(&Analytics{}).Select("action, count(*) as count").Group("action").Scan(&results)
	stats := make(map[string]int64, len(results))
	for _, r := range results {
		stats[r.Action] = r.Count
	}
	c.JSON(http.StatusOK, stats)
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("analytics-service")

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
