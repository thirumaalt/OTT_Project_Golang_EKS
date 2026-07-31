# MyFlix — Start Here

Read this first, every time you come back after a gap. It's meant to take 5 minutes, not re-teach you the whole project. For anything deeper, it points you to the other two documents at the bottom.

---

## What this actually is

**MyFlix** is a personal OTT (Netflix-style) streaming platform — 14 microservices, a database, media storage, the works. You're not building it because you need a streaming service; you're building it as a **deep-learning vehicle for production-grade Kubernetes and AWS**. The goal every step of the way has been to understand *why*, not just get it running, so you could rebuild any piece of it yourself from scratch if you had to. (You've actually had to — the whole thing got rebuilt once already after an AWS account got blocked.)

---

## Architecture, at a glance

```
                          Browser
                             |
                       CloudFront (CDN)
                        /          \
                  ALB / Ingress    S3 (HLS media, direct)
                        |
                       frontend-ui  (nginx reverse proxy)
                        /         \
                api-gateway    admin-dashboard
               /     |      \
   8 business    media-library   payment-service
   services      + transcoding   (paused, no keys)
      |                |
  RDS + Redis         S3 bucket
  (databases)      (video + HLS)

  Alongside all of this, running independently:
  - Observability: Prometheus, Grafana, Loki, Tempo, Alloy (log shipper)
  - GitOps: GitHub repo -> ArgoCD -> the cluster
  - devops-dashboard-service: internal health-check + deploy tool (port-forward only)
```

**16 things running total** — the original 14 app services, plus **`devops-dashboard-service`** (a custom internal tool, backend + its own small frontend) built partway through this project to answer "is everything actually okay?" in one screen instead of dozens of manual commands:
- **Front doors:** `frontend-ui` (what users see), `admin-dashboard` (CMS/admin), `api-gateway` (routes everything internally)
- **Business logic (Go):** `auth`, `user`, `metadata`, `recommendation`, `watchhistory`, `interaction`, `subscription`, `analytics`, `payment` — each owns one concern, all talk to the same Postgres database
- **Media pipeline:** `media-library-service` (Go, lists/streams from S3) and `transcoding-service` (Python, ffmpeg — converts uploads into streamable HLS video)
- **Internal tooling:** `devops-dashboard-service` — a real-time checklist (pods, secrets, HPA, GitOps sync, AWS infra, all 14 ECR repos) plus a "deploy a new tag" button. Reachable only via `kubectl port-forward` right now, same as Grafana — neither has real auth in front of it yet.

**Infrastructure underneath:** EKS cluster (`myflix-eks`) → RDS Postgres + ElastiCache Redis (managed databases) → S3 (video storage) → **CloudFront (public entry point, both the app and HLS media)** → all wired together with IAM, Secrets Manager, and a full observability stack (Prometheus/Grafana/Loki/Tempo).

**How changes actually reach the cluster:** you edit YAML in a GitHub repo → ArgoCD notices → you review the diff → you click Sync → it applies. You (almost) never run `kubectl apply` directly anymore. **One habit worth burning in:** any *code* change is really two commits — the new image pushed to ECR, and the manifest's tag bumped to point at it. Skipping the second one fails completely silently (git and ArgoCD both show everything fine, the cluster just quietly keeps running the old code) — this has actually happened more than once in this project.

---

## Current status (as of the last session)

Fully rebuilt on a **second AWS account** (the first got blocked — unrelated to anything technical). 13 of 14 services running. `payment-service` is **intentionally** paused — it just needs real Razorpay API keys you don't have yet, not a bug. The logging pipeline was upgraded from Promtail to **Grafana Alloy** after a genuine, hard-to-diagnose version-incompatibility bug (fully root-caused, not just worked around). **CloudFront CDN is now live** — HTTPS, edge caching on video, and it works from networks that blocked the raw ALB. A custom internal tool, **`devops-dashboard-service`**, now gives you a one-screen health checklist and a deploy button instead of manual commands. Two smaller things are mid-flight and explicitly paused, not broken: getting the dashboard/Grafana reachable through CloudFront (routing fix built, not yet redeployed), and frontend browser telemetry (Faro — configured, not fully wired).

---

## Glossary — the concepts you'll want refreshed most often

**IRSA** (IAM Roles for Service Accounts) — lets a Kubernetes pod act with real AWS permissions (e.g., read/write S3) without ever holding an AWS access key. Only `transcoding-service` and `media-library-service` need this — they're the only two that talk to AWS APIs directly.

**ESO** (External Secrets Operator) — the thing that pulls real secrets (DB passwords, API keys) out of AWS Secrets Manager and turns them into ordinary Kubernetes Secrets automatically. Real values live in exactly one place (Secrets Manager); nothing sensitive is ever in git.

**ArgoCD / GitOps** — `Synced` means the cluster matches git exactly. `OutOfSync` means git and the cluster disagree (fix: sync). `Degraded` refers to app **health**, not sync — right now it's permanently `Degraded` because `payment-service` isn't running, which is expected, not alarming.

**HPA** (Horizontal Pod Autoscaler) — automatically adds more replicas of a service under CPU load, scales back down when idle. Set on all 14 services, conservatively (max 3 replicas each) because of the node-capacity issue below.

**The recurring node-capacity ceiling** — the cheapest AWS instance type available to this account (`t3.small`) can only run **11 pods per node**, no matter how much CPU/memory is actually free — it's a hard networking limit (IP addresses per network interface), not a resource limit. This has caused real, repeated scheduling trouble (Promtail's DaemonSet couldn't fit, then ArgoCD couldn't fit) — solved each time by adding another node, never fully solved at the root.

**Why Alloy replaced Promtail** — Promtail (the old log-shipping tool) went silent, finding zero logs, reproducibly, on two separate clusters. Fully root-caused (not just worked around): a version incompatibility between Promtail's older Kubernetes client library and this cluster's newer API server. Alloy is Grafana's modern replacement, and as a bonus it runs as **1 pod instead of 6** (a `Deployment`, not a `DaemonSet`), which also eases the capacity ceiling above.

**The CDN decision, resolved** — CloudFront can't sit directly in front of just the S3 media bucket with cookie-based auth, because browsers won't let a cookie set on your app's domain apply to CloudFront's separate domain. After weighing options (a unified single distribution, a custom domain, or dropping auth entirely), the choice made was: **one CloudFront distribution in front of everything, with no auth on the media itself** (Origin Access Control only — CloudFront can read the private S3 bucket, but nothing checks who's asking). This means HLS video URLs are currently accessible to anyone who has one, no login required — a deliberate tradeoff for a learning project's test content, not an oversight. Signed cookies and full DRM were both considered and explicitly deferred as separate, bigger projects.

**`devops-dashboard-service`** — a tool built partway through this project specifically because manually running `kubectl`/`aws` commands to check "is everything okay?" got tedious. One checklist screen covers pods, secrets, autoscaling, GitOps sync, and AWS infra status; a Deploy tab lets you bump a service's image tag with a real git commit instead of hand-editing YAML. Reachable only via `kubectl port-forward` — same as Grafana, no public exposure yet.

---

## Where to look for what

- **This document** — orientation after a gap. Read it first, always.
- **`eks-migration-runbook.md`** — the full history. Every bug, every decision, every "why," in the order it happened. Read a specific phase when you need the *reasoning* behind something.
- **`eks-rebuild-playbook.md`** — the exact commands to rebuild any piece from scratch, with every known gotcha already fixed in the instructions. Read this when you need to *do* something, not understand something.
