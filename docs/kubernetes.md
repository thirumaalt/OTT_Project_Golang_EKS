# MyFlix OTT Platform — Kubernetes Migration Documentation

> **Version:** 1.0 | **Date:** June 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Cluster Setup](#3-cluster-setup)
4. [Folder Structure](#4-folder-structure)
5. [Namespace](#5-namespace)
6. [Secrets & ConfigMaps](#6-secrets--configmaps)
7. [Infrastructure Services](#7-infrastructure-services)
8. [Application Services](#8-application-services)
9. [Frontend](#9-frontend)
10. [Observability Stack](#10-observability-stack)
11. [Ingress](#11-ingress)
12. [Deployment Guide](#12-deployment-guide)
13. [Accessing Services](#13-accessing-services)
14. [Known Limitations](#14-known-limitations)
15. [Next Steps](#15-next-steps)

---

## 1. Overview

The MyFlix OTT platform has been fully migrated from Docker Compose to Kubernetes. All 13 application services, 3 infrastructure components, and 8 observability tools run as Kubernetes workloads in a dedicated `myflix` namespace.

### What Changed from Docker Compose

| Docker Compose | Kubernetes |
|---|---|
| `build: ./service` | Pre-built images pushed to Docker Hub (`thiru98/<service>:v1`) |
| `environment:` block | ConfigMap + Secrets |
| `depends_on:` | Readiness probes |
| `volumes: D:/media` | hostPath (local) / PVC (production) |
| `ports:` (host binding) | NodePort / Ingress |
| `docker-compose up` | `kubectl apply -f k8s/` |

---

## 2. Architecture

### Cluster

| Property | Value |
|---|---|
| Cluster type | kind (Kubernetes IN Docker) via Docker Desktop |
| Kubernetes version | v1.34.3 |
| Nodes | 3 (1 control-plane + 2 workers) |
| Container runtime | containerd v2.2.0 |
| Namespace | `myflix` |

### Network Flow

```
Browser
  |
  | http://localhost
  ↓
Ingress (nginx-ingress-controller)
  |
  ↓
frontend (nginx :80)
  |── /api/*  ──────────► api-gateway :8094
  |                              |
  |                    ┌─────────┴──────────┐
  |                    ↓                    ↓
  |              Go Services          Go Services
  |              (auth, user,         (metadata,
  |               payment...)          media...)
  |                    |
  |                    ↓
  |                postgres :5432
  |
  |── /admin ──────────► admin-dashboard :5174

Go Services
  |── OTLP gRPC ────────► tempo :4317
  |── /metrics ──────────► prometheus :9090

promtail (DaemonSet)
  |── /var/log/pods ─────► loki :3100

node-exporter (DaemonSet) ──► prometheus
cadvisor (DaemonSet)       ──► prometheus
kube-state-metrics         ──► prometheus

prometheus ──► alertmanager :9093

All datasources ──► grafana :3000
```

---

## 3. Cluster Setup

### Prerequisites

```powershell
# Docker Desktop with Kubernetes enabled
# kubectl v1.28+
kubectl version --client

# Verify cluster
kubectl cluster-info
kubectl get nodes
```

### Ingress Controller

```powershell
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s
```

---

## 4. Folder Structure

```
k8s/
├── namespace.yaml              ← myflix namespace
├── ingress.yaml                ← nginx ingress rules
│
├── secrets/
│   ├── postgres-secret.yaml    ← DB credentials
│   └── app-secret.yaml         ← JWT secret
│
├── configmaps/
│   └── app-config.yaml         ← shared env vars for all services
│
├── infrastructure/
│   ├── postgres.yaml           ← Deployment + Service + PVC
│   ├── redis.yaml              ← Deployment + Service
│   └── tempo.yaml              ← Deployment + Service + ConfigMap
│
├── services/
│   ├── api-gateway.yaml        ← NodePort :30094
│   ├── auth-service.yaml
│   ├── user-service.yaml
│   ├── analytics-service.yaml
│   ├── recommendation-service.yaml
│   ├── metadata-service.yaml
│   ├── interaction-service.yaml
│   ├── watchhistory-service.yaml
│   ├── payment-service.yaml
│   ├── subscription-service.yaml
│   ├── media-library-service.yaml
│   ├── frontend.yaml           ← ConfigMap (nginx.conf) + Deployment + Service
│   └── admin-dashboard.yaml
│
└── observability/
    ├── prometheus.yaml         ← Deployment + ConfigMap + NodePort :30090
    ├── alertmanager.yaml       ← Deployment + ConfigMap + Service
    ├── grafana.yaml            ← Deployment + ConfigMap + NodePort :30030
    ├── loki.yaml               ← Deployment + ConfigMap + Service
    ├── promtail.yaml           ← DaemonSet + ConfigMap + RBAC
    ├── node-exporter.yaml      ← DaemonSet + Service
    ├── cadvisor.yaml           ← DaemonSet + Service
    └── kube-state-metrics.yaml ← Deployment + ClusterRole + Service
```

---

## 5. Namespace

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: myflix
```

```powershell
kubectl apply -f k8s/namespace.yaml
kubectl get namespace myflix
```

---

## 6. Secrets & ConfigMaps

### Secrets

| Secret | Key | Value |
|---|---|---|
| `postgres-secret` | `username` | `postgres` |
| `postgres-secret` | `password` | `postgres` |
| `app-secret` | `jwt-secret` | JWT signing key |

> ⚠️ **Production:** Replace with Sealed Secrets or External Secrets Operator. Never commit real secrets to git.

### ConfigMap — `app-config`

All Go services receive these environment variables via `envFrom.configMapRef`:

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@postgres:5432/myflix?sslmode=disable` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `tempo:4317` |
| `AUTH_BASE_URL` | `http://auth-service:8083` |
| `USER_BASE_URL` | `http://user-service:8085` |
| `ANALYTICS_BASE_URL` | `http://analytics-service:8086` |
| `RECOMMENDATION_BASE_URL` | `http://recommendation-service:8087` |
| `METADATA_BASE_URL` | `http://metadata-service:8088` |
| `INTERACTION_BASE_URL` | `http://interaction-service:8089` |
| `WATCHHISTORY_BASE_URL` | `http://watchhistory-service:8090` |
| `PAYMENT_BASE_URL` | `http://payment-service:8091` |
| `SUBSCRIPTION_BASE_URL` | `http://subscription-service:8093` |
| `MEDIA_BASE_URL` | `http://media-library-service:8001` |

---

## 7. Infrastructure Services

### Postgres

| Property | Value |
|---|---|
| Image | `postgres:15-alpine` |
| Port | `5432` |
| Storage | PersistentVolumeClaim `postgres-pvc` (2Gi) |
| Credentials | From `postgres-secret` |
| Readiness probe | `pg_isready -U postgres` |

### Redis

| Property | Value |
|---|---|
| Image | `redis:7-alpine` |
| Port | `6379` |
| Storage | None (ephemeral) |

### Tempo

| Property | Value |
|---|---|
| Image | `grafana/tempo:v1` |
| OTLP gRPC | `:4317` |
| OTLP HTTP | `:4318` |
| Query API | `:3200` |
| Storage | `emptyDir` (ephemeral, use object storage in production) |
| Config | `tempo-config` ConfigMap |

---

## 8. Application Services

All Go services follow the same pattern:

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  containers:
    - image: thiru98/<service>:v1
      envFrom:
        - configMapRef:
            name: app-config      # shared env vars
      env:
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secret
              key: jwt-secret
      readinessProbe:
        httpGet:
          path: /actuator/health  # or /health
          port: <port>
```

### Service Inventory

| Service | Image | Port | Health Endpoint |
|---|---|---|---|
| `api-gateway` | `thiru98/api-gateway` | `8094` | `/health` |
| `auth-service` | `thiru98/auth-service` | `8083` | `/actuator/health` |
| `user-service` | `thiru98/user-service` | `8085` | `/actuator/health` |
| `analytics-service` | `thiru98/analytics-service` | `8086` | `/actuator/health` |
| `recommendation-service` | `thiru98/recommendation-service` | `8087` | `/actuator/health` |
| `metadata-service` | `thiru98/metadata-service` | `8088` | `/actuator/health` |
| `interaction-service` | `thiru98/interaction-service` | `8089` | `/actuator/health` |
| `watchhistory-service` | `thiru98/watchhistory-service` | `8090` | `/actuator/health` |
| `payment-service` | `thiru98/payment-service` | `8091` | `/actuator/health` |
| `subscription-service` | `thiru98/subscription-service` | `8093` | `/actuator/health` |
| `media-library-service` | `thiru98/media-library-service` | `8001` | `/health` |

### Special Environment Variables

| Service | Extra Env Var |
|---|---|
| `auth-service` | `USER_SERVICE_URL=http://user-service:8085` |
| `metadata-service` | `TMDB_API_KEY=<key>` |
| `payment-service` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| `media-library-service` | `MEDIA_DATA_DIR=/media` |

---

## 9. Frontend

### frontend-ui

| Property | Value |
|---|---|
| Image | `thiru98/frontend-ui:v1` |
| Port | `80` |
| nginx config | Injected via `frontend-nginx-config` ConfigMap |
| Health probe | `GET /` on port 80 |

The nginx config proxies:
- `/api/*` → `http://api-gateway:8094`
- `/media/*` → `http://api-gateway:8094`
- `/admin` → `http://admin-dashboard:5174`
- Everything else → SPA `index.html`

> **Why ConfigMap?** The Docker Compose version injected `nginx.conf` via a bind mount. In K8s, ConfigMap + `subPath` replaces bind mounts cleanly.

### admin-dashboard

| Property | Value |
|---|---|
| Image | `thiru98/admin-dashboard:v1` |
| Port | `5174` |
| nginx config | Baked into image |

---

## 10. Observability Stack

### Prometheus

| Property | Value |
|---|---|
| Image | `prom/prometheus:v1` |
| Port | `9090` (NodePort `30090`) |
| Config | Inline in `prometheus-config` ConfigMap |
| Scrape interval | `15s` |
| Targets | All 11 Go services + node-exporter + cadvisor + kube-state-metrics |

### Alertmanager

| Property | Value |
|---|---|
| Image | `prom/alertmanager:v1` |
| Port | `9093` |
| Config | `alertmanager-config` ConfigMap |
| Alert rules | 4 rules (ServiceDown, HighErrorRate, HighLatency, HighMemoryUsage) |

### Grafana

| Property | Value |
|---|---|
| Image | `grafana/grafana:v1` |
| Port | `3000` (NodePort `30030`) |
| Datasources | Auto-provisioned: Prometheus + Loki + Tempo |
| Credentials | `admin` / `admin` |

### Loki

| Property | Value |
|---|---|
| Image | `grafana/loki:v1` |
| Port | `3100` |
| Schema | `v13` with `tsdb` store |
| Storage | `emptyDir` (ephemeral) |

### Promtail

| Property | Value |
|---|---|
| Image | `grafana/promtail:v1` |
| Type | **DaemonSet** (runs on every node) |
| Log source | `/var/log/pods/**/*.log` (containerd format) |
| RBAC | ClusterRole to list/watch pods |
| Labels | `pod`, `namespace`, `app`, `container` |

> **K8s vs Docker:** In Docker Compose, Promtail scraped `/var/lib/docker/containers`. In K8s with containerd, logs are at `/var/log/pods` — the Promtail config was updated accordingly.

### Node Exporter

| Property | Value |
|---|---|
| Image | `prom/node-exporter:v1` |
| Type | **DaemonSet** (one per node) |
| Port | `9100` |
| Host mounts | `/proc`, `/sys`, `/` (read-only) |

### cAdvisor

| Property | Value |
|---|---|
| Image | `gcr.io/cadvisor/cadvisor:v1` |
| Type | **DaemonSet** (one per node) |
| Port | `8080` |
| Security | `privileged: true` required for container metrics |

### kube-state-metrics

| Property | Value |
|---|---|
| Image | `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.10.0` |
| Port | `8080` |
| RBAC | ClusterRole to list/watch K8s resources |
| Metrics | Pod status, deployment replicas, node conditions, PVC status |

> **K8s-specific:** kube-state-metrics is not in Docker Compose — it's a Kubernetes-native tool that exposes cluster state as Prometheus metrics.

---

## 11. Ingress

```yaml
# k8s/ingress.yaml
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
```

All traffic enters via the nginx ingress controller on port 80. The frontend nginx handles internal routing to api-gateway and admin-dashboard via ClusterDNS.

---

## 12. Deployment Guide

### Full Deploy from Scratch

```powershell
cd F:/Projects/OTT_Project_Golang

# 1. Namespace
kubectl apply -f k8s/namespace.yaml

# 2. Secrets + ConfigMaps
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/configmaps/

# 3. Infrastructure
kubectl apply -f k8s/infrastructure/

# 4. App Services
kubectl apply -f k8s/services/

# 5. Observability
kubectl apply -f k8s/observability/

# 6. Ingress
kubectl apply -f k8s/ingress.yaml

# Verify all pods
kubectl get pods -n myflix
```

### Build & Push All Images

```powershell
$services = @("api-gateway","auth-service","user-service","analytics-service",
              "recommendation-service","watchhistory-service","payment-service",
              "subscription-service","interaction-service","metadata-service",
              "media-library-service","frontend-ui","admin-dashboard")

foreach ($svc in $services) {
    docker build -t thiru98/$svc:v1 ./$svc
    docker push thiru98/$svc:v1
}
```

### Tear Down

```powershell
# Remove everything (preserves PVC data)
kubectl delete namespace myflix

# Remove PVCs too (data loss)
kubectl delete pvc --all -n myflix
kubectl delete namespace myflix
```

---

## 13. Accessing Services

### Via Ingress (primary)

| URL | Service |
|---|---|
| http://localhost | MyFlix Frontend |
| http://localhost/admin | Admin Dashboard |

### Via Port Forward (observability)

```powershell
# Run in separate terminals
kubectl port-forward -n myflix svc/grafana 3000:3000
kubectl port-forward -n myflix svc/prometheus 9090:9090
kubectl port-forward -n myflix svc/alertmanager 9093:9093
```

| URL | Service |
|---|---|
| http://localhost:3000 | Grafana (admin/admin) |
| http://localhost:9090 | Prometheus |
| http://localhost:9093 | Alertmanager |

### Useful kubectl Commands

```powershell
# All pods status
kubectl get pods -n myflix

# Watch pods in real time
kubectl get pods -n myflix -w

# Logs for a service
kubectl logs -n myflix -l app=api-gateway --tail=50

# Describe a pod (events, errors)
kubectl describe pod -n myflix <pod-name>

# Exec into a pod
kubectl exec -it -n myflix <pod-name> -- /bin/sh

# All services and ports
kubectl get svc -n myflix

# PersistentVolumeClaims
kubectl get pvc -n myflix
```

---

## 14. Known Limitations

| # | Issue | Detail |
|---|---|---|
| 1 | **Media files not accessible** | `D:/media` (Windows) can't be mounted into kind nodes. In production use a cloud PVC (AWS EFS, GCS Filestore, Azure Files). |
| 2 | **emptyDir storage** | Grafana, Loki, Tempo use `emptyDir` — data lost on pod restart. Add PVCs for persistence. |
| 3 | **No resource limits** | Pods have no CPU/memory limits set. Add `resources.requests` and `resources.limits` before production. |
| 4 | **No liveness probes** | Only readiness probes configured. Add `livenessProbe` so K8s restarts hung pods. |
| 5 | **Secrets in plain YAML** | Secrets are stored as plaintext in YAML files. Use Sealed Secrets or External Secrets Operator in production. |
| 6 | **No HPA** | No HorizontalPodAutoscaler. api-gateway and metadata-service are good candidates. |
| 7 | **port-forward for observability** | Grafana/Prometheus need `kubectl port-forward` — add them to Ingress for proper access. |

---

## 15. Next Steps

### Immediate Improvements
- [ ] Add `resources.requests` and `resources.limits` to all deployments
- [ ] Add `livenessProbe` to all services
- [ ] Add PVCs for Grafana, Loki, Tempo storage persistence
- [ ] Add Grafana and Prometheus to Ingress routing

### K8s Features
- [ ] `HorizontalPodAutoscaler` for `api-gateway` and `metadata-service`
- [ ] `NetworkPolicy` — restrict pod-to-pod communication
- [ ] `PodDisruptionBudget` — maintain availability during node maintenance
- [ ] Helm chart — package all manifests into a single deployable chart

### Observability
- [ ] Grafana Pyroscope — continuous Go profiling
- [ ] Grafana Faro — frontend observability
- [ ] Grafana k6 — load testing with live dashboard
- [ ] OpenTelemetry Collector as DaemonSet
- [ ] Import kube-state-metrics dashboards into Grafana

### Production Path
- [ ] Replace kind with managed K8s (EKS / GKE / AKS)
- [ ] Replace `D:/media` with cloud PVC
- [ ] Add TLS via cert-manager + Let's Encrypt
- [ ] ArgoCD for GitOps deployment

---

*MyFlix OTT Platform — Kubernetes Documentation v1.0 — June 2026*
