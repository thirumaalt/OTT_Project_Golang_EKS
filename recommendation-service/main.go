package main

import (
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/recommendation-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Recommendation struct {
	ID      uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID  uint   `gorm:"not null;index"           json:"userId"`
	Content string `gorm:"not null"                 json:"content"`
}

var db *gorm.DB

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "recommendation-service",
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
	db.AutoMigrate(&Recommendation{})

	shutdown := telemetry.InitTracer("recommendation-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	rec := r.Group("/api/recommendations")
	rec.POST("/add", addRecommendation)
	rec.GET("/get", getRecommendations)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8087"
	}
	log.Fatal(r.Run(":" + port))
}

func addRecommendation(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	content := c.Query("content")
	if content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content required"})
		return
	}
	rec := Recommendation{UserID: uint(userID), Content: content}
	db.WithContext(c.Request.Context()).Create(&rec)
	c.JSON(http.StatusCreated, rec)
}

func getRecommendations(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	var list []Recommendation
	db.WithContext(c.Request.Context()).Where("user_id = ?", userID).Find(&list)
	c.JSON(http.StatusOK, list)
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("recommendation-service")

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
