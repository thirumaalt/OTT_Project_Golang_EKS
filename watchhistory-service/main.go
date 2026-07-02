package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/watchhistory-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type WatchHistory struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint      `gorm:"not null;index"           json:"userId"`
	ContentID uint      `gorm:"not null"                 json:"contentId"`
	WatchedAt time.Time `json:"watchedAt"`
}

var db *gorm.DB

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "watchhistory-service",
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
	db.AutoMigrate(&WatchHistory{})

	shutdown := telemetry.InitTracer("watchhistory-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	wh := r.Group("/api/watch-history")
	wh.POST("/record", recordWatch)
	wh.GET("/user", getByUser)
	wh.GET("/all", getAll)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	log.Fatal(r.Run(":" + port))
}

func recordWatch(c *gin.Context) {
	userID, err1 := strconv.ParseUint(c.Query("userId"), 10, 64)
	contentID, err2 := strconv.ParseUint(c.Query("contentId"), 10, 64)
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId and contentId required"})
		return
	}
	wh := WatchHistory{UserID: uint(userID), ContentID: uint(contentID), WatchedAt: time.Now()}
	db.WithContext(c.Request.Context()).Create(&wh)
	c.JSON(http.StatusCreated, wh)
}

func getByUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	var list []WatchHistory
	db.WithContext(c.Request.Context()).Where("user_id = ?", userID).Order("watched_at desc").Find(&list)
	c.JSON(http.StatusOK, list)
}

func getAll(c *gin.Context) {
	var list []WatchHistory
	db.WithContext(c.Request.Context()).Order("watched_at desc").Find(&list)
	c.JSON(http.StatusOK, list)
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("watchhistory-service")

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
