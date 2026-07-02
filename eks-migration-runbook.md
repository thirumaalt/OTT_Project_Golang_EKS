# MyFlix OTT Platform — EKS Migration Runbook

**Account ID:** `025211337216`
**Region:** `ap-south-1`
**Cluster name:** `myflix-eks`
**Status as of this doc:** Phase 3 in progress (RDS/ElastiCache security groups done, instances not yet created)

---

## Architecture decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Database | RDS Postgres (managed) | Production-grade HA/backups vs. running Postgres as a pod |
| Cache | ElastiCache Redis (managed) | Same reasoning as RDS |
| Media storage | S3 | `transcoding-service` was already S3-ready in code; scales beyond node-local disk |
| Observability | Self-hosted in-cluster (Prometheus/Grafana/Loki/Tempo) | Keep existing manifests/logic, avoid AMP/AMG migration cost right now |
| Cluster provisioning | eksctl | Fast, CLI-driven, no Terraform state to manage yet |
| Ingress | AWS Load Balancer Controller → ALB | Native ACM/WAF/Route53 integration (not yet implemented — future phase) |
| Secrets | External Secrets Operator + AWS Secrets Manager | Retires plaintext-YAML secrets flagged in original `kubernetes.md` limitations (not yet implemented — future phase) |
| frontend-ui nginx.conf | ConfigMap mount (not baked into image) | Matches docker-compose's runtime-injection behavior; consistent with ConfigMap pattern used for all backend service configs |
| admin-dashboard nginx.conf | Baked into Dockerfile (already was) | No change needed — already production-correct |

---

## Phase 1 — EKS Cluster

**Why:** Real AWS infrastructure to replace the deleted local `kind` cluster. eksctl provisions VPC + control plane + worker nodes from one declarative config file, so the setup is reproducible (Git-trackable) instead of manual console clicks.

### `cluster.yaml`
```yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: myflix-eks
  region: ap-south-1

vpc:
  cidr: 10.0.0.0/16
  nat:
    gateway: Single      # cost-optimized for now; upgrade to HA later if needed

managedNodeGroups:
  - name: myflix-workers
    instanceType: t3.large
    desiredCapacity: 3
    minSize: 2
    maxSize: 5
    volumeSize: 40
    privateNetworking: true

iam:
  withOIDC: true          # required for IRSA — pods assuming IAM roles (S3, Secrets Manager) without static keys
```

### Commands run
```bash
aws sts get-caller-identity      # confirm CLI auth
eksctl create cluster -f cluster.yaml
```

### Result — verified
```
kubectl get nodes
NAME                                          STATUS   ROLES    AGE   VERSION
ip-10-0-123-253.ap-south-1.compute.internal   Ready    <none>   82s   v1.34.9-eks-7d6f6ec
ip-10-0-147-153.ap-south-1.compute.internal   Ready    <none>   82s   v1.34.9-eks-7d6f6ec
ip-10-0-190-70.ap-south-1.compute.internal    Ready    <none>   81s   v1.34.9-eks-7d6f6ec
```
3 nodes, all `Ready`, Kubernetes v1.34.

### Resources created (for reference later)
- **VPC:** `vpc-0b85769ee7612f4dd`
- **Subnets (mixed public/private, 3 AZs):**

| AZ | Subnet ID | Public? |
|---|---|---|
| ap-south-1a | subnet-059c0448985ace092 | No (private) |
| ap-south-1c | subnet-068e41ada2a08baec | Yes |
| ap-south-1a | subnet-0b787bb00518b8e72 | Yes |
| ap-south-1c | subnet-021bc382d09a6aa84 | No (private) |
| ap-south-1b | subnet-0bde6e8db175eb69c | Yes |
| ap-south-1b | subnet-03cca09cf6de109dc | No (private) |

- **EKS node security group:** `sg-00cfa52bb25fa6861` (`eks-cluster-sg-myflix-eks-2041291551`) — auto-created and attached to all worker nodes; used as the reference source-group for downstream DB/cache access rules instead of CIDR ranges (survives node scaling automatically).

---

## Phase 2 — ECR + Image Push

**Why:** EKS nodes pull pre-built images from a registry; they don't build from source like `docker-compose build` did locally.

### Bug found and fixed: `transcoding-service/Dockerfile.eks`
The original file was a **copy-pasted Go build template** (`golang:1.25` builder → `go build`) applied to a Python (FastAPI + ffmpeg) service. Confirmed by build error:
```
go: go.mod file not found in current directory or any parent directory
```
Rewritten to a correct Python-based Dockerfile, matching what `Dockerfile.local` already did successfully, plus non-root hardening for EKS parity with the Go services' `distroless:nonroot` posture:

```dockerfile
FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home --uid 1000 appuser
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8092"]
```
Note: resulting image is ~350–450MB (vs. ~15–25MB for distroless Go images) — expected and acceptable, since the size comes from ffmpeg's dependency tree, not from Python itself. Not worth optimizing further right now.

### Frontend Dockerfiles — no `.eks` variant needed
Both `frontend-ui` and `admin-dashboard` are static builds served by nginx — they don't talk to RDS/S3/Secrets Manager directly (only to `api-gateway` over HTTP), so there's no environment-specific *build* difference. Same image works in any environment.

- `admin-dashboard/Dockerfile` — already bakes in `nginx.conf` via `COPY`. No change needed.
- `frontend-ui/Dockerfile` — originally relied on docker-compose's runtime volume mount to inject `nginx.conf`, which doesn't exist on EKS. **Decision: keep Dockerfile as-is, inject `nginx.conf` via a Kubernetes ConfigMap instead** (see below), to preserve the "config injected at runtime, not baked into image" pattern.

### Repos created (14 total)
```bash
SERVICES="analytics-service api-gateway auth-service interaction-service media-library-service metadata-service payment-service recommendation-service subscription-service transcoding-service user-service watchhistory-service frontend-ui admin-dashboard"

for svc in $SERVICES; do
  aws ecr create-repository --repository-name myflix/$svc --region ap-south-1
done
```

### Build + push pattern
```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.ap-south-1.amazonaws.com"
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin $REGISTRY

for svc in $SERVICES; do
  if [ -f "$svc/Dockerfile.eks" ]; then DOCKERFILE="Dockerfile.eks"; else DOCKERFILE="Dockerfile"; fi
  docker build -f "$svc/$DOCKERFILE" -t myflix/$svc:v1 "$svc"
  docker tag myflix/$svc:v1 $REGISTRY/myflix/$svc:v1
  docker push $REGISTRY/myflix/$svc:v1
done
```
**Status:** all 14 services built and pushed manually (user opted for manual builds over the loop, using `Dockerfile.eks` where present, plain `Dockerfile` for the two frontends).

### `frontend-ui` nginx ConfigMap
Created as a declarative manifest (not `kubectl create` imperative) so it fits the same `kubectl apply -f` workflow as the rest of the cluster. Line endings normalized from CRLF → LF before embedding (source file had Windows line endings).

File: `k8s/configmaps/frontend-ui-nginx-configmap.yaml`
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-ui-nginx-conf
  namespace: myflix
data:
  default.conf: |
    # (contents of frontend-ui/nginx.conf, LF-normalized)
```
**Dependency noted for later:** this ConfigMap references `namespace: myflix`, which doesn't exist yet — must create `k8s/namespace.yaml` before this can be applied. Also, `nginx.conf`'s `proxy_pass` targets (`api-gateway`, `admin-dashboard`) must match the exact Kubernetes Service names created in Phase 7, in the same namespace, or requests will 502.

**Mount pattern for the Deployment (to be used in Phase 7):**
```yaml
volumeMounts:
  - name: nginx-conf
    mountPath: /etc/nginx/conf.d/default.conf
    subPath: default.conf   # critical — without subPath, mounting overwrites the whole /etc/nginx/conf.d/ directory
volumes:
  - name: nginx-conf
    configMap:
      name: frontend-ui-nginx-conf
```
**Known tradeoff:** editing this ConfigMap later won't auto-restart pods or reload nginx — requires `kubectl rollout restart deployment/frontend-ui` after changes.

---

## Phase 3 — RDS + ElastiCache (in progress)

**Why now, why this order:** these need to live inside the VPC/subnets from Phase 1, so they couldn't be provisioned first.

### Reserved-word gotcha caught before provisioning
The existing `DATABASE_URL` uses master username `postgres` — **RDS does not allow `postgres` as the master username** (reserved internally). Will use `myflix_admin` instead. Every service's `DATABASE_URL` env var will need to reflect this once RDS is live.

### Source database config being replicated (from `docker-compose.yml`)
```
postgres:15-alpine, DB name: myflix, single shared DB across all services
redis:7-alpine, no AUTH configured
```

### Private subnets identified for DB/cache subnet groups
```
subnet-059c0448985ace092  (ap-south-1a)
subnet-021bc382d09a6aa84  (ap-south-1c)
subnet-03cca09cf6de109dc  (ap-south-1b)
```
(3 AZs — satisfies RDS's ≥2-AZ subnet group requirement with room for future Multi-AZ upgrade.)

### Security groups created — DONE
Reference the EKS node SG (`sg-00cfa52bb25fa6861`) as the allowed source, rather than a CIDR range, so the rule stays valid automatically as nodes scale up/down.

```bash
# RDS SG
aws ec2 create-security-group --group-name myflix-rds-sg \
  --description "Allow Postgres access from EKS nodes only" \
  --vpc-id vpc-0b85769ee7612f4dd --region ap-south-1
# → sg-0f7cdfebcba6cf103

aws ec2 authorize-security-group-ingress \
  --group-id sg-0f7cdfebcba6cf103 --protocol tcp --port 5432 \
  --source-group sg-00cfa52bb25fa6861 --region ap-south-1

# ElastiCache SG
aws ec2 create-security-group --group-name myflix-redis-sg \
  --description "Allow Redis access from EKS nodes only" \
  --vpc-id vpc-0b85769ee7612f4dd --region ap-south-1
# → sg-0dc9523f4ce942a3f

aws ec2 authorize-security-group-ingress \
  --group-id sg-0dc9523f4ce942a3f --protocol tcp --port 6379 \
  --source-group sg-00cfa52bb25fa6861 --region ap-south-1
```

**Result:**
| Purpose | Security Group ID |
|---|---|
| RDS (Postgres, port 5432) | `sg-0f7cdfebcba6cf103` |
| ElastiCache (Redis, port 6379) | `sg-0dc9523f4ce942a3f` |

### Not yet done
- [ ] DB subnet group (spanning the 3 private subnets)
- [ ] Cache subnet group
- [ ] `aws rds create-db-instance` (Postgres 15, master user `myflix_admin`)
- [ ] `aws elasticache create-cache-cluster` (Redis 7)
- [ ] Schema/data migration from local Postgres → RDS
- [ ] Update service `DATABASE_URL` / Redis endpoint values

---

## Outstanding phases (not yet started)

- **Phase 4** — S3 bucket for media; IRSA role for `transcoding-service` (already S3-ready in code) and new S3 client code needed for `media-library-service` (Go, currently local-filesystem-only, no AWS SDK in `go.mod`)
- **Phase 5** — External Secrets Operator + AWS Secrets Manager (retires plaintext secrets)
- **Phase 6** — AWS Load Balancer Controller + ALB ingress
- **Phase 7** — Full `k8s/` manifest set (namespace, configmaps, deployments/services, observability with EBS-backed PVCs instead of `emptyDir`, ingress)
- **Phase 8** — Resource requests/limits, liveness probes, HPA on `api-gateway` / `metadata-service`

---

## Known open items to resolve before those phases
1. `media-library-service` needs AWS SDK for Go v2 (`github.com/aws/aws-sdk-go-v2/service/s3`) added to `go.mod`, and `scanner.go` rewritten to `ListObjectsV2` instead of `filepath.Walk` against `MEDIA_DATA_DIR`.
2. `transcoding-service/storage_manager.py` currently expects static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars — these should be **removed** once IRSA is set up in Phase 4; `boto3` will pick up IRSA credentials automatically.
3. Confirm build-context correctness for all `Dockerfile.eks` files (`COPY` paths relative to build context) — flagged as a possible issue, user proceeded with manual builds so any context errors would have surfaced already.
