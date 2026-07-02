package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/myflix/auth-service/store"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

type Handler struct {
	db             *gorm.DB
	jwtSecret      []byte
	userServiceURL string
}

func New(db *gorm.DB, secret string, userServiceURL string) *Handler {
	if secret == "" {
		panic("JWT_SECRET is required")
	}
	if userServiceURL == "" {
		userServiceURL = "http://user-service:8085"
	}
	return &Handler{db: db, jwtSecret: []byte(secret), userServiceURL: userServiceURL}
}

type registerRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Password string `json:"password" binding:"required,min=8"`
	Email    string `json:"email"    binding:"required,email"`
}

type loginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

// Register creates a new user account.
func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
		return
	}

	user := store.User{
		Username: req.Username,
		Password: string(hash),
		Email:    req.Email,
	}

	if result := h.db.WithContext(c.Request.Context()).Create(&user); result.Error != nil {
		// Return generic message — don't reveal whether username/email exists
		c.JSON(http.StatusConflict, gin.H{"error": "registration failed"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"userId":   user.ID,
		"username": user.Username,
		"email":    user.Email,
	})
}

// Login validates credentials, returns a signed JWT, and enriches the response
// by calling user-service within the same distributed trace so Jaeger shows:
//
//	api-gateway → auth-service → user-service
func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var user store.User
	if err := h.db.WithContext(c.Request.Context()).Where("username = ?", req.Username).First(&user).Error; err != nil {
		// Constant-time response — prevents user enumeration
		bcrypt.CompareHashAndPassword([]byte("$2a$12$placeholder"), []byte(req.Password))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	token, err := h.generateToken(user)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	// ── Call user-service to fetch the user profile (propagates trace) ────────
	userProfile := h.fetchUserProfile(c.Request.Context(), req.Username)

	c.JSON(http.StatusOK, gin.H{
		"token":    token,
		"userId":   user.ID,
		"username": user.Username,
		"profile":  userProfile,
	})
}

// fetchUserProfile calls GET /api/user/by-username on user-service, injecting
// the current span context so Jaeger links auth-service → user-service.
func (h *Handler) fetchUserProfile(ctx context.Context, username string) interface{} {
	url := fmt.Sprintf("%s/api/user/by-username?username=%s", h.userServiceURL, username)

	client := &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		log.Printf("auth: build user-service request failed: %v", err)
		return nil
	}
	// Inject W3C traceparent/tracestate headers into outbound request.
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("auth: user-service call failed: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("auth: user-service returned %d for username %q", resp.StatusCode, username)
		return nil
	}

	body, _ := io.ReadAll(resp.Body)
	var profile interface{}
	if err := json.Unmarshal(body, &profile); err != nil {
		log.Printf("auth: failed to parse user-service response: %v", err)
		return nil
	}
	return profile
}

func (h *Handler) generateToken(user store.User) (string, error) {
	claims := jwt.MapClaims{
		"sub":    user.Username,
		"userId": user.ID,
		"iat":    time.Now().Unix(),
		"exp":    time.Now().Add(24 * time.Hour).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS512, claims).SignedString(h.jwtSecret)
}
