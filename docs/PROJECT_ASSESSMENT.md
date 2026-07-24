# MyFlix OTT Platform — Project & DevOps Assessment

> **Date:** June 2026 · **Scope:** full repository review — application code, Docker, Kubernetes, observability, security, and delivery practices.

---

## 1. Executive Summary

MyFlix is a Netflix-style OTT streaming platform: **12 Go microservices** (Gin + GORM) behind an API gateway, a React frontend, an admin dashboard, PostgreSQL/Redis infrastructure, and a **genuinely complete three-pillar observability stack** (Prometheus metrics, Loki logs, Tempo traces, Alertmanager, and now Grafana Faro for browser RUM) — all running as ~27 pods in a kind cluster.

**Overall verdict:** This is a strong learning/portfolio project whose **observability and Kubernetes layers are ahead of its application code and delivery pipeline**. The infra work (probes, resource limits, HPAs, distributed tracing with trace→log correlation, frontend RUM) is at a level many real companies don't reach. The biggest gaps are: **zero automated tests, no CI/CD pipeline, several known correctness/security bugs in service code, and `:v1` image tags everywhere**.

| Area | Maturity (1–5) | One-line summary |
|---|---|---|
| Architecture | ★★★☆☆ | Clean service split, but some boundaries are blurry (two watch-history implementations, shared `users` table) |
| Application code | ★★☆☆☆ | Works end-to-end, but known critical bugs and unscoped `/all` endpoints |
| Containerization | ★★★★☆ | Multi-stage builds to `scratch` — excellent; missing dependency-layer caching |
| Kubernetes | ★★★★☆ | Probes, limits, HPAs, secrets-by-ref, Ingress — solid; `:v1` tags and single replicas hold it back |
| Observability | ★★★★★ | All three pillars + alerting + RUM; the standout of the project |
| CI/CD | ★☆☆☆☆ | None — builds and deploys are fully manual |
| Testing | ★☆☆☆☆ | Zero test files in the repository |
| Security | ★★☆☆☆ | JWT + bcrypt + K8s Secrets are right; data-scoping bugs and placeholder secret undermine it |

---

## 2. Project Overview

### 2.1 Service Map

| Service | Port | Responsibility | Notes |
|---|---|---|---|
| api-gateway | 8094 | JWT validation, reverse proxy, metrics, tracing | Single entry point for `/api/*` |
| auth-service | 8083 | Register/login, bcrypt, JWT HS512 | Shares `users` table with user-service |
| user-service | 8085 | Profiles, watchlist, watch history | Profile-scoped history (file-path keyed) |
| metadata-service | 8088 | Media CRUD, TMDB proxy, search, bulk upsert | |
| media-library-service | 8001 | File streaming, HTTP Range/206, HLS, upload | Upload handler added, pending deploy |
| payment-service | 8091 | Order create/capture | Stub — no real payment provider |
| subscription-service | 8093 | Plan upsert per user | |
| recommendation-service | 8087 | Per-user content store | No algorithm yet |
| watchhistory-service | 8090 | user+contentId watch events | **Overlaps with user-service history** |
| analytics-service | 8086 | Action logging, aggregate stats | |
| interaction-service | 8089 | Likes/interactions | Missing from docker-compose → 502s locally |
| transcoding-service | 8092 | Transcoding | |

**Frontends:** `frontend-ui` (React + Vite + hls.js + Faro RUM), `admin-dashboard` (React, :5174).
**Infrastructure:** PostgreSQL, Redis (deployed but currently unused), nginx Ingress.

### 2.2 Request Flow

```
Browser ── nginx Ingress (:80)
   ├── /              → frontend (nginx-served React build)
   ├── /api/*         → api-gateway :8094 → 10 backend services → PostgreSQL
   └── /faro/collect  → Alloy :12347 → Loki (logs) + Tempo (traces)
```

### 2.3 Observability Architecture (the project's strength)

| Pillar | Stack | Status |
|---|---|---|
| Metrics | Prometheus + Grafana + node-exporter + cAdvisor + kube-state-metrics | ✅ Running, 8 alert rules via Alertmanager |
| Logs | Loki + Promtail (DaemonSet) | ✅ All pod logs flowing |
| Traces | Tempo (OTLP gRPC :4317) + OpenTelemetry SDK in every Go service | ✅ Trace→log correlation working in Grafana |
| Profiling | Pyroscope | ✅ Deployed |
| Frontend RUM | Grafana Faro → Alloy → Loki/Tempo | 🔄 In progress (uncommitted work) |

---

## 3. What's Done Well

1. **Three-pillar observability with correlation.** Most tutorials stop at Prometheus. This project has metrics, centralized logs, distributed traces, alerting, continuous profiling, and is adding browser RUM — with trace-to-log jumping working in Grafana. This is the portfolio centerpiece.
2. **Production-shaped Kubernetes manifests.** Deployments have readiness *and* liveness probes, resource requests/limits, env from ConfigMaps, secrets via `secretKeyRef`, HPAs for 10 services, and a clean namespace. This is the right shape.
3. **Minimal, secure container images.** Multi-stage builds with `CGO_ENABLED=0` to a `scratch` final stage produce tiny images with near-zero attack surface.
4. **Real microservice patterns.** JWT auth at the gateway, reverse proxying, per-service databases-via-GORM, OTEL context propagation across service hops — the architecture exercises genuine distributed-systems concerns.
5. **Documentation habit.** README with architecture diagrams, dedicated K8s and observability docs, exported diagrams. Rare and valuable.

---

## 4. Application-Level Findings

### 4.1 Critical Bugs (confirmed by code review — fix before any "production" claim)

| # | Location | Bug | Impact |
|---|---|---|---|
| 1 | `payment-service/main.go` (~158) | `randomSuffix()` always returns `"abcdefgh"` | Every order gets the same ID; 2nd order fails on PK collision |
| 2 | `payment-service/main.go` (~105) | Goroutine uses `c.Request.Context()` (cancelled on handler return) | Subscription notification silently never fires |
| 3 | `api-gateway/main.go` (~69) | Routes to `interaction-service:8089`, absent from docker-compose | Every interaction request → 502 (local) |
| 4 | `analytics-service/main.go` (~93) | Tracer named `"api-gateway"` | All analytics spans misattributed in tracing UI |
| 5 | `user-service/handler/user.go` (~114) | `DeleteProfile` ignores `:id` parse error | Bad input deletes record id=0 |
| 6 | `docker-compose.yml` (~207) | nginx-exporter targets `frontend-ui`, service is `frontend` | Exporter DNS failure |

### 4.2 Security Issues

| # | Location | Issue |
|---|---|---|
| 1 | `watchhistory-service` `GET /all` | Returns **all users'** watch history — no user scoping |
| 2 | `analytics-service` `GET /all` | Returns **all users'** analytics — no user scoping |
| 3 | `metadata-service` discover handler | Proxies `/api/watch-history/all` into its response — leaks all users' history to any authenticated user |
| 4 | `k8s/secrets/app-secret.yaml` | Placeholder JWT secret (`changeme_...`) **committed to git** — fine for kind, must never reach a real cluster; rotate and move to External Secrets / SOPS before EKS |
| 5 | `api-gateway` `ALLOWED_ORIGINS: "*"` | Wildcard CORS on an authenticated API |
| 6 | `api-gateway/proxy/proxy.go` (~78) | Proxy `http.Client` has no timeout — slow upstream can exhaust gateway connections |

### 4.3 Design Debt

- **Two incompatible watch-history implementations** (user-service: profile-scoped, file-path keyed, with progress vs watchhistory-service: user-scoped, contentId keyed). Pick one owner and delete the other.
- **`users` table co-owned** — both auth-service and user-service `AutoMigrate` it. One service should own the schema.
- **Redis deployed but unused** — either implement caching (session cache, metadata cache are natural fits) or remove it.
- **Hardcoded values**: `D:/media` path in compose (breaks Linux/CI), `jaeger:4317` in the telemetry package (not env-configurable), Faro URL `http://localhost/faro/collect` baked into the frontend bundle.
- **Payment service is a stub** — fine, but label it as such in the README to keep the "production-grade" claim honest.

---

## 5. DevOps Assessment

### 5.1 Containerization — Good, two improvements

✅ Multi-stage, `scratch` final image, stripped binaries (`-ldflags="-s -w"`).

**Improvements:**
1. **Layer caching:** `COPY . .` before `go build` invalidates the Go module cache on every source change. Standard fix:
   ```dockerfile
   COPY go.mod go.sum ./
   RUN go mod download
   COPY . .
   RUN CGO_ENABLED=0 go build -o app .
   ```
2. **CA certificates:** `scratch` has no root CA bundle — any service making outbound HTTPS calls (e.g., metadata-service → TMDB) will fail TLS verification. Use `gcr.io/distroless/static` or copy `/etc/ssl/certs` from the builder.

### 5.2 Kubernetes — Solid foundation, five gaps

✅ Probes, resource limits, HPAs (10 services), ConfigMaps/Secrets, nginx Ingress, namespace isolation.

| Gap | Why it matters | Fix |
|---|---|---|
| `image: :v1` + implicit `IfNotPresent` | Can't tell what's running; rollbacks impossible; pods on different nodes can run different builds | Tag images with git SHA (`thiru98/api-gateway:a5cbae3`); becomes automatic with CI |
| `replicas: 1` on stateful-less services | Any pod restart = downtime; HPA min should be ≥2 for the gateway | `minReplicas: 2` for api-gateway + frontend |
| No `PodDisruptionBudget`s | Node drain takes out singleton services | Add PDBs once replicas ≥2 |
| PostgreSQL as a single Deployment | DB restart loses in-flight state; emptyDir-style storage risks data loss | StatefulSet + PVC now; managed RDS when on EKS |
| No `NetworkPolicy` | Every pod can talk to every pod (incl. directly to Postgres, bypassing services) | Default-deny + explicit allows per service |
| Default ServiceAccount, no `securityContext` | Containers run with default privileges | `runAsNonRoot`, `readOnlyRootFilesystem`, drop capabilities |

### 5.3 CI/CD — The biggest single gap

There is **no pipeline at all**: no `.github/workflows`, no automated build, test, scan, or deploy. Everything is manual `docker build` + `kubectl apply` (which you run yourself for practice — good for learning, but the pipeline itself is the next skill to practice).

**Recommended minimal pipeline (GitHub Actions):**

```
on push/PR:
  1. go vet + golangci-lint        (per service, matrix build)
  2. go test ./...                  (once tests exist)
  3. docker build (multi-stage)     → tag with git SHA
  4. trivy image scan               (fail on CRITICAL)
  5. push to Docker Hub             (main branch only)
  6. update image tag in manifests  → commit (GitOps) or kubectl set image
```

Later: Argo CD or Flux watching the `k8s/` directory makes the cluster self-syncing — and is the natural pairing with the EKS migration.

### 5.4 Testing — Zero coverage

`**/*_test.go` matches **no files**. For a 12-service platform this is the most important engineering gap.

**Pragmatic order (don't try to test everything):**
1. **Unit tests where the known bugs were** — `randomSuffix()`, ID-parse error paths, JWT middleware. Each confirmed bug becomes a regression test.
2. **Handler tests** with `httptest` + Gin's test context, SQLite-in-memory via GORM for DB-touching handlers.
3. **One integration smoke test** with Testcontainers (Postgres) covering register → login → fetch metadata → record watch event.
4. **k6 load test** (already on the roadmap) doubles as a performance regression suite for the HPA demo.

### 5.5 Configuration & Secrets

- Secrets are correctly referenced via `secretKeyRef` — the pattern is right.
- But the secret **values** live in git. Before EKS: external-secrets-operator + AWS Secrets Manager, or SOPS-encrypted manifests. Rotate the JWT secret at that point.
- Consider one shared `config` Go package reading env with defaults, replacing scattered hardcoded endpoints (`jaeger:4317`, service URLs).

### 5.6 Environments & Releases

- Single environment (kind), single branch (`main`), 17 commits, no tags/releases.
- When EKS arrives: `dev` (kind) / `prod` (EKS) split via Kustomize overlays or the planned Helm chart — Helm values per environment is the cleanest path given the roadmap.
- Start tagging releases (`v0.1.0`) — cheap, and makes the project history legible to reviewers.

---

## 6. Prioritized Roadmap

### Phase 0 — Hygiene (days, do alongside anything else)
- [ ] Fix the 6 confirmed bugs (§4.1) — small diffs, big credibility
- [ ] Scope or remove the `/all` endpoints (§4.2) — security
- [ ] Fix Faro URL → relative `/faro/collect`; finish + commit the Faro/Alloy work
- [ ] Add proxy client timeout in api-gateway
- [ ] Dockerfile layer-caching + CA-cert fix

### Phase 1 — CI (1–2 weekends)
- [ ] GitHub Actions: lint → build → trivy scan → push with git-SHA tags
- [ ] Replace `:v1` in manifests with SHA tags
- [ ] First unit tests (regression tests for fixed bugs)

### Phase 2 — Cluster hardening (1–2 weekends)
- [ ] `minReplicas: 2` for gateway/frontend + PDBs
- [ ] PostgreSQL → StatefulSet + PVC
- [ ] NetworkPolicies (default deny) + pod `securityContext`
- [ ] Pin observability images (alloy, loki, tempo, grafana are all `:v1`)

### Phase 3 — Existing roadmap items (in your planned order)
- [ ] k6 load testing — watch HPA scale under load
- [ ] Helm chart — package everything, with per-env values
- [ ] EKS migration — with external secrets, ECR/Docker Hub SHA tags, and the pending upload/admin-dashboard deploys going live

### Phase 4 — Application depth (ongoing)
- [ ] Consolidate the two watch-history services into one
- [ ] Give `users` table a single owner (auth-service) and expose via API
- [ ] Use Redis (metadata cache or session store) or remove it
- [ ] Real recommendation logic (even simple co-watch counts)
- [ ] Argo CD / Flux for GitOps once Helm exists

---

## 7. Closing Assessment

The project's identity is clear: **an observability-first microservices platform**, and on that axis it is genuinely impressive — Tempo + Loki + Prometheus + Pyroscope + Faro with working correlation is beyond most production systems. The Kubernetes layer is well-shaped, and the container builds are clean.

What separates it from "production-grade" is exactly what Phase 0–2 covers: **fix the known bugs, add a CI pipeline with tests and pinned image tags, and harden the cluster**. None of it is hard relative to what's already built — the observability stack was the harder engineering. With CI/CD and a test baseline in place, this becomes a portfolio project that demonstrates the full DevOps lifecycle, not just the runtime half.
