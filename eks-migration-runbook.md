# MyFlix OTT Platform — EKS Migration Runbook

**Account ID:** `723300665462`
**Region:** `ap-south-1`
**Cluster name:** `myflix-eks`
**Status:** **All 8 phases complete.** 13 of 14 services running with resource requests/limits, liveness/readiness probes, and HPA (`payment-service` blocked on a known Secrets Manager issue — see Open Items). Full observability stack live. Real public URL via ALB. Complete upload → transcode → authenticated HLS playback flow confirmed working in a browser. Known open items are tracked in one place at the end of this document — check there first before assuming something is unresolved.

---

## Architecture decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Database | RDS Postgres (managed) | Production-grade HA/backups vs. running Postgres as a pod |
| Cache | ElastiCache Redis (managed) | Same reasoning as RDS |
| Media storage | S3 | `transcoding-service` was already S3-ready in code; scales beyond node-local disk |
| Observability | Self-hosted in-cluster (Prometheus/Grafana/Loki/Tempo) | Keep existing manifests/logic, avoid AMP/AMG migration cost right now |
| Cluster provisioning | eksctl | Fast, CLI-driven, no Terraform state to manage yet |
| Ingress | AWS Load Balancer Controller → ALB | Native ACM/WAF/Route53 integration |
| Secrets | External Secrets Operator + AWS Secrets Manager | Retires plaintext-YAML secrets flagged in original `kubernetes.md` limitations |
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
**Note:** `t3.large` was the original intent here, but the account's actual available instance types turned out to be restricted (see the node-sizing saga in Phase 7) — nodes were actually provisioned as `t3.small`. Keep this in mind when reading "why `t3.large`" reasoning below; it didn't end up matching reality.

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
Resulting image is ~350–450MB (vs. ~15–25MB for distroless Go images) — expected and acceptable, since the size comes from ffmpeg's dependency tree, not from Python itself.

### Frontend Dockerfiles — no `.eks` variant needed
Both `frontend-ui` and `admin-dashboard` are static builds served by nginx — no environment-specific *build* difference, same image works anywhere.
- `admin-dashboard/Dockerfile` — already bakes in `nginx.conf` via `COPY`. No change needed.
- `frontend-ui/Dockerfile` — relied on docker-compose's runtime volume mount to inject `nginx.conf`, which doesn't exist on EKS. **Decision: inject via a Kubernetes ConfigMap instead** (see below), preserving the "config injected at runtime, not baked into image" pattern.

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
All 14 services built and pushed manually.

### `frontend-ui` nginx ConfigMap
Declarative manifest, not `kubectl create` imperative, for `kubectl apply -f` consistency. Line endings normalized CRLF → LF before embedding.

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
Dependency noted for later: references `namespace: myflix`, which didn't exist until Phase 4. Also, `nginx.conf`'s `proxy_pass` targets (`api-gateway`, `admin-dashboard`) must match the exact Kubernetes Service names, same namespace, or requests 502.

**Mount pattern used in the Deployment (Phase 7):**
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

## Phase 3 — RDS + ElastiCache

**Why now, why this order:** these need to live inside the VPC/subnets from Phase 1.

### Reserved-word gotcha caught before provisioning
`postgres` is not allowed as an RDS master username (reserved internally). Used `myflix_admin` instead.

### Source database config being replicated
```
postgres:15-alpine, DB name: myflix, single shared DB across all services
redis:7-alpine, no AUTH configured
```

### Private subnets used for DB/cache subnet groups
```
subnet-059c0448985ace092  (ap-south-1a)
subnet-021bc382d09a6aa84  (ap-south-1c)
subnet-03cca09cf6de109dc  (ap-south-1b)
```
All 3 AZs — satisfies RDS's ≥2-AZ requirement with room for a future Multi-AZ upgrade.

### Security groups
Reference the EKS node SG (`sg-00cfa52bb25fa6861`) as the allowed source, not a CIDR range, so the rule stays valid automatically as nodes scale.
```bash
aws ec2 create-security-group --group-name myflix-rds-sg \
  --description "Allow Postgres access from EKS nodes only" \
  --vpc-id vpc-0b85769ee7612f4dd --region ap-south-1
# → sg-0f7cdfebcba6cf103
aws ec2 authorize-security-group-ingress \
  --group-id sg-0f7cdfebcba6cf103 --protocol tcp --port 5432 \
  --source-group sg-00cfa52bb25fa6861 --region ap-south-1

aws ec2 create-security-group --group-name myflix-redis-sg \
  --description "Allow Redis access from EKS nodes only" \
  --vpc-id vpc-0b85769ee7612f4dd --region ap-south-1
# → sg-0dc9523f4ce942a3f
aws ec2 authorize-security-group-ingress \
  --group-id sg-0dc9523f4ce942a3f --protocol tcp --port 6379 \
  --source-group sg-00cfa52bb25fa6861 --region ap-south-1
```

| Purpose | Security Group ID |
|---|---|
| RDS (Postgres, port 5432) | `sg-0f7cdfebcba6cf103` |
| ElastiCache (Redis, port 6379) | `sg-0dc9523f4ce942a3f` |

### DB/Cache subnet groups
`myflix-rds-subnet-group`, `myflix-redis-subnet-group` — both span all 3 private subnets.

### Gotcha: Free Tier backup retention limit
`aws rds create-db-instance` failed with `FreeTierRestrictionError` on `--backup-retention-period 7`. Free-tier accounts cap this lower. Fixed by dropping to `--backup-retention-period 1`. Worth raising once off Free Tier.

### Aurora Serverless v2 — considered, rejected
Rejected because: (1) Aurora is entirely excluded from AWS Free Tier — bills from the first ACU-hour, unlike `db.t3.micro`; (2) adds ACU-scaling concepts on top of everything else being learned; (3) standard RDS matches the docker-compose engine exactly, Aurora is AWS's own fork. Right tool for unpredictable production spikes, not a single-cluster learning setup.

### Instances created
```bash
aws rds create-db-instance \
  --db-instance-identifier myflix-postgres \
  --db-instance-class db.t3.micro \
  --engine postgres --engine-version 15 \
  --master-username myflix_admin --master-user-password '<redacted>' \
  --allocated-storage 20 \
  --db-name myflix \
  --db-subnet-group-name myflix-rds-subnet-group \
  --vpc-security-group-ids sg-0f7cdfebcba6cf103 \
  --no-publicly-accessible --no-multi-az \
  --backup-retention-period 1 \
  --region ap-south-1

aws elasticache create-cache-cluster \
  --cache-cluster-id myflix-redis \
  --engine redis --engine-version 7.0 \
  --cache-node-type cache.t3.micro --num-cache-nodes 1 \
  --cache-subnet-group-name myflix-redis-subnet-group \
  --security-group-ids sg-0dc9523f4ce942a3f \
  --region ap-south-1
```

### Endpoints (live)
| Resource | Endpoint | Port |
|---|---|---|
| RDS Postgres | `myflix-postgres.cdekc2yo40cj.ap-south-1.rds.amazonaws.com` | 5432 |
| ElastiCache Redis | `myflix-redis.rrewcm.0001.aps1.cache.amazonaws.com` | 6379 |

### Connection strings used in all services
```
DATABASE_URL=postgres://myflix_admin:<password>@myflix-postgres.cdekc2yo40cj.ap-south-1.rds.amazonaws.com:5432/myflix?sslmode=require
REDIS_ADDR=myflix-redis.rrewcm.0001.aps1.cache.amazonaws.com:6379
```
Note `sslmode=require` (was `disable` locally) — RDS enforces TLS by default.

### Schema migration
Fresh schema, no data to preserve — no `pg_dump`/restore needed. Services' existing auto-migration logic recreates the schema on first boot against RDS.

---

## Phase 4 — S3 + IRSA

**Why:** `transcoding-service`'s `storage_manager.py` already had a working `S3StorageManager` (boto3) but expected static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. IRSA replaces that with temporary, auto-rotated credentials tied to a Kubernetes ServiceAccount. This is what `iam.withOIDC: true` in Phase 1 was for.

### Namespace created (pulled forward from Phase 7, needed to unblock IRSA)
`eksctl create iamserviceaccount` requires the target namespace to exist first.
```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: myflix
  labels:
    app: myflix
```

### S3 bucket
```bash
aws s3api create-bucket \
  --bucket ott-media-raw-723300665462 \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-public-access-block \
  --bucket ott-media-raw-723300665462 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --region ap-south-1
```
Bucket name includes the account ID for global uniqueness. Single-bucket design confirmed in code — raw and transcoded output separated by S3 key prefix, not separate buckets.

### IAM policy
```bash
aws iam create-policy --policy-name MyFlixS3MediaAccess --policy-document file://s3-media-policy.json
# → arn:aws:iam::723300665462:policy/MyFlixS3MediaAccess
```
Object-level actions (`GetObject`/`PutObject`/`DeleteObject`) scoped to `.../ott-media-raw-723300665462/*`; bucket-level action (`ListBucket`) scoped to the bucket ARN without `/*`.

### IRSA service accounts (one per service, not shared)
```bash
eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name transcoding-service --attach-policy-arn arn:aws:iam::723300665462:policy/MyFlixS3MediaAccess --approve

eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name media-library-service --attach-policy-arn arn:aws:iam::723300665462:policy/MyFlixS3MediaAccess --approve
```
Each creates an IAM role trusted only by that exact `system:serviceaccount:myflix:<name>` identity, plus a K8s `ServiceAccount` annotated with `eks.amazonaws.com/role-arn`.

**IRSA verification method** (used throughout the rest of the project): `kubectl get pod -n myflix -l app=<name> -o jsonpath='{.items[0].spec.serviceAccountName}'` should print the IRSA service account name, not `default`.

### `transcoding-service/storage_manager.py` — code change
Removed `aws_access_key_id`/`aws_secret_access_key` from the `boto3.client("s3")` call — boto3 auto-discovers IRSA credentials. Only this one method changed.

### `media-library-service` — full S3 rewrite (had zero AWS SDK usage going in)
1. **`go.mod`** — added `aws-sdk-go-v2/config` + `aws-sdk-go-v2/service/s3`. Also fixed an unrelated pre-existing gap: `telemetry/tracer.go` imported OpenTelemetry packages never added to `go.mod`.
2. **`s3store/s3store.go`** (new package) — wraps the S3 client via `config.LoadDefaultConfig` (Go SDK v2's IRSA-aware auto-discovery). Exposes `ListObjects`, `GetObjectRange`, `HeadObject`, `PutObject`, `Exists`.
3. **`scanner/scanner.go`** — rewritten from `filepath.Walk` to `store.ListObjects(ctx, prefix)`. S3 has no real directories — `"Movies/"` is just a key prefix. Every method gained a `ctx context.Context` param. `GetMediaPath`/`GetHLSPath` → `GetMediaKey`/`GetHLSKey`.
4. **`handler/handler.go`** — `Stream` uses `HeadObject` + `GetObjectRange` instead of `os.Open`/`Seek`; `Upload` streams multipart data directly into `PutObject`, no temp file; `GetHLSFile` follows the same `Exists` + `GetObjectRange` pattern (later substantially revised again post-deployment — see that section).
5. **`main.go`** — `MEDIA_DATA_DIR` replaced with required `S3_BUCKET_NAME`/`AWS_REGION`, fails fast via `log.Fatal` if missing.

**Verification approach:** full `go build ./...` isn't possible in the assistant's sandbox (project needs Go 1.25 for `pyroscope-go`, sandbox can't reach `proxy.golang.org`) — code was syntax-checked with `gofmt`, then actually compiled by the user locally. Confirmed clean.

---

## Phase 5 — External Secrets Operator + AWS Secrets Manager

**Why:** retire the plaintext secrets in `docker-compose.yml` (`JWT_SECRET`, `RAZORPAY_KEY_ID`/`SECRET`, `TMDB_API_KEY`, the RDS password). ESO syncs real values from Secrets Manager into native K8s Secrets automatically.

### Secrets stored
```bash
aws secretsmanager create-secret --name myflix/database-url --secret-string "postgres://myflix_admin:<password>@myflix-postgres.cdekc2yo40cj.ap-south-1.rds.amazonaws.com:5432/myflix?sslmode=require" --region ap-south-1
aws secretsmanager create-secret --name myflix/jwt-secret --secret-string "<real JWT secret>" --region ap-south-1
aws secretsmanager create-secret --name myflix/razorpay --secret-string '{"RAZORPAY_KEY_ID":"...","RAZORPAY_KEY_SECRET":"..."}' --region ap-south-1
aws secretsmanager create-secret --name myflix/tmdb-api-key --secret-string "<value>" --region ap-south-1
```
`REDIS_ADDR` deliberately excluded — ElastiCache has no AUTH token, so it stays in a plain ConfigMap instead.

### IAM policy — scoped read access
```bash
aws iam create-policy --policy-name MyFlixSecretsRead --policy-document file://secrets-read-policy.json
# → arn:aws:iam::723300665462:policy/MyFlixSecretsRead
```
`secretsmanager:GetSecretValue` only, scoped to `arn:aws:secretsmanager:ap-south-1:723300665462:secret:myflix/*`.

### ESO controller via Helm
```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm install external-secrets external-secrets/external-secrets --namespace external-secrets --create-namespace --set installCRDs=true
```
**Gotcha:** `installCRDs=true` didn't actually take effect; `ClusterSecretStore`/`SecretStore` CRDs (which embed schemas for every ESO provider) exceeded the 262,144-byte `last-applied-configuration` annotation limit under normal `kubectl apply`. Fixed with server-side apply, which doesn't use that annotation:
```bash
kubectl apply --server-side -f https://raw.githubusercontent.com/external-secrets/external-secrets/main/deploy/crds/bundle.yaml
```

### IRSA identity for reading secrets
```bash
eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name eso-secrets-reader --attach-policy-arn arn:aws:iam::723300665462:policy/MyFlixSecretsRead --approve
```
Lives in `myflix` (not `external-secrets`) — keeps all IRSA identities visible in one namespace.

### ClusterSecretStore
```yaml
# k8s/secrets/cluster-secret-store.yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: ap-south-1
      auth:
        jwt:
          serviceAccountRef:
            name: eso-secrets-reader
            namespace: myflix
```
**Gotcha:** first attempt used `external-secrets.io/v1beta1`, defined in the CRD but marked `served: false` (deprecated). Fixed by using `external-secrets.io/v1`. (`kubectl explain <kind> --api-version=<group>/<version>` is the fast way to check which versions are actually live.)

Verified `Ready: True` before proceeding.

### ExternalSecret objects
```yaml
# k8s/secrets/external-secrets.yaml — 4 objects:
# myflix-database-secret  → DATABASE_URL
# myflix-jwt-secret       → JWT_SECRET
# myflix-razorpay-secret  → RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (via remoteRef.property on the JSON secret)
# myflix-tmdb-secret      → TMDB_API_KEY
```
`refreshInterval: 1h`, `target.creationPolicy: Owner` (ESO fully owns the resulting Secret).

**Sync result:** `myflix-database-secret`, `myflix-jwt-secret`, `myflix-tmdb-secret` all synced. `myflix-razorpay-secret` failed (`SecretSyncedError`) — see Open Items at the end of this document; likely a malformed-JSON or property-name mismatch in the Secrets Manager entry.

---

## Phase 6 — AWS Load Balancer Controller + ALB Ingress

**Why:** provisions a real AWS ALB from Kubernetes `Ingress` objects — native ACM/WAF/Route53 integration.

### IAM policy
```bash
curl -o iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json
aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy --policy-document file://iam-policy.json
```
**Note:** this `v2.7.2`-pinned version turned out to be missing a permission needed later — see the Ingress section below for the fix actually applied.

### IRSA identity — lives in kube-system, not myflix
```bash
eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace kube-system \
  --name aws-load-balancer-controller --attach-policy-arn arn:aws:iam::723300665462:policy/AWSLoadBalancerControllerIAMPolicy --approve
```
Breaks the Phase 4/5 per-app-namespace pattern deliberately — this controller manages load balancers cluster-wide, so it belongs with other cluster infra (`coredns`, EBS CSI driver) in `kube-system`.

### Helm install
```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=myflix-eks \
  --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller
```
`serviceAccount.create=false` — the IRSA-annotated ServiceAccount already exists from the eksctl step; letting Helm create its own risks a second, non-IRSA ServiceAccount.

Verified: `2/2 Running`.

### Subnet auto-discovery — confirmed
`kubernetes.io/role/elb: 1` present on public subnets automatically (eksctl tags these at cluster creation) — no manual tagging or explicit `subnets` annotation needed.

---

## Phase 7 — Full k8s/ manifest set

**Approach:** one service at a time, starting with the simplest (`auth-service`) to establish a template, then building up to trickier ones (IRSA services, ConfigMap-mounted frontend).

### Shared ConfigMap
```yaml
# k8s/configmaps/common-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: myflix-common-config
  namespace: myflix
data:
  OTEL_EXPORTER_OTLP_ENDPOINT: "tempo:4317"
```

### auth-service — template pattern for every other service
Conventions established here and repeated throughout:
- Service name must exactly match how other services reference it (K8s DNS resolves bare names within a namespace)
- `envFrom` for shared/secret values (ConfigMap + relevant Secrets), plain `env` for service-specific values
- No `resources:`/`livenessProbe:` yet — deferred to Phase 8
- `replicas: 1` for now

**Gotcha: special characters in DATABASE_URL password.** First deploy failed: `cannot parse ... invalid port ":admin" after host`. The RDS password contained a URI-structural character (`@`, `:`, etc.). **Fix:** percent-encode the password (`@`→`%40`, etc.) before storing in Secrets Manager. Two required follow-ups, both non-obvious:
1. `kubectl delete secret myflix-database-secret -n myflix` to force ESO to resync immediately (its `refreshInterval: 1h` otherwise means up to an hour's delay).
2. `kubectl rollout restart deployment/auth-service -n myflix` — env vars are read once at container start, updating the K8s Secret alone doesn't touch a running pod.

### All 13 service manifests

| Service | Notes |
|---|---|
| auth-service | Template; hit the password-encoding gotcha above |
| user-service | Simplest pattern — common env + own PORT only |
| metadata-service | Adds `myflix-tmdb-secret` via envFrom |
| recommendation-service | Simple pattern |
| watchhistory-service | Simple pattern |
| interaction-service | Simple pattern |
| subscription-service | Simple pattern |
| analytics-service | Simple pattern |
| api-gateway | Routes to every other service by K8s Service DNS name |
| payment-service | References `myflix-razorpay-secret`, which doesn't exist (Phase 5 issue) — `CreateContainerConfigError`, expected, low priority |
| transcoding-service | `serviceAccountName: transcoding-service` (IRSA); `MEDIA_DATA_DIR`/`HLS_OUTPUT_DIR` are ephemeral local scratch space (ffmpeg needs real files), not persistent — final output goes to S3 |
| media-library-service | `serviceAccountName: media-library-service` (IRSA), verified via the jsonpath check from Phase 4 |
| frontend-ui | ConfigMap-mounted `nginx.conf` (`subPath: default.conf`) |
| admin-dashboard | nginx.conf baked into image, no ConfigMap needed |

**Gotcha: frontend-ui crashed twice on first boot (self-resolved).** nginx resolves `upstream` hostnames once at startup and hard-fails if any don't resolve. `admin-dashboard`'s Service didn't exist yet the instant `frontend-ui` first booted (applied close together) → crash → Kubernetes retried → by then `admin-dashboard` existed → resolved fine. **Latent fragility, not fixed:** could recur on any future simultaneous restart of both. Real fix would be an nginx `resolver` directive + variable (per-request DNS resolution) instead of a static `upstream` block — deferred, low priority given current stability.

### Observability stack

**Prometheus.** ConfigMap built from `prometheus.yml` + `alert_rules.yml` combined (both need to be in the same directory for `rule_files` to work — no `subPath`, full directory replacement is correct here). Dropped `cadvisor`/`node-exporter` scrape jobs (no EKS equivalent deployed). **Gotcha:** official image runs as non-root (UID/GID 65534) — `permission denied` writing to the EBS PVC until `securityContext.fsGroup: 65534` was added. This exact fix pattern was needed for every subsequent PVC-backed component. **Known non-functional carryover:** `HighMemoryUsage` alert rule filters on `name=~"ott_project_golang.*"` (docker-compose container-naming) — doesn't match K8s pod names, loads fine but never fires.

**Alertmanager.** Same ConfigMap+PVC+fsGroup pattern. **Known non-functional carryover:** `webhook_configs` points at `http://localhost:5001/alerts` — confirmed dead even locally (no matching service in `docker-compose.yml`, `localhost` in a container only refers to itself). Alerts fire and get silently dropped until a real webhook destination is configured.

**Loki.** **Real bug found and fixed:** `docker-compose.yml` mounted its volume at `/loki`, but `loki.yml`'s `path_prefix` is `/tmp/loki` — meaning local Loki never actually persisted to the named volume. Fixed by mounting the PVC at `/tmp/loki` (matching the config) rather than repeating the mismatch. Also fixed `ruler.alertmanager_url: http://localhost:9093` → `http://alertmanager:9093` (same dead-localhost pattern, but this one has a known-correct real target). `fsGroup: 10001`.

**Promtail — required a full rewrite, not a port.** `promtail-config.yml` used `docker_sd_configs` + `/var/run/docker.sock`, which doesn't exist on EKS (containerd runtime). Replaced with `kubernetes_sd_configs` (role: pod) + relabeling to build the correct `__path__` for containerd's log location (`/var/log/pods/<uid>/<container>/*.log`). Deployed as a **DaemonSet** (logs are node-local) with a `ServiceAccount`+`ClusterRole`+`ClusterRoleBinding` (list/watch pods cluster-wide) and `hostPath` mounts for `/var/log/pods` and `/run/promtail`.

**Major gotcha — DaemonSet scheduling vs. node capacity.** Promtail pods stuck `Pending` on 3 of 5 nodes with simultaneous `NodeAffinity` + `Too many pods` errors. Root cause: **DaemonSets pin one pod per node via a hard `nodeAffinity` on `metadata.name`** — each pod is only ever a scheduling candidate for its one assigned node. The "NodeAffinity mismatch" on other nodes wasn't an error, those nodes were never candidates; the real failure was "Too many pods" on the *one* node each pod was actually pinned to. All 5 nodes are `t3.small`, which caps at exactly **11 pods/node** (AWS VPC CNI's ENI/IP-based limit — `(IPs per ENI − 1) × max ENIs + 2`). Adding more `t3.small` nodes doesn't fix already-stuck DaemonSet pods since they're immovably pinned — confirmed empirically when an added node only unblocked one of three stuck pods. **Actual fix — cordon/drain/uncordon per stuck node:**
```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
kubectl uncordon <node-name>
```
`--ignore-daemonsets` leaves Promtail/`aws-node`/`kube-proxy` alone; draining evicts movable (Deployment) pods elsewhere, freeing exactly enough room for the pinned Promtail pod. Repeated across all 3 stuck nodes; all 5 Promtail pods confirmed `Running`, all evicted pods rescheduled cleanly with no data loss. **This does not fix the underlying `t3.small` ceiling** — only unblocks it for now. Account's available instance types were restricted to `t3.micro/small`, `t4g.micro/small`, `c7i-flex.large`, `m7i-flex.large` — no `t3.large` available despite Phase 1's original intent. `c7i-flex.large`/`m7i-flex.large` are the realistic upgrade path if more workloads get added; this will resurface otherwise.

**Tempo.** Clean config, no bugs — unlike Loki, `tempo.yml`'s storage paths matched the compose volume mount exactly. `fsGroup: 10001`. Creating the `tempo` Service resolved the `OTEL_EXPORTER_OTLP_ENDPOINT: tempo:4317` target every service had been silently retrying against since Phase 7 began — self-healed automatically, no restarts needed.

**Grafana.** Two ConfigMaps needed (`datasources/` and `dashboards/` are separate subdirectories, unlike Prometheus's flat one): `grafana-datasources` and `grafana-dashboards` (the latter includes a real 112KB dashboard export, not a stub). **Two real fixes made:** (1) the Tempo→Loki trace-correlation query used a docker-compose container-naming pattern that doesn't match Promtail's actual `container` label — corrected. (2) The Pyroscope datasource pointed at a service that never existed even locally (`pyroscope-go` client just silently logs connection errors) — commented out with an explanation rather than left silently broken. `fsGroup: 472`. **Known carryover:** no `GF_SECURITY_ADMIN_PASSWORD` was ever set (same locally) — running on default `admin`/`admin`. **Verified working:** all three datasources (Prometheus/Loki/Tempo) pass "Save & test."

### Ingress

**Key discovery:** `frontend-ui/nginx.conf` already reverse-proxies everything internally (`/api`+`/media` → `api-gateway`, `/admin` → `admin-dashboard`, everything else → the SPA) — so the Ingress only needed **one backend**, `frontend-ui` itself.

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myflix-ingress
  namespace: myflix
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
    alb.ingress.kubernetes.io/healthcheck-path: /
spec:
  ingressClassName: alb
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-ui
                port:
                  number: 80
```
`target-type: ip` registers pod IPs directly (via VPC CNI) — the modern recommended EKS mode, and what makes target-group management fully automatic (no manual registration, ever, in a correctly wired setup).

**Gotcha: IAM policy version too old.** Ingress had no `ADDRESS` for several minutes. `kubectl describe ingress` showed `AccessDenied: elasticloadbalancing:DescribeListenerAttributes`. The `v2.7.2`-pinned policy from Phase 6 predates AWS adding this required action. **Fix:**
```bash
curl -o iam-policy-latest.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
aws iam create-policy-version \
  --policy-arn arn:aws:iam::723300665462:policy/AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam-policy-latest.json --set-as-default
```
No role/IRSA changes needed. IAM policies cap at 5 versions — delete an old one first if this errors with `LimitExceeded`.

### Live public URL
```
http://k8s-myflix-myflixin-d0b00f2e36-2097105264.ap-south-1.elb.amazonaws.com
```

### api-gateway ALLOWED_ORIGINS — updated to the real ALB URL
```bash
kubectl set env deployment/api-gateway -n myflix ALLOWED_ORIGINS="http://k8s-myflix-myflixin-d0b00f2e36-2097105264.ap-south-1.elb.amazonaws.com"
```

---

## Post-deployment verification — 5 real bugs found and fixed

Getting the frontend fully working end-to-end (login → upload → transcode → playback) surfaced five genuine, **pre-existing** application bugs — none of them infrastructure/Kubernetes issues, all things that were already broken locally and simply never got exercised against a real end-to-end flow before now.

### Bug 1 — `VITE_API_BASE` fallback defeated the Dockerfile's own intent
`App.jsx` and `api/client.js` both used `import.meta.env.VITE_API_BASE || "http://localhost:8094"`. Since `""` is falsy in JS, this silently overrode the Dockerfile's deliberate empty-string production value (meant to trigger relative-path/same-origin calls through nginx) and fell back to `localhost:8094` — would break in any real deployment, not just EKS. **Fix:** `||` → `??` (nullish coalescing) in both files. Required an image rebuild (`frontend-ui:v2`), since Vite bakes env vars at build time.

### Bug 2 — nginx's default 1MB body size limit
Upload endpoint returned `413`. `client_max_body_size` was never set in `frontend-ui/nginx.conf`. **Fix:** added `client_max_body_size 2048m;`. Since `nginx.conf` is ConfigMap-mounted, this needed only a ConfigMap update + `rollout restart`, no rebuild.

### Bug 3 — ALB Controller IAM policy version (see Phase 7 Ingress section above)

### Bug 4 — HLS playback URL prefix didn't match any registered api-gateway route
`scanner.go` hardcoded HLS URLs as `/media/hls/...`. `frontend-ui`'s nginx `/media/` block proxies to `api-gateway`, but `api-gateway` only ever registered `/api/media/*path` — never a bare `/media/*path`. Pre-existing, never triggered locally either. **Fix:** changed the prefix in `scanner.go` to `/api/media/hls/...`. Required `media-library-service:v3`.

### Bug 5 — Two-part fix for authenticated HLS delivery
**5a. Token not propagated into playlist internals.** `api-gateway`'s auth middleware already supported `?token=` as a fallback for `<video>`/HLS (can't attach custom headers to player-initiated sub-requests). But `master.m3u8`'s internal references to per-quality playlists (`480p/playlist.m3u8`) are plain relative paths written by ffmpeg, with no way to carry a token. The player follows those automatically, tokenless → `401`. **Fix (chosen over simply leaving HLS unauthenticated):** `GetHLSFile` now reads `.m3u8` files fully into memory, parses line-by-line, and appends `?token=...` (or `&token=`) to every non-comment, non-blank line — every real file reference, per the M3U8 spec. `.ts` segments are untouched, still streamed directly.

**5b. Route pattern didn't support the real HLS directory depth.** Even with the token fix, per-quality playlists/segments still `404`'d. `main.go` registered `/hls/:file_id/:filename` — a fixed two-segment pattern, but real HLS output has variable depth (`master.m3u8` is 1 level deep; per-quality files are 2: `480p/playlist.m3u8`, `1080p/segment_000.ts`). **Fix:** changed the route to `/hls/:file_id/*filepath` (wildcard), with the leading slash Gin's wildcard always includes trimmed before use. `GetHLSKey`'s own key-construction needed no changes — plain string concatenation already handled a multi-segment filename correctly.

Both 5a+5b shipped together as `media-library-service:v5`, verified via a full three-level playback check (master playlist → per-quality playlist → actual `.ts` segments, all `200` with the token correctly attached).

**Broader pattern worth naming:** several bugs across this whole migration turned out to be pre-existing gaps in the original codebase (this section, plus the Loki path mismatch, the dead Alertmanager webhook, the dead Pyroscope datasource, the docker-compose-style container-name filters in Prometheus/Grafana) — never caused by the migration itself, just never triggered until something exercised the full path end-to-end for the first time. "Did this ever actually work, even locally?" is often a faster diagnostic question than "what did the migration break?"

---

## Phase 8 — Resource requests/limits, probes, HPA

**Scope decision:** requests/limits + liveness/readiness probes applied to all 14 services (11 backend Go services + `transcoding-service` + both frontends — corrected count; earlier phases sometimes said "13," missing one). HPA also applied to all 14, not just `api-gateway`/`metadata-service` as originally scoped — user explicitly broadened this after seeing the initial plan.

**Sizing approach:** used real `kubectl top pods` output (captured after the platform had been live and used for a while) as the baseline, rather than guessing — everything was near-idle at the time except `transcoding-service` (131Mi, real ffmpeg memory use) and the observability stack itself.

| Tier | Services | Requests (cpu/mem) | Limits (cpu/mem) | Probe |
|---|---|---|---|---|
| Lightweight Go (no `/health`) | auth, user, recommendation, watchhistory, interaction, subscription, analytics, payment | 25m / 64Mi | 200m / 200Mi | `tcpSocket` on own port |
| metadata-service | metadata | 30m / 64Mi | 250m / 200Mi | `tcpSocket` |
| api-gateway | api-gateway | 50m / 64Mi | 300m / 256Mi | `httpGet /health` |
| media-library-service | media-library | 30m / 100Mi | 300m / 300Mi | `httpGet /health` |
| transcoding-service | transcoding | 100m / 256Mi | 900m / 768Mi | `httpGet /health` |
| Static frontends | frontend-ui, admin-dashboard | 10m / 32Mi | 100m / 100Mi | `httpGet /` or `/health` |

**Health endpoint audit (done before writing probes, to avoid restart-loop risk):** only `api-gateway`, `media-library-service`, `transcoding-service`, and `admin-dashboard` have a real `/health` route. `frontend-ui` has none but `/` reliably returns 200 (static nginx). **The other 9 Go services have no health endpoint at all** — used `tcpSocket` probes for these instead of `httpGet`, since an HTTP probe against a nonexistent path would have caused constant restart loops (Gin's default 404 response fails Kubernetes' default probe success range). Known limitation: `tcpSocket` only confirms the process is listening, not that it's actually healthy (e.g. a lost DB connection wouldn't be caught) — a real `/health` endpoint per service would be a better follow-up, but that's a code change beyond this infra pass.

**HPA config:** `minReplicas: 1, maxReplicas: 3`, target 70% CPU, kept deliberately conservative given the `t3.small` node-capacity ceiling fought through in Phase 7 — broad HPA usage risks re-triggering that same wall if multiple services scale up simultaneously.

**Caveat flagged before applying, not after:** CPU-based HPA suits stateless request-driven services well, but `transcoding-service` runs long, singular, resource-intensive jobs — scaling replicas doesn't meaningfully help a single in-progress transcode finish faster. Applied per the user's explicit "across all" instruction, but its practical value on this specific service is limited.

### Rollout result
13 of 14 Deployments rolled out cleanly with **zero node-capacity issues** — the conservative sizing meant the "old pod + new pod must both fit briefly during rolling update" concern (flagged before applying, given Phase 7's capacity history) never actually materialized.

`payment-service` was the only exception, and for reasons unrelated to Phase 8 itself: the new pod hit the same pre-existing `CreateContainerConfigError` (Phase 5's unresolved Razorpay secret), and an old leftover pod separately showed `ImagePullBackOff` (not investigated further — user chose to move on rather than chase it, given it doesn't block anything else).

### HPA verification
All 13 healthy services show real CPU percentages from `metrics-server` (well under the 70% target, consistent with genuinely light current traffic — e.g. `auth-service` 8%, `transcoding-service` 2%). `payment-service`'s HPA correctly shows `<unknown>` — expected, since `metrics-server` has no running container to measure.

---

## Open items (single source of truth — check here first)

1. **`myflix-razorpay-secret` ExternalSecret fails to sync** (`SecretSyncedError`). Likely a malformed-JSON or property-name mismatch in the `myflix/razorpay` Secrets Manager entry. Debug via `kubectl describe externalsecret myflix-razorpay-secret -n myflix`. `payment-service` has no working credentials until this is fixed (`CreateContainerConfigError`).
2. **`payment-service` also has a leftover old pod showing `ImagePullBackOff`** (separate from item 1, surfaced during the Phase 8 rollout) — not investigated, deprioritized alongside the secret issue since neither blocks anything else. Worth a `kubectl describe pod` when picked back up.
3. **Grafana's default admin password** (`admin`/`admin`) has never been changed — now that there's a public ALB entry point, worth doing before any wider exposure.
4. **Node sizing** — `t3.small`'s 11-pod-per-node ceiling is unblocked (via cordon/drain) but not fixed. Will resurface as more workloads are added, and Phase 8's broad HPA rollout raises this risk further (multiple services could scale up simultaneously). `c7i-flex.large`/`m7i-flex.large` are the realistic upgrade path given this account's restricted instance-type availability.
5. **`frontend-ui`'s nginx upstream resolution is still static** — same boot-order crash risk as before (resolves hostnames once at startup, no retry). Real fix: nginx `resolver` directive + variable for per-request resolution.
6. **`HighMemoryUsage` Prometheus alert rule** still filters on docker-compose container-naming (`ott_project_golang.*`) — loads fine, never fires.
7. **Alertmanager's webhook** (`localhost:5001`) has no real receiver — alerts fire and are silently dropped. Needs a real Slack/PagerDuty/email destination whenever alerting is wired up for real.
8. **Pyroscope** (continuous profiling) was never actually deployed — referenced in Go code and Grafana's datasource config, but no backing service exists, and never did even locally.
9. **The unused `/media/` nginx location block** in `frontend-ui/nginx.conf` is now dead weight (proxies to `api-gateway`, which has no matching route) since the HLS-routing bug fix moved everything to `/api/media/`. Harmless to leave, cleanup candidate.
10. **`api-gateway`'s Dockerfile build-context correctness** was flagged early on as worth double-checking (`COPY` paths relative to build context) but never explicitly re-verified — all services built successfully, so likely fine, but not formally confirmed.
11. **9 of 14 services have no real `/health` endpoint** — their liveness/readiness probes use `tcpSocket` instead (confirms the process is listening, not that it's genuinely healthy). Adding a proper `/health` route to each would be a meaningful follow-up improvement, not urgent.
12. **`transcoding-service`'s HPA has limited practical value** — CPU-based horizontal scaling doesn't meaningfully help a single long-running transcode job finish faster. Applied per explicit request, not because it's the ideal tool here.