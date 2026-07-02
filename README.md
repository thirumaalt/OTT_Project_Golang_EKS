# MyFlix OTT Platform

A production-grade OTT streaming backend built with Go microservices, deployed on Kubernetes, with a complete three-pillar observability stack.

![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=flat&logo=go)
![Kubernetes](https://img.shields.io/badge/Kubernetes-v1.34-326CE5?style=flat&logo=kubernetes)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-v1.44-000000?style=flat&logo=opentelemetry)
![Grafana](https://img.shields.io/badge/Grafana-Tempo%20%7C%20Loki%20%7C%20Prometheus-F46800?style=flat&logo=grafana)
![Docker](https://img.shields.io/badge/Docker-Compose%20%2B%20K8s-2496ED?style=flat&logo=docker)

---

## What is this?

MyFlix is a Netflix-style OTT platform backend — 12 Go microservices behind an API gateway, with full observability (metrics, logs, traces, alerting) and Kubernetes deployment.

**The stack:**
- **12 Go services** (Gin + GORM) — auth, user, metadata, media streaming, payment, subscription, and more
- **Kubernetes** — 27 pods across 3 nodes, nginx Ingress, PersistentVolumes
- **Grafana Tempo** — distributed tracing with OpenTelemetry, end-to-end trace-to-log correlation
- **Prometheus + Grafana** — metrics, dashboards, 8 alert rules
- **Loki + Promtail** — centralised log aggregation
- **Docker Compose** — for local development

---

## Architecture

```
Browser
  └── http://localhost
        └── nginx Ingress
              └── frontend-ui (nginx)
                    ├── /api/* ──► api-gateway :8094
                    │                   ├── auth-service       :8083
                    │                   ├── user-service       :8085
                    │                   ├── metadata-service   :8088
                    │                   ├── media-library      :8001
                    │                   ├── payment-service    :8091
                    │                   ├── subscription-svc   :8093
                    │                   ├── analytics-service  :8086
                    │                   ├── recommendation-svc :8087
                    │                   ├── interaction-svc    :8089
                    │                   └── watchhistory-svc   :8090
                    │                             │
                    │                        PostgreSQL + Redis
                    └── /admin ──► admin-dashboard :5174

Observability (all services):
  /metrics ──► Prometheus ──► Grafana
  OTLP gRPC ──► Grafana Tempo ──► Grafana Drilldown
  stdout ──► Promtail ──► Loki ──► Grafana
  Alerts ──► Alertmanager
  K8s state ──► kube-state-metrics ──► Prometheus
```

---

## Observability — Three Pillars

| Pillar | Stack | What you get |
|---|---|---|
| **Metrics** | Prometheus + Grafana | Request rate, error rate, p99 latency, container CPU/memory, K8s pod status |
| **Logs** | Loki + Promtail | Centralised logs from all pods, filterable by service/container |
| **Traces** | Grafana Tempo + OpenTelemetry v1.44.0 | Distributed traces across service hops, DB spans, HTTP client spans |
| **Alerting** | Alertmanager | 8 alert rules — ServiceDown, HighErrorRate, HighLatency, HighMemory |

### Trace → Log Correlation
Click any span in Grafana Traces Drilldown → LOG icon → jumps directly to Loki logs for that service at that exact timestamp.

### Distributed Trace Flows
```
Login:        api-gateway → auth-service → user-service (+ DB spans)
Discovery:    api-gateway → metadata-service → recommendation + watchhistory
Subscription: api-gateway → payment-service → subscription-service (+ DB spans)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Go 1.25 |
| HTTP Framework | Gin |
| ORM | GORM |
| Database | PostgreSQL 15 |
| Cache | Redis 7 |
| Tracing | OpenTelemetry v1.44.0 + Grafana Tempo |
| Metrics | Prometheus + Grafana |
| Logging | Loki + Promtail |
| Alerting | Alertmanager |
| Container | Docker + Docker Compose |
| Orchestration | Kubernetes (kind) |
| Ingress | nginx-ingress-controller |
| CI Images | Docker Hub (`thiru98/*`) |

---

## Project Structure

```
OTT_Project_Golang/
├── api-gateway/              # JWT auth, reverse proxy, otelhttp tracing
├── auth-service/             # Register/login, bcrypt, JWT HS512
├── user-service/             # Profiles, watchlist, watch history
├── metadata-service/         # TMDB proxy, media CRUD, discover endpoint
├── media-library-service/    # File streaming, HTTP Range/206, HLS
├── payment-service/          # Razorpay order management
├── subscription-service/     # Subscription plan management
├── recommendation-service/   # Per-user recommendations
├── watchhistory-service/     # Watch events
├── analytics-service/        # Action logging + stats
├── interaction-service/      # Likes and ratings
├── transcoding-service/      # Python video transcoding pipeline
├── frontend-ui/              # React + Vite frontend
├── admin-dashboard/          # React admin panel
├── observability/            # Prometheus, Loki, Tempo, Alertmanager configs
│   └── grafana/
│       └── provisioning/     # Auto-provisioned datasources + dashboards
├── k8s/                      # Kubernetes manifests
│   ├── namespace.yaml
│   ├── ingress.yaml
│   ├── secrets/
│   ├── configmaps/
│   ├── infrastructure/       # postgres, redis, tempo
│   ├── services/             # all 13 app services
│   └── observability/        # prometheus, grafana, loki, promtail, etc.
└── docs/
    ├── observability.md      # Observability stack documentation
    ├── kubernetes.md         # Kubernetes migration documentation
    ├── observability_poster.html
    └── kubernetes_architecture.html
```

---

## Quick Start — Docker Compose

```bash
git clone https://github.com/thirumaalt/OTT_Project_Golang.git
cd OTT_Project_Golang

# Start everything
docker compose up -d

# Access
# Frontend:    http://localhost:5173
# API Gateway: http://localhost:8094
# Grafana:     http://localhost:3001  (admin/admin)
# Prometheus:  http://localhost:9090
# Alertmanager:http://localhost:9093
```

---

## Kubernetes Deployment

### Prerequisites
- Docker Desktop with Kubernetes enabled (kind cluster)
- `kubectl` v1.28+

### Deploy

```powershell
# Install ingress controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# Deploy everything
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/infrastructure/
kubectl apply -f k8s/services/
kubectl apply -f k8s/observability/
kubectl apply -f k8s/ingress.yaml

# Verify (all 27 pods should be 1/1 Running)
kubectl get pods -n myflix
```

### Access

```powershell
# Frontend
# http://localhost

# Observability (port-forward)
kubectl port-forward -n myflix svc/grafana 3000:3000
kubectl port-forward -n myflix svc/prometheus 9090:9090
```

---

## Service Ports

| Service | Port | Health |
|---|---|---|
| api-gateway | 8094 | `/health` |
| auth-service | 8083 | `/actuator/health` |
| user-service | 8085 | `/actuator/health` |
| analytics-service | 8086 | `/actuator/health` |
| recommendation-service | 8087 | `/actuator/health` |
| metadata-service | 8088 | `/actuator/health` |
| interaction-service | 8089 | `/actuator/health` |
| watchhistory-service | 8090 | `/actuator/health` |
| payment-service | 8091 | `/actuator/health` |
| subscription-service | 8093 | `/actuator/health` |
| media-library-service | 8001 | `/health` |

---

## API Reference

### Auth
```
POST /api/auth/register    — create account
POST /api/auth/login       — get JWT token
```

### User (Bearer token required)
```
POST   /api/user                         — create user
GET    /api/user/:id                     — get user
POST   /api/user/profiles                — add profile
GET    /api/user/profiles?userId=        — list profiles
DELETE /api/user/profiles/:id            — delete profile
POST   /api/user/history                 — record watch event
GET    /api/user/history?profileId=      — get watch history
POST   /api/user/watchlist               — add to watchlist
DELETE /api/user/watchlist               — remove from watchlist
GET    /api/user/watchlist?profileId=    — get watchlist
GET    /api/user/trending                — trending content
```

### Metadata
```
GET  /api/metadata/movies               — list movies
GET  /api/metadata/discover?userId=     — personalised discover
GET  /api/metadata/title/:name          — metadata by title
```

### Payment
```
POST /api/payment/create-order          — create Razorpay order
POST /api/payment/capture-payment       — capture + trigger subscription upgrade
GET  /api/payment/status/:orderId       — order status
```

### Subscription
```
GET  /api/subscription/user/:userId     — get subscription
POST /api/subscription/upgrade          — upgrade plan
```

---

## OpenTelemetry Implementation

Every Go service contains:

```
service/
└── telemetry/
    ├── tracer.go   — InitTracer(), OTLP gRPC exporter to Tempo
    └── gorm.go     — GORM plugin, hooks all DB callbacks into child spans
```

Endpoint configured via env var:
```
OTEL_EXPORTER_OTLP_ENDPOINT=tempo:4317
```

---

## Known Limitations

| Issue | Detail |
|---|---|
| Media files | `D:/media` volume not mountable in kind — media streaming works in Docker Compose only |
| emptyDir storage | Grafana/Loki/Tempo lose data on pod restart — add PVCs for production |
| No resource limits | CPU/memory limits not set on pods |
| Secrets in YAML | Use Sealed Secrets or External Secrets Operator in production |

---

## Roadmap

- [ ] Grafana Pyroscope — continuous Go profiling
- [ ] Grafana Faro — frontend observability (JS errors, page load)
- [ ] Grafana k6 — load testing with live dashboard
- [ ] HorizontalPodAutoscaler for api-gateway
- [ ] Resource limits on all pods
- [ ] Helm chart
- [ ] Python OpenTelemetry for transcoding-service

---

## Documentation

| Doc | Description |
|---|---|
| [`docs/observability.md`](docs/observability.md) | Full observability stack docs (v2.0) |
| [`docs/kubernetes.md`](docs/kubernetes.md) | Kubernetes migration docs |
| [`docs/kubernetes_architecture.html`](docs/kubernetes_architecture.html) | Architecture diagram |
| [`docs/observability_poster.html`](docs/observability_poster.html) | Observability stack poster |

---

*Built with Go · Kubernetes · Grafana Stack · OpenTelemetry*
