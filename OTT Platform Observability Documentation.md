# OTT Platform Observability Documentation

## 1. Overview

This project implements a complete observability stack for monitoring microservices, containers, infrastructure, and application performance.

### Components

| Component      | Purpose                          |
| -------------- | -------------------------------- |
| Prometheus     | Metrics Collection               |
| Grafana        | Visualization & Dashboards       |
| Node Exporter  | Host Metrics                     |
| cAdvisor       | Container Metrics                |
| Loki           | Log Storage                      |
| Promtail       | Log Collection                   |
| Tempo          | Distributed Tracing Backend      |
| OpenTelemetry  | Trace Instrumentation (v1.44.0)  |
| Docker Compose | Deployment                       |

---

# 2. Architecture

```text
Applications
     |
     |── /metrics ──────────────► Prometheus ──► Grafana
     |
     |── OTLP gRPC (traces) ────► Tempo ────────► Grafana (Drilldown)
     |
     └── stdout logs ───────────► Promtail ──────► Loki ──► Grafana Logs

Docker Containers
     └── cAdvisor ──────────────► Prometheus

Host
     ├── Node Exporter ─────────► Prometheus
     └── cAdvisor ──────────────► Prometheus
```

---

# 3. Monitored Services

### Application Services

* api-gateway
* auth-service
* user-service
* analytics-service
* recommendation-service
* payment-service
* metadata-service
* media-library-service
* subscription-service
* watchhistory-service
* transcoding-service

### Infrastructure Services

* postgres
* redis
* nginx-exporter

### Observability Services

* prometheus
* grafana
* loki
* promtail
* tempo
* node-exporter
* cadvisor

---

# 4. Metrics Collection

## Prometheus

Prometheus scrapes metrics from:

```text
api-gateway
auth-service
user-service
analytics-service
recommendation-service
payment-service
metadata-service
media-library-service
subscription-service
watchhistory-service
transcoding-service
node-exporter
cadvisor
```

### Endpoint

```text
/metrics
```

---

# 5. Grafana Dashboards

## Service Health Panel

Query:

```promql
max by(job) (up)
```

Purpose:

* Shows UP/DOWN status
* Red = Down
* Green = Up

---

## Service Uptime

Query:

```promql
process_start_time_seconds
```

Purpose:

* Service running duration

---

## Host CPU Usage

Query:

```promql
100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100
```

---

## Host Memory Usage

Query:

```promql
100 *
(
1 -
(
node_memory_MemAvailable_bytes
/
node_memory_MemTotal_bytes
)
)
```

---

## Container CPU Usage

Query:

```promql
rate(container_cpu_usage_seconds_total[5m])
```

---

## Container Memory Usage

Query:

```promql
container_memory_usage_bytes
```

Unit:

```text
bytes (SI)
```

Displayed as:

```text
MB / GB
```

---

## Container Restarts

Query:

```promql
container_start_time_seconds
```

---

## Container Disk Usage

Query:

```promql
container_fs_usage_bytes
```

---

# 6. Application Metrics

## API Requests/sec

Query:

```promql
sum(rate(http_requests_total[5m]))
```

Purpose:

* Total traffic

---

## API Errors/sec

Query:

```promql
sum(rate(http_requests_total{status=~"4..|5.."}[5m]))
```

Purpose:

* Detect failures

---

## HTTP Status Codes

Query:

```promql
sum by(status)
(
rate(http_requests_total[5m])
)
```

Purpose:

* 200
* 400
* 404
* 500

distribution

---

## API Top Endpoints

Query:

```promql
topk(
10,
sum by(path)
(
rate(http_requests_total[5m])
)
)
```

Purpose:

* Most accessed APIs

---

## Average API Latency

Query:

```promql
rate(http_request_duration_seconds_sum[5m])
/
rate(http_request_duration_seconds_count[5m])
```

---

## P95 Latency

Query:

```promql
histogram_quantile(
0.95,
sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
)
```

---

# 7. Distributed Tracing — Grafana Tempo + OpenTelemetry

## How It Works

All Go services are instrumented with OpenTelemetry v1.44.0. Traces are exported via OTLP gRPC to Grafana Tempo and visualised in Grafana's Traces Drilldown.

```text
Go Service
    |
    | OTLP gRPC (passthrough:///tempo:4317)
    ↓
Grafana Tempo :4317 / :3200
    |
    ↓
Grafana Drilldown → Traces → Span Waterfall
                           → Click LOG icon → Loki correlation
```

## Endpoint Configuration

```text
OTEL_EXPORTER_OTLP_ENDPOINT=tempo:4317
```

Set in `x-common-env` in `docker-compose.yml`. Falls back to `tempo:4317` if not set.

## Traced Business Flows

```text
LOGIN FLOW
  api-gateway → auth-service → user-service

DISCOVERY FLOW
  api-gateway → metadata-service → recommendation-service
                                 → watchhistory-service

SUBSCRIPTION FLOW
  api-gateway → payment-service → subscription-service
```

## Trace → Log Correlation

Clicking the LOG icon on any span in Grafana automatically jumps to Loki logs for that service at that exact timestamp. Configured via `tracesToLogsV2` in Grafana datasource provisioning.

---

# 8. Logging Stack

## Loki

Purpose:

* Centralized log storage

Port:

```text
3100
```

---

## Promtail

Purpose:

* Collect Docker logs
* Push logs to Loki

---

## Example Log Queries

### All Logs

```logql
{job="docker"}
```

### Errors

```logql
{job="docker"} |= "ERROR"
```

### HTTP 400

```logql
{job="docker"} |= "400"
```

### HTTP 500

```logql
{job="docker"} |= "500"
```

### API Gateway Requests

```logql
{job="docker"} |= "Proxying"
```

---

# 9. Current Observability Coverage

| Area                 | Status |
| -------------------- | ------ |
| Service Health       | ✅      |
| Host CPU             | ✅      |
| Host Memory          | ✅      |
| Container CPU        | ✅      |
| Container Memory     | ✅      |
| Container Disk       | ✅      |
| Service Uptime       | ✅      |
| Request Rate         | ✅      |
| Error Rate           | ✅      |
| HTTP Status          | ✅      |
| Latency              | ✅      |
| Top Endpoints        | ✅      |
| Centralized Logs     | ✅      |
| Docker Logs          | ✅      |
| Distributed Tracing  | ✅      |
| Trace→Log Correlation| ✅      |
| Alerting             | ✅      |

---

# Current Maturity Level

```text
Monitoring            ✅
Infrastructure        ✅
Container Metrics     ✅
Application Metrics   ✅
Centralized Logs      ✅
Alerting              ✅
Distributed Tracing   ✅
Trace-Log Correlation ✅
```

This is a production-grade observability setup implementing the full three-pillar strategy (Metrics + Logs + Traces) with cross-pillar correlation, suitable for a senior DevOps / platform engineering portfolio.
