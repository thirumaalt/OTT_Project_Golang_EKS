package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/interaction-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Like struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint      `gorm:"not null;index"           json:"userId"`
	ContentID uint      `gorm:"not null;index"           json:"contentId"`
	CreatedAt time.Time `json:"createdAt"`
}

type Rating struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint      `gorm:"uniqueIndex:idx_user_content;not null" json:"userId"`
	ContentID uint      `gorm:"uniqueIndex:idx_user_content;not null" json:"contentId"`
	Score     int       `gorm:"not null"                             json:"score"`
	UpdatedAt time.Time `json:"updatedAt"`
}

var db *gorm.DB

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "interaction-service",
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
	db.AutoMigrate(&Like{}, &Rating{})

	shutdown := telemetry.InitTracer("interaction-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	ia := r.Group("/api/interaction")
	ia.POST("/like", addLike)
	ia.DELETE("/like", removeLike)
	ia.GET("/likes", getLikes)
	ia.POST("/rating", upsertRating)
	ia.GET("/rating", getRating)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8089"
	}
	log.Printf("Interaction service listening on :%s", port)
	log.Fatal(r.Run(":" + port))
}

func addLike(c *gin.Context) {
	userID, err1 := strconv.ParseUint(c.Query("userId"), 10, 64)
	contentID, err2 := strconv.ParseUint(c.Query("contentId"), 10, 64)
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId and contentId required"})
		return
	}
	like := Like{UserID: uint(userID), ContentID: uint(contentID), CreatedAt: time.Now()}
	db.WithContext(c.Request.Context()).Create(&like)
	c.JSON(http.StatusCreated, like)
}

func removeLike(c *gin.Context) {
	userID, err1 := strconv.ParseUint(c.Query("userId"), 10, 64)
	contentID, err2 := strconv.ParseUint(c.Query("contentId"), 10, 64)
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId and contentId required"})
		return
	}
	db.WithContext(c.Request.Context()).Where("user_id = ? AND content_id = ?", userID, contentID).Delete(&Like{})
	c.JSON(http.StatusOK, gin.H{"status": "removed"})
}

func getLikes(c *gin.Context) {
	contentID, err := strconv.ParseUint(c.Query("contentId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "contentId required"})
		return
	}
	var count int64
	db.WithContext(c.Request.Context()).Model(&Like{}).Where("content_id = ?", contentID).Count(&count)
	c.JSON(http.StatusOK, gin.H{"contentId": contentID, "likes": count})
}

func upsertRating(c *gin.Context) {
	userID, err1 := strconv.ParseUint(c.Query("userId"), 10, 64)
	contentID, err2 := strconv.ParseUint(c.Query("contentId"), 10, 64)
	score, err3 := strconv.Atoi(c.Query("score"))
	if err1 != nil || err2 != nil || err3 != nil || score < 1 || score > 10 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId, contentId, and score (1-10) required"})
		return
	}
	var rating Rating
	result := db.WithContext(c.Request.Context()).Where("user_id = ? AND content_id = ?", userID, contentID).First(&rating)
	if result.Error != nil {
		rating = Rating{UserID: uint(userID), ContentID: uint(contentID), Score: score, UpdatedAt: time.Now()}
		db.WithContext(c.Request.Context()).Create(&rating)
	} else {
		rating.Score = score
		rating.UpdatedAt = time.Now()
		db.WithContext(c.Request.Context()).Save(&rating)
	}
	c.JSON(http.StatusOK, rating)
}

func getRating(c *gin.Context) {
	contentID, err := strconv.ParseUint(c.Query("contentId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "contentId required"})
		return
	}
	var result struct {
		Average float64
		Count   int64
	}
	db.WithContext(c.Request.Context()).Model(&Rating{}).
		Where("content_id = ?", contentID).
		Select("AVG(score) as average, COUNT(*) as count").
		Scan(&result)
	c.JSON(http.StatusOK, gin.H{"contentId": contentID, "average": result.Average, "count": result.Count})
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("interaction-service")

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
