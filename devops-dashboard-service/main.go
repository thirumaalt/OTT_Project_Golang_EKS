package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/myflix/devops-dashboard-service/checks"
	"github.com/myflix/devops-dashboard-service/deploy"
)

// manifestPaths maps each service to where its Deployment YAML lives in
// the repo — needed since BumpImageTag edits a specific file, not just
// "the cluster." Adjust these if your repo's actual layout differs.
var manifestPaths = map[string]string{
	"auth-service":           "eks/service/auth-service.yaml",
	"user-service":           "eks/service/user-service.yaml",
	"metadata-service":       "eks/service/metadata-service.yaml",
	"recommendation-service": "eks/service/recommendation-service.yaml",
	"watchhistory-service":   "eks/service/watchhistory-service.yaml",
	"interaction-service":    "eks/service/interaction-service.yaml",
	"subscription-service":   "eks/service/subscription-service.yaml",
	"analytics-service":      "eks/service/analytics-service.yaml",
	"api-gateway":            "eks/service/api-gateway.yaml",
	"payment-service":        "eks/service/payment-service.yaml",
	"transcoding-service":    "eks/service/transcoding-service.yaml",
	"media-library-service":  "eks/service/media-library-service.yaml",
	"frontend-ui":            "eks/service/frontend-ui.yaml",
	"admin-dashboard":        "eks/service/admin-dashboard.yaml",
}

// Config values that differ per environment — read from env vars set in
// the Deployment manifest, same pattern as every other service in this
// project. Nothing here is a secret; these are just resource identifiers.
type config struct {
	Namespace      string
	Region         string
	ClusterName    string
	DBInstanceID   string
	CacheClusterID string
	S3Bucket       string
	DistributionID string
	ECRRegistry    string
	GitHubOwner    string
	GitHubRepo     string
	GitHubBranch   string
	GitHubToken    string
}

func loadConfig() config {
	get := func(key, fallback string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fallback
	}
	return config{
		Namespace:      get("TARGET_NAMESPACE", "myflix"),
		Region:         get("AWS_REGION", "ap-south-1"),
		ClusterName:    get("EKS_CLUSTER_NAME", "myflix-eks"),
		DBInstanceID:   get("RDS_INSTANCE_ID", "myflix-postgres"),
		CacheClusterID: get("REDIS_CLUSTER_ID", "myflix-redis"),
		S3Bucket:       get("S3_BUCKET_NAME", ""),
		DistributionID: get("CLOUDFRONT_DISTRIBUTION_ID", ""),
		ECRRegistry:    get("ECR_REGISTRY", ""),
		GitHubOwner:    get("GITHUB_OWNER", "thirumaalt"),
		GitHubRepo:     get("GITHUB_REPO", "OTT_Project_Golang_EKS"),
		GitHubBranch:   get("GITHUB_BRANCH", "main"),
		// No fallback on purpose — a missing token should fail loudly at
		// startup (see main()'s check below), not silently no-op deploys.
		GitHubToken: get("GITHUB_TOKEN", ""),
	}
}

func main() {
	cfg := loadConfig()

	k8sClients, err := checks.NewK8sClients()
	if err != nil {
		log.Fatalf("failed to initialize Kubernetes client: %v", err)
	}

	awsClients, err := checks.NewAWSClients(context.Background(), cfg.Region)
	if err != nil {
		log.Fatalf("failed to initialize AWS clients: %v", err)
	}

	if cfg.GitHubToken == "" {
		log.Println("WARNING: GITHUB_TOKEN not set — /api/deploy will fail until it's configured")
	}
	gh := deploy.NewGitHubClient(cfg.GitHubToken, cfg.GitHubOwner, cfg.GitHubRepo)

	r := gin.Default()

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// The actual checklist — runs every check fresh on each request rather
	// than caching, since the whole point is "is this true right now,"
	// not "was this true a few minutes ago." A short timeout keeps one
	// slow AWS call from hanging the whole response.
	r.GET("/api/checklist", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()

		var results []checks.Result

		// Kubernetes-side checks
		results = append(results, checks.CheckPods(ctx, k8sClients, cfg.Namespace)...)
		results = append(results, checks.CheckHPA(ctx, k8sClients, cfg.Namespace)...)
		results = append(results, checks.CheckExternalSecrets(ctx, k8sClients, cfg.Namespace)...)
		results = append(results, checks.CheckArgoCD(ctx, k8sClients)...)

		// AWS-side checks
		results = append(results, awsClients.CheckEKS(ctx, cfg.ClusterName))
		results = append(results, awsClients.CheckRDS(ctx, cfg.DBInstanceID))
		results = append(results, awsClients.CheckElastiCache(ctx, cfg.CacheClusterID))
		if cfg.S3Bucket != "" {
			results = append(results, awsClients.CheckS3(ctx, cfg.S3Bucket))
		}
		if cfg.DistributionID != "" {
			results = append(results, awsClients.CheckCloudFront(ctx, cfg.DistributionID))
		}
		results = append(results, awsClients.CheckECRImages(ctx, checks.AllServices)...)

		passCount := 0
		for _, res := range results {
			if res.Status == "pass" {
				passCount++
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"summary": gin.H{
				"total": len(results),
				"pass":  passCount,
				"fail":  len(results) - passCount,
			},
			"results": results,
		})
	})

	// Deployed vs. latest — the actual "am I behind" view, distinct from
	// the checklist's "is everything healthy" view.
	r.GET("/api/services", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()

		type serviceStatus struct {
			Name       string `json:"name"`
			Deployed   string `json:"deployed"`
			Latest     string `json:"latest"`
			Behind     bool   `json:"behind"`
			Deployable bool   `json:"deployable"`
		}

		var out []serviceStatus
		for _, svc := range checks.AllServices {
			deployed, err := checks.GetDeployedTag(ctx, k8sClients, cfg.Namespace, svc)
			if err != nil {
				deployed = "unknown"
			}
			latest, err := awsClients.GetLatestECRTag(ctx, svc)
			if err != nil {
				latest = "unknown"
			}
			_, hasManifest := manifestPaths[svc]

			out = append(out, serviceStatus{
				Name:       svc,
				Deployed:   deployed,
				Latest:     latest,
				Behind:     deployed != "unknown" && latest != "unknown" && deployed != latest,
				Deployable: hasManifest,
			})
		}

		c.JSON(http.StatusOK, gin.H{"services": out})
	})

	// Bumps a service's manifest to a specific tag via a real git commit.
	// This does NOT touch the cluster directly — ArgoCD picks up the
	// change on its own schedule (or you sync manually), same as any
	// other git-driven change in this project. Deliberately not
	// bypassing that gate.
	r.POST("/api/deploy/:service", func(c *gin.Context) {
		service := c.Param("service")
		manifestPath, ok := manifestPaths[service]
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unknown service: " + service})
			return
		}

		var body struct {
			Tag string `json:"tag" binding:"required"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "request body must include \"tag\""})
			return
		}

		if cfg.GitHubToken == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "GITHUB_TOKEN not configured on this deployment"})
			return
		}
		if cfg.ECRRegistry == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ECR_REGISTRY not configured on this deployment"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()

		err := gh.BumpImageTag(ctx, manifestPath, cfg.GitHubBranch, cfg.ECRRegistry, "myflix/"+service, body.Tag)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"status":  "committed",
			"service": service,
			"tag":     body.Tag,
			"note":    "Manifest updated in git — sync via ArgoCD to actually deploy this to the cluster",
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8095"
	}

	log.Printf("devops-dashboard-service listening on :%s", port)
	log.Fatal(r.Run(":" + port))
}
