package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/user-service/handler"
	"github.com/myflix/user-service/store"
	"github.com/myflix/user-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

func main() {

	pyroscope.Start(pyroscope.Config{
		ApplicationName: "user-service",
		ServerAddress:   "http://pyroscope:4040",
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileGoroutines,
		},
	})

	shutdown := telemetry.InitTracer("user-service")
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
	u := r.Group("/api/user")
	u.POST("", h.CreateUser)
	u.GET("/by-username", h.GetByUsername) // internal: auth-service calls this post-login
	u.GET("/:id", h.GetUser)

	// Profiles
	u.POST("/profiles", h.CreateProfile)
	u.GET("/profiles", h.GetProfiles) // ?userId=
	u.GET("/profiles/:id", h.GetProfile)
	u.DELETE("/profiles/:id", h.DeleteProfile)

	// Watch history
	u.POST("/history", h.SaveHistory)
	u.GET("/history", h.GetHistory) // ?profileId=

	// Watchlist
	u.POST("/watchlist", h.AddToWatchlist)
	u.DELETE("/watchlist", h.RemoveFromWatchlist) // ?profileId=&mediaPath=
	u.GET("/watchlist", h.GetWatchlist)           // ?profileId=

	u.GET("/trending", h.GetTrending)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8085"
	}
	log.Printf("User service listening on :%s", port)
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
