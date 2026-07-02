package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/auth-service/handler"
	"github.com/myflix/auth-service/store"
	"github.com/myflix/auth-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

func main() {

	pyroscope.Start(pyroscope.Config{
		ApplicationName: "auth-service",
		ServerAddress:   "http://pyroscope:4040",
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileGoroutines,
		},
	})

	shutdown := telemetry.InitTracer("auth-service")
	defer shutdown()

	db := store.Connect(os.Getenv("DATABASE_URL"))
	if err := db.Use(telemetry.NewGormPlugin()); err != nil {
		log.Fatalf("gorm plugin: %v", err)
	}
	store.Migrate(db)

	h := handler.New(db, os.Getenv("JWT_SECRET"), os.Getenv("USER_SERVICE_URL"))

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })

	auth := r.Group("/api/auth")
	auth.POST("/register", h.Register)
	auth.POST("/login", h.Login)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}
	log.Printf("Auth service listening on :%s", port)
	log.Fatal(r.Run(":" + port))
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("auth-service")

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
