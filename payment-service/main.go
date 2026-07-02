package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/grafana/pyroscope-go"
	"github.com/myflix/payment-service/telemetry"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type PaymentOrder struct {
	ID      string `gorm:"primaryKey"   json:"id"`
	UserID  uint   `gorm:"not null"     json:"userId"`
	Amount  int    `gorm:"not null"     json:"amount"`
	PlanID  string `gorm:"not null"     json:"planId"`
	Status  string `gorm:"not null"     json:"status"`
	Receipt string `json:"receipt"`
}

var db *gorm.DB

func main() {
	pyroscope.Start(pyroscope.Config{
		ApplicationName: "payment-service",
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
	db.AutoMigrate(&PaymentOrder{})

	shutdown := telemetry.InitTracer("payment-service")
	defer shutdown()

	r := gin.Default()
	r.Use(TracingMiddleware())
	r.GET("/actuator/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "UP"}) })
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))
	p := r.Group("/api/payment")
	p.POST("/create-order", createOrder)
	p.POST("/capture-payment", capturePayment)
	p.GET("/status/:orderId", getStatus)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8091"
	}
	log.Fatal(r.Run(":" + port))
}

// createOrderReq is the request body for POST /api/payment/create-order.
// userId and planId are captured here so capturePayment can forward them.
type createOrderReq struct {
	UserID uint   `json:"userId"  binding:"required"`
	PlanID string `json:"planId"  binding:"required"`
	Amount int    `json:"amount"  binding:"required,min=1"`
}

func createOrder(c *gin.Context) {
	var req createOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	order := PaymentOrder{
		ID:      generateOrderID(),
		UserID:  req.UserID,
		Amount:  req.Amount,
		PlanID:  req.PlanID,
		Status:  "CREATED",
		Receipt: "receipt_" + generateOrderID(),
	}
	db.WithContext(c.Request.Context()).Create(&order)
	c.JSON(http.StatusCreated, order)
}

func capturePayment(c *gin.Context) {
	orderID := c.Query("orderId")
	if orderID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "orderId required"})
		return
	}

	var order PaymentOrder
	if err := db.WithContext(c.Request.Context()).First(&order, "id = ?", orderID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}

	order.Status = "CAPTURED"
	db.WithContext(c.Request.Context()).Save(&order)

	// ── Notify subscription-service synchronously so the trace is complete ──
	if err := notifySubscriptionService(c.Request.Context(), order.UserID, order.PlanID); err != nil {
		log.Printf("subscription-service notification failed: %v", err)
	}

	c.JSON(http.StatusOK, order)
}

// notifySubscriptionService calls subscription-service with the captured
// payment's userId and planId, propagating the current trace context so
// Jaeger shows: payment-service → subscription-service.
func notifySubscriptionService(ctx context.Context, userID uint, planID string) error {
	subscriptionURL := fmt.Sprintf(
		"%s/api/subscription/upgrade?userId=%d&plan=%s",
		getEnv("SUBSCRIPTION_BASE_URL", "http://subscription-service:8093"),
		userID, planID,
	)

	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, subscriptionURL, bytes.NewReader(nil))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	// Inject W3C traceparent header so subscription-service continues the trace.
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("call subscription-service: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	log.Printf("subscription-service responded %d: %s", resp.StatusCode, body)
	return nil
}

func getStatus(c *gin.Context) {
	var order PaymentOrder
	if err := db.WithContext(c.Request.Context()).First(&order, "id = ?", c.Param("orderId")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	c.JSON(http.StatusOK, order)
}

func generateOrderID() string {
	return "order_" + os.Getenv("HOSTNAME") + "_" + randomSuffix()
}

func randomSuffix() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("payment-service")

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
