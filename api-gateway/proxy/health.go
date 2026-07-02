package proxy

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// SystemHealth checks all downstream services concurrently.
func SystemHealth(c *gin.Context) {
	services := map[string]string{
		"auth":           getEnv("AUTH_BASE_URL", "http://auth-service:8083") + "/actuator/health",
		"user":           getEnv("USER_BASE_URL", "http://user-service:8085") + "/actuator/health",
		"media":          getEnv("MEDIA_BASE_URL", "http://media-library-service:8001") + "/health",
		"analytics":      getEnv("ANALYTICS_BASE_URL", "http://analytics-service:8086") + "/actuator/health",
		"recommendation": getEnv("RECOMMENDATION_BASE_URL", "http://recommendation-service:8087") + "/actuator/health",
		"watchhistory":   getEnv("WATCHHISTORY_BASE_URL", "http://watchhistory-service:8090") + "/actuator/health",
		"metadata":       getEnv("METADATA_BASE_URL", "http://metadata-service:8088") + "/api/metadata/all",
		"interaction":    getEnv("INTERACTION_BASE_URL", "http://interaction-service:8089") + "/actuator/health",
		"payment":        getEnv("PAYMENT_BASE_URL", "http://payment-service:8091") + "/actuator/health",
		"subscription":   getEnv("SUBSCRIPTION_BASE_URL", "http://subscription-service:8093") + "/actuator/health",
		"transcoding":    getEnv("TRANSCODING_BASE_URL", "http://transcoding-service:8092") + "/health",
	}

	results := make(map[string]bool, len(services)+1)
	results["api_gateway"] = true

	var mu sync.Mutex
	var wg sync.WaitGroup

	client := &http.Client{Timeout: 3 * time.Second}

	for name, url := range services {
		wg.Add(1)
		go func(n, u string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()

			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			resp, err := client.Do(req)

			mu.Lock()
			results[n] = err == nil && resp.StatusCode == http.StatusOK
			mu.Unlock()
		}(name, url)
	}

	wg.Wait()
	c.JSON(http.StatusOK, results)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
