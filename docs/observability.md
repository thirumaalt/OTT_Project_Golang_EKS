# MyFlix OTT Platform — Observability Stack Documentation

> **Version:** 2.0 | **Date:** June 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Services and Ports](#3-services-and-ports)
4. [Metrics — Prometheus + Grafana](#4-metrics--prometheus--grafana)
5. [Distributed Tracing — Grafana Tempo + OpenTelemetry](#5-distributed-tracing--grafana-tempo--opentelemetry)
6. [Log Aggregation — Loki + Promtail](#6-log-aggregation--loki--promtail)
7. [Alerting — Prometheus Alertmanager](#7-alerting--prometheus-alertmanager)
8. [OpenTelemetry Implementation Details](#8-opentelemetry-implementation-details)
9. [Infrastructure as Code](#9-infrastructure-as-code)
10. [Known Issues and Tech Debt](#10-known-issues-and-tech-debt)
11. [Next Steps](#11-next-steps)

---

## 1. Overview

The MyFlix OTT platform implements a complete three-pillar observability strategy across all microservices. Every service is instrumented to provide full visibility into system health, performance, and behaviour in production.

| Pillar | Technology | Purpose |
|---|---|---|
| **Metrics** | Prometheus + Grafana | Scrape and visualise time-series metrics from all services, containers, and host |
| **Logs** | Loki + Promtail | Aggregate structured logs from all Docker containers into a central queryable store |
| **Traces** | Grafana Tempo + OpenTelemetry v1.44.0 | Distributed end-to-end request tracing across service boundaries with DB and HTTP spans |
| **Alerting** | Alertmanager | Route and deduplicate Prometheus alerts to notification channels |

All three pillars are correlated inside Grafana — clicking a trace span jumps directly to Loki logs for that service at that exact timestamp.

---

## 2. Architecture

### Observability Data Flow

```
  +------------------+    +------------------+    +------------------+
  |  Go Services     |    |  Go Services     |    |  Go Services     |
  |  (Gin + GORM)    |    |  (Gin + GORM)    |    |  (Gin + GORM)    |
  +--------+---------+    +--------+---------+    +--------+---------+
           |                       |                       |
      [/metrics]             [OTLP gRPC]             [stdout logs]
           |                       |                       |
           v                       v                       v
     +----------+            +----------+           +-------------+
     |Prometheus|            |  Tempo   |           |  Promtail   |
     |  :9090   |            |  :4317   |           |   :9080     |
     +----+-----+            +----+-----+           +------+------+
          |                       |                        |
          |                       v                        v
          |                 +-----------+           +----------+
          |                 |Tempo Query|           |   Loki   |
          |                 |  :3200    |           |  :3100   |
          |                 +-----------+           +----+-----+
          |                       |                      |
          +----------------------------------------------+
          |              Grafana :3001                    |
          |   Dashboards | Drilldown | Explore | Alerts   |
          +----------------------------------------------+
          |
          v
    +-------------+        +--------------------------+
    | Alertmanager|------->| Webhook / Slack / Email  |
    |   :9093     |        |      / PagerDuty         |
    +-------------+        +--------------------------+

  cAdvisor :8081  +  Node Exporter :9100  -->  Prometheus
```

### Three-Pillar Correlation

```
Prometheus (Metrics)
    "Is the service broken?"
         ↓
Tempo (Traces)
    "Which request caused it? Which service hop is slow?"
         ↓
Loki (Logs)
    "What exactly happened at that moment?"
```

Click a span in **Grafana Traces Drilldown** → LOG icon → jumps to **Loki** filtered to that container at that exact timestamp.

### Service-to-Service Trace Propagation

Distributed traces use the **W3C TraceContext** standard (`traceparent` header). Three complete business flows are traced end-to-end:

```
LOGIN FLOW
  Frontend --> api-gateway --> auth-service --> user-service
                                   |                |
                              gorm.query        gorm.query

DISCOVERY FLOW
  Frontend --> api-gateway --> metadata-service
                                    |
                       +------------+------------+
                       |                         |
             recommendation-service      watchhistory-service
                   gorm.query                 gorm.query

SUBSCRIPTION FLOW
  Frontend --> api-gateway --> payment-service --> subscription-service
                                    |                     |
                               gorm.create           gorm.create
```

---

## 3. Services and Ports

### Application Services

| Service | Port | Responsibility |
|---|---|---|
| `api-gateway` | `:8094` | JWT auth, reverse proxy, Prometheus metrics, otelhttp tracing |
| `auth-service` | `:8083` | User registration and login, bcrypt passwords, JWT HS512 tokens |
| `user-service` | `:8085` | User profiles, watchlist, watch history (profile-scoped) |
| `metadata-service` | `:8088` | Media CRUD, TMDB proxy, full-text search, discover endpoint |
| `media-library-service` | `:8001` | File streaming, HTTP Range/206, HLS delivery |
| `payment-service` | `:8091` | Order create/capture, notifies subscription-service on capture |
| `subscription-service` | `:8093` | Per-user subscription plan management |
| `recommendation-service` | `:8087` | Per-user content recommendation store |
| `watchhistory-service` | `:8090` | User-scoped content watch events (userId + contentId) |
| `analytics-service` | `:8086` | Action logging and aggregate statistics |
| `interaction-service` | `:8089` | Likes and ratings per content item |
| `transcoding-service` | `:8092` | Python service — video transcoding pipeline (no Go OTEL) |

### Observability Infrastructure

| Component | Port | Access URL |
|---|---|---|
| Prometheus | `:9090` | http://localhost:9090 |
| Grafana | `:3001` | http://localhost:3001 (admin / admin) |
| Grafana Tempo | `:3200` | http://localhost:3200 (internal query API) |
| Tempo OTLP gRPC | `:4317` | Services send traces here |
| Tempo OTLP HTTP | `:4318` | Alternative HTTP ingest |
| Alertmanager | `:9093` | http://localhost:9093 |
| Loki | `:3100` | http://localhost:3100 (internal) |
| Promtail | `:9080` | http://localhost:9080 (internal) |
| cAdvisor | `:8081` | http://localhost:8081 |
| Node Exporter | `:9100` | http://localhost:9100/metrics (internal) |

---

## 4. Metrics — Prometheus + Grafana

### Configuration

| Setting | Value |
|---|---|
| Scrape interval | `15s` |
| Evaluation interval | `30s` |
| Config file | `observability/prometheus.yml` |
| Rules file | `observability/alert_rules.yml` |
| Alertmanager endpoint | `alertmanager:9093` |

### Available Metrics

#### Go Services (`gin_prometheus`)

| Metric | Description |
|---|---|
| `gin_requests_total` | Request count labelled by method, path, status code |
| `gin_request_duration_seconds_bucket` | Latency histogram (p50, p90, p99) |
| `go_goroutines` | Number of active goroutines |
| `go_gc_duration_seconds` | GC pause duration |

#### Container Metrics (cAdvisor)

| Metric | Description |
|---|---|
| `container_memory_usage_bytes` | Current memory consumption per container |
| `container_cpu_usage_seconds_total` | Cumulative CPU time per container |
| `container_network_receive_bytes_total` | Inbound network traffic |
| `container_network_transmit_bytes_total` | Outbound network traffic |

#### Host Metrics (Node Exporter)

| Metric | Description |
|---|---|
| `node_cpu_seconds_total` | Host CPU usage by mode |
| `node_memory_MemAvailable_bytes` | Available system memory |
| `node_filesystem_avail_bytes` | Available disk space |
| `node_network_receive_bytes_total` | Host network I/O |

### Useful PromQL Queries

```promql
# Request rate per service (req/s over 5 minutes)
rate(gin_requests_total[5m])

# p99 latency per service
histogram_quantile(0.99, rate(gin_request_duration_seconds_bucket[5m]))

# 5xx error rate
rate(gin_requests_total{status=~"5.."}[5m]) / rate(gin_requests_total[5m])

# Container memory usage (MiB)
container_memory_usage_bytes{name=~"ott_project_golang.*"} / 1024 / 1024

# Services that are down
up == 0
```

---

## 5. Distributed Tracing — Grafana Tempo + OpenTelemetry

### Why Tempo over Jaeger

Tempo is Grafana's native tracing backend. It completes the observability triad inside a single Grafana UI:

| | Jaeger | Grafana Tempo |
|---|---|---|
| UI | Separate `:16686` | Native in Grafana |
| Trace → Log correlation | Manual | **Built-in** (click span → jump to Loki) |
| Trace → Metrics correlation | No | **Built-in** (TraceQL → metrics) |
| OTLP support | ✅ | ✅ |
| Service graph | No | **Built-in** |

### Setup

| Component | Detail |
|---|---|
| OTLP exporter | `passthrough:///tempo:4317` (gRPC, insecure) |
| Env var | `OTEL_EXPORTER_OTLP_ENDPOINT=tempo:4317` |
| Propagation format | W3C TraceContext (`traceparent` / `tracestate` headers) |
| OTel SDK version | v1.44.0 (all 10 Go services standardised) |
| Telemetry package | `telemetry/tracer.go` in each service |
| DB instrumentation | `telemetry/gorm.go` (inline GORM plugin, zero external deps) |
| HTTP client spans | `otelhttp.NewTransport` wrapping all outbound `http.Client` |
| Config file | `observability/tempo.yml` |
| Grafana datasource | Auto-provisioned via `observability/grafana/provisioning/datasources/datasources.yml` |

### Traced Business Flows

#### Login Flow
```
POST /api/auth/login

api-gateway: HTTP GET  (otelhttp client span)
  auth-service: POST /api/auth/login
    gorm.query    db.sql.table=users    SELECT * FROM users WHERE username = ?
    user-service: GET /api/user/by-username
      gorm.query  db.sql.table=users    SELECT * FROM users WHERE username = ?
```

#### Discovery Flow
```
GET /api/metadata/discover?userId=<id>

api-gateway: HTTP GET
  metadata-service: GET /api/metadata/discover
    recommendation-service: GET /api/recommendations/get
      gorm.query    db.sql.table=recommendations
    watchhistory-service: GET /api/watch-history/user
      gorm.query    db.sql.table=watch_histories
```

#### Subscription Flow
```
POST /api/payment/capture-payment?orderId=<id>

api-gateway: HTTP GET
  payment-service: POST /api/payment/capture-payment
    gorm.query     db.sql.table=payment_orders
    gorm.create    db.sql.table=payment_orders
    subscription-service: POST /api/subscription/upgrade
      gorm.query   db.sql.table=subscriptions
      gorm.create  db.sql.table=subscriptions
```

### GORM Database Spans

| Span Name | GORM Callback | Span Attributes |
|---|---|---|
| `gorm.query` | Query (SELECT) | `db.sql.table`, `db.statement` |
| `gorm.create` | Create (INSERT) | `db.sql.table`, `db.statement` |
| `gorm.update` | Update (UPDATE) | `db.sql.table`, `db.statement` |
| `gorm.delete` | Delete (DELETE) | `db.sql.table`, `db.statement` |
| `gorm.row` | Row / Raw | `db.sql.table`, `db.statement` |

> **Requirement:** All DB calls must pass the request context for span linkage:
> ```go
> db.WithContext(c.Request.Context()).Where("user_id = ?", id).Find(&records)
> ```

### Grafana Traces Drilldown

Access via **Grafana → Drilldown → Traces**

| Feature | How to use |
|---|---|
| Span rate graph | Shows request volume per service over time |
| Service breakdown grid | Click a service tile to filter traces |
| Trace waterfall | Click a trace row to see full span chain |
| LOG icon on span | Jumps to Loki logs for that service at that timestamp |
| Critical path | Highlights the slowest path through the trace |
| High latency filter | Shows only spans above threshold |
| TraceQL | `{resource.service.name="api-gateway"}` — query language for traces |

---

## 6. Log Aggregation — Loki + Promtail

### How It Works

Promtail runs as a Docker container with access to the Docker socket. It scrapes stdout/stderr from every container and ships logs to Loki with labels derived from the container name and stream.

| Component | Detail |
|---|---|
| Promtail config | `observability/promtail-config.yml` |
| Loki config | `observability/loki.yml` |
| Log source | `/var/lib/docker/containers/*/*-json.log` |
| Default labels | `job`, `container_name`, `stream` (stdout/stderr) |
| Query UI | Grafana → Explore → Loki or Grafana → Drilldown → Logs |

### LogQL Query Examples

```logql
# All logs from api-gateway
{container="ott_project_golang-api-gateway-1"}

# Error logs across all services
{job=~".+"} |= "error"

# Slow upstream requests from proxy log
{container="ott_project_golang-api-gateway-1"} |~ "Proxying" | logfmt | duration > 1s

# Login failures
{container="ott_project_golang-auth-service-1"} |= "invalid credentials"

# All 5xx responses
{job=~".+"} |= "status=5"

# Payment service errors
{container="ott_project_golang-payment-service-1"} |= "error" | json
```

---

## 7. Alerting — Prometheus Alertmanager

### Alert Rules

Rules file: `observability/alert_rules.yml`

| Alert Name | Condition | For | Severity | Group |
|---|---|---|---|---|
| `ServiceDown` | `up == 0` | 1m | 🔴 critical | service_health |
| `HighErrorRate` | >5% 5xx rate over 5m | 2m | 🔴 critical | service_health |
| `PostgresDown` | postgres `up == 0` | 1m | 🔴 critical | service_health |
| `HighLatency` | p99 latency > 2s | 2m | 🟡 warning | service_health |
| `HighMemoryUsage` | container > 500 MiB | 5m | 🟡 warning | service_health |
| `HighCPUUsage` | container CPU > 80% | 5m | 🟡 warning | service_health |
| `GatewayHighRequestRate` | api-gateway > 100 req/s | 2m | 🟡 warning | api_gateway |
| `GatewayNoTraffic` | api-gateway 0 req/s | 10m | 🟡 warning | api_gateway |

### Alert Routing

| Severity | group_wait | repeat_interval | Receiver |
|---|---|---|---|
| critical | 10s | 30 minutes | `critical` (webhook) |
| warning | 30s | 1 hour | `default` (webhook) |

**Inhibition:** When a `critical` alert fires for a service, all `warning` alerts for the same service are suppressed.

### Configuring Notification Channels

Alertmanager config: `observability/alertmanager.yml`

Replace the placeholder webhook with your channel:

#### Slack
```yaml
receivers:
  - name: 'critical'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#alerts-critical'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        send_resolved: true
```

#### Email
```yaml
global:
  smtp_smarthost: 'smtp.gmail.com:587'
  smtp_from: 'alerts@myflix.com'
  smtp_auth_username: 'alerts@myflix.com'
  smtp_auth_password: 'YOUR_APP_PASSWORD'

receivers:
  - name: 'critical'
    email_configs:
      - to: 'oncall@myflix.com'
        send_resolved: true
```

### Accessing Alert Status

| URL | Purpose |
|---|---|
| http://localhost:9090/alerts | Prometheus alert list |
| http://localhost:9093 | Alertmanager UI |

---

## 8. OpenTelemetry Implementation Details

### Telemetry Package Structure

Every Go service contains a `telemetry/` package with two files:

| File | Responsibility |
|---|---|
| `telemetry/tracer.go` | `InitTracer(serviceName)` — registers OTLP gRPC exporter pointed at Tempo, sets W3C propagator, returns shutdown func |
| `telemetry/gorm.go` | `NewGormPlugin()` — GORM plugin hooking all DB callbacks, creates child spans (zero external deps) |

### InitTracer

```go
shutdown := telemetry.InitTracer("auth-service")
defer shutdown()

// Endpoint:   OTEL_EXPORTER_OTLP_ENDPOINT env var (default: tempo:4317)
// Target:     passthrough:///tempo:4317  (bypasses gRPC DNS resolver for Docker compat)
// Propagator: W3C TraceContext  (traceparent / tracestate)
// Batcher:    sdktrace.WithBatcher (async, buffered)
```

```go
func InitTracer(serviceName string) func() {
    ctx := context.Background()

    endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint == "" {
        endpoint = "tempo:4317"
    }

    exporter, err := otlptracegrpc.New(
        ctx,
        otlptracegrpc.WithEndpoint("passthrough:///"+endpoint),
        otlptracegrpc.WithInsecure(),
    )
    // ...
}
```

### TracingMiddleware

Applied to the Gin router in every service. Extracts incoming trace context from request headers and starts a server span:

```go
func TracingMiddleware() gin.HandlerFunc {
    tracer := otel.Tracer("service-name")
    return func(c *gin.Context) {
        ctx := otel.GetTextMapPropagator().Extract(
            c.Request.Context(),
            propagation.HeaderCarrier(c.Request.Header),
        )
        ctx, span := tracer.Start(ctx, c.Request.Method+" "+c.FullPath())
        defer span.End()
        c.Request = c.Request.WithContext(ctx)
        c.Next()
    }
}
```

### GormPlugin

Hooks GORM callbacks to create DB child spans. Register after `InitTracer`:

```go
// Register plugin
db.Use(telemetry.NewGormPlugin())

// Every DB call must pass the request context
db.WithContext(c.Request.Context()).Where("user_id = ?", id).Find(&records)

// Resulting spans include:
//   db.sql.table = "users"
//   db.statement = "SELECT * FROM users WHERE user_id = ?"
```

### HTTP Client Spans

All outbound HTTP calls use `otelhttp.NewTransport`. Creates client spans and injects `traceparent` automatically:

```go
// api-gateway proxy (package-level, reused across requests)
var proxyClient = &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
    Timeout:   30 * time.Second,
}

// Service-to-service calls
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
resp, err := client.Do(req)  // span created automatically
```

---

## 9. Infrastructure as Code

### Docker Compose Commands

| Command | Effect |
|---|---|
| `docker compose up -d` | Start all services in detached mode |
| `docker compose up --build` | Rebuild images and start |
| `docker compose build --no-cache <svc>` | Force-rebuild a single service |
| `docker compose logs -f <svc>` | Stream logs for a service |
| `docker compose ps` | Show running containers and health |
| `docker compose down` | Stop and remove containers (volumes preserved) |
| `docker compose down -v` | Stop, remove containers **and volumes** (data loss) |

### Observability Config Files

| File | Purpose |
|---|---|
| `observability/prometheus.yml` | Scrape targets, Alertmanager endpoint, rules file path |
| `observability/alert_rules.yml` | All Prometheus alerting rules (8 rules across 2 groups) |
| `observability/alertmanager.yml` | Alert routing, receivers, inhibition rules |
| `observability/loki.yml` | Loki storage and retention configuration |
| `observability/promtail-config.yml` | Promtail Docker log scrape configuration |
| `observability/tempo.yml` | Tempo OTLP receivers, local storage backend, query config |
| `observability/grafana/provisioning/datasources/datasources.yml` | Auto-provisions Prometheus, Loki, Tempo datasources in Grafana |
| `observability/grafana/provisioning/dashboards/dashboards.yml` | Auto-loads dashboard JSON files into Grafana |

---

## 10. Known Issues and Tech Debt

### 🔴 Critical

| # | Issue | Detail |
|---|---|---|
| 1 | **Dual `watch_histories` tables** | `user-service` stores history profile-scoped with progress tracking; `watchhistory-service` stores it user-scoped with `contentId`. Incompatible schemas — data is split across two tables. |
| 2 | **Shared `users` table** | `auth-service` and `user-service` both `AutoMigrate` the users table. Co-ownership is fragile and migrations can conflict. |

### 🟡 Warnings

| # | Issue | Detail |
|---|---|---|
| 3 | **Redis unused** | Redis is deployed and running but no service uses it. Wire up caching or remove it. |
| 4 | **Alertmanager placeholder receiver** | Webhook URL `http://localhost:5001/alerts` is a placeholder. Configure a real channel before production. |
| 5 | **Python transcoding-service uninstrumented** | No OpenTelemetry tracing. Use `opentelemetry-sdk-python` with OTLP exporter to add traces. |
| 6 | **`D:/media` hardcoded in compose** | Windows-specific volume path. Must be made configurable before Linux/CI/Kubernetes deployment. |

### ✅ Resolved

| # | Issue | Resolution |
|---|---|---|
| ~~4~~ | ~~Hardcoded Jaeger endpoint~~ | Replaced with `OTEL_EXPORTER_OTLP_ENDPOINT` env var + `passthrough:///` gRPC target |
| ~~5~~ | ~~OTEL version split (v1.34 vs v1.44)~~ | All 10 Go services standardised to v1.44.0 |
| ~~Jaeger~~ | ~~Separate Jaeger UI~~ | Migrated to Grafana Tempo — traces, logs, metrics all in one Grafana UI |

---

## 11. Next Steps

### Immediate (Before Production)
- [ ] Configure Alertmanager with a real notification channel (Slack recommended)
- [ ] Resolve the dual `watch_histories` table ownership
- [ ] Wire up Redis for session caching or rate limiting

### Short Term
- [ ] Add Python OpenTelemetry instrumentation to `transcoding-service`
- [ ] Add DB connection pool metrics (pgx instrumentation)
- [ ] Create per-service Grafana dashboards (latency, error rate, throughput panels)

### Medium Term — Kubernetes Migration
- [ ] Convert `docker-compose.yml` to Kubernetes Deployments, Services, ConfigMaps
- [ ] Use Kubernetes Secrets for `JWT_SECRET` and database credentials
- [ ] Deploy Prometheus Operator for automated scrape configuration
- [ ] Use OpenTelemetry Operator for standardised OTLP collector sidecar injection
- [ ] Add `HorizontalPodAutoscaler` for `api-gateway` and `metadata-service`
- [ ] Replace `D:/media` volume with Kubernetes PersistentVolumeClaim

---

*MyFlix OTT Platform — Observability Stack Documentation v2.0 — June 2026*
