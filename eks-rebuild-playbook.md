# MyFlix EKS Rebuild Playbook — New AWS Account

This is a clean, start-to-finish execution guide for rebuilding the entire platform on a new AWS account. It assumes your GitHub repo (`https://github.com/thirumaalt/OTT_Project_Golang_EKS.git`, `eks/` path) already has all the real manifest files from the first build — this playbook tells you what to run and what to find-and-replace in those existing files, not to recreate them from scratch.

**How this differs from `eks-migration-runbook.md`:** that document is the *history* — what happened, in what order, including every bug hit along the way. This document is the *destination* — every known fix is already baked into the instructions below, so you build it right the first time instead of rediscovering the same issues.

---

## Before you start — fill in these values as you go

Keep a scratchpad of these as you create each resource; every phase below references them:

| Placeholder | Where it comes from |
|---|---|
| `<ACCOUNT_ID>` | `aws sts get-caller-identity` |
| `<REGION>` | Your choice — `ap-south-1` was used originally |
| `<VPC_ID>`, `<PRIVATE_SUBNET_1/2/3>`, `<NODE_SG_ID>` | Output of `eksctl create cluster` (Phase 1) |
| `<RDS_SG_ID>`, `<REDIS_SG_ID>` | Phase 3 |
| `<RDS_ENDPOINT>`, `<REDIS_ENDPOINT>` | Phase 3 |
| `<S3_BUCKET_NAME>` | Phase 4 (must be globally unique — include account ID) |
| `<ALB_DNS_NAME>` | Phase 7 (Ingress), only known after it's created |

**Decisions already locked in** (don't re-litigate these — they were chosen deliberately, see `eks-migration-runbook.md` for full reasoning):
RDS Postgres + ElastiCache Redis (managed) · S3 for media · self-hosted observability · eksctl (not Terraform) · AWS Load Balancer Controller · External Secrets Operator + Secrets Manager · ArgoCD (manual sync) · `frontend-ui` nginx.conf via ConfigMap · `admin-dashboard` nginx.conf baked into image.

---

## Phase 1 — Cluster

```bash
aws sts get-caller-identity   # confirm this is the NEW account
```

```yaml
# cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: myflix-eks
  region: <REGION>
vpc:
  cidr: 10.0.0.0/16
  nat:
    gateway: Single
managedNodeGroups:
  - name: myflix-workers
    instanceType: t3.small   # or larger if your new account's instance-type
                              # restrictions allow it — t3.small hits an
                              # 11-pod-per-node ceiling (AWS VPC CNI's
                              # ENI/IP limit) that caused real friction
                              # last time. c7i-flex.large/m7i-flex.large
                              # are worth trying first if available.
    desiredCapacity: 4        # last build needed 4-5 nodes at t3.small
                              # sizing to comfortably fit everything
    minSize: 2
    maxSize: 6
    volumeSize: 40
    privateNetworking: true
iam:
  withOIDC: true   # required for IRSA — do not skip
```

```bash
eksctl create cluster -f cluster.yaml
kubectl get nodes   # confirm all Ready
```

Note the VPC ID, subnet IDs, and the auto-created node security group name (`eks-cluster-sg-myflix-eks-...`) from the command output — needed in Phase 3.

---

## Phase 2 — ECR + images

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.<REGION>.amazonaws.com"

SERVICES="analytics-service api-gateway auth-service interaction-service media-library-service metadata-service payment-service recommendation-service subscription-service transcoding-service user-service watchhistory-service frontend-ui admin-dashboard"

for svc in $SERVICES; do
  aws ecr create-repository --repository-name myflix/$svc --region <REGION>
done

aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin $REGISTRY

for svc in $SERVICES; do
  if [ -f "$svc/Dockerfile.eks" ]; then DOCKERFILE="Dockerfile.eks"; else DOCKERFILE="Dockerfile"; fi
  docker build -f "$svc/$DOCKERFILE" -t myflix/$svc:v1 "$svc"
  docker tag myflix/$svc:v1 $REGISTRY/myflix/$svc:v1
  docker push $REGISTRY/myflix/$svc:v1
done
```

**Already fixed, no action needed:** `transcoding-service/Dockerfile.eks` is already the corrected Python-based version (not the old broken Go template) — this was fixed in the first build and is already in your repo.

**Confirm build-context correctness** for any `Dockerfile.eks` before assuming it'll work — this was flagged once early on and never fully re-verified; worth a quick sanity check this time given you're rebuilding from scratch anyway.

---

## Phase 3 — RDS + ElastiCache

```bash
# Security groups — reference the node SG, not a CIDR range
aws ec2 create-security-group --group-name myflix-rds-sg \
  --description "Postgres from EKS nodes only" --vpc-id <VPC_ID> --region <REGION>
aws ec2 authorize-security-group-ingress --group-id <RDS_SG_ID> \
  --protocol tcp --port 5432 --source-group <NODE_SG_ID> --region <REGION>

aws ec2 create-security-group --group-name myflix-redis-sg \
  --description "Redis from EKS nodes only" --vpc-id <VPC_ID> --region <REGION>
aws ec2 authorize-security-group-ingress --group-id <REDIS_SG_ID> \
  --protocol tcp --port 6379 --source-group <NODE_SG_ID> --region <REGION>

# Subnet groups — all 3 private subnets
aws rds create-db-subnet-group --db-subnet-group-name myflix-rds-subnet-group \
  --db-subnet-group-description "Private subnets" \
  --subnet-ids <PRIVATE_SUBNET_1> <PRIVATE_SUBNET_2> <PRIVATE_SUBNET_3> --region <REGION>

aws elasticache create-cache-subnet-group --cache-subnet-group-name myflix-redis-subnet-group \
  --cache-subnet-group-description "Private subnets" \
  --subnet-ids <PRIVATE_SUBNET_1> <PRIVATE_SUBNET_2> <PRIVATE_SUBNET_3> --region <REGION>
```

```bash
# RDS — master username CANNOT be "postgres" (reserved). Backup retention
# capped at 1 day if this account is on Free Tier (known error otherwise:
# FreeTierRestrictionError).
aws rds create-db-instance \
  --db-instance-identifier myflix-postgres \
  --db-instance-class db.t3.micro \
  --engine postgres --engine-version 15 \
  --master-username myflix_admin --master-user-password '<CHOOSE_A_PASSWORD>' \
  --allocated-storage 20 --db-name myflix \
  --db-subnet-group-name myflix-rds-subnet-group \
  --vpc-security-group-ids <RDS_SG_ID> \
  --no-publicly-accessible --no-multi-az \
  --backup-retention-period 1 --region <REGION>

aws elasticache create-cache-cluster \
  --cache-cluster-id myflix-redis \
  --engine redis --engine-version 7.0 \
  --cache-node-type cache.t3.micro --num-cache-nodes 1 \
  --cache-subnet-group-name myflix-redis-subnet-group \
  --security-group-ids <REDIS_SG_ID> --region <REGION>
```

**Password rule, learned the hard way:** if your chosen password contains `@`, `:`, `/`, `?`, or `#`, percent-encode those characters before using the password in any `DATABASE_URL` connection string (`@`→`%40`, `:`→`%3A`, etc.) — otherwise the URI parser misreads where the password ends and the host begins.

```bash
aws rds describe-db-instances --db-instance-identifier myflix-postgres --region <REGION> \
  --query "DBInstances[0].Endpoint.{Address:Address,Port:Port}"
aws elasticache describe-cache-clusters --cache-cluster-id myflix-redis --region <REGION> --show-cache-node-info \
  --query "CacheClusters[0].CacheNodes[0].Endpoint.{Address:Address,Port:Port}"
```

Connection string format (note `sslmode=require`, not `disable`):
```
postgres://myflix_admin:<percent-encoded-password>@<RDS_ENDPOINT>:5432/myflix?sslmode=require
```

**Confirmed real gotcha from the actual rebuild — three separate places must all agree on this password, and nothing keeps them in sync automatically:** (1) the real RDS instance's password (`aws rds modify-db-instance --master-user-password`), (2) the `myflix/database-url` Secrets Manager entry, (3) the `myflix-database-secret` Kubernetes Secret ESO syncs from it. Updating Secrets Manager alone does **not** change the real database password — both must be done, and after either changes, force ESO to resync immediately rather than waiting for its hourly refresh:
```bash
kubectl delete secret myflix-database-secret -n myflix
kubectl get secret myflix-database-secret -n myflix -o jsonpath="{.data.DATABASE_URL}"
# decode and confirm it actually matches before restarting anything
```

---

## Phase 4 — S3 + IRSA

```bash
kubectl apply -f eks/namespace.yaml   # myflix namespace — required before IRSA setup below

aws s3api create-bucket --bucket <S3_BUCKET_NAME> --region <REGION> \
  --create-bucket-configuration LocationConstraint=<REGION>
aws s3api put-public-access-block --bucket <S3_BUCKET_NAME> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --region <REGION>
```

```bash
cat > s3-media-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"], "Resource": "arn:aws:s3:::<S3_BUCKET_NAME>/*"},
    {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::<S3_BUCKET_NAME>"}
  ]
}
EOF
aws iam create-policy --policy-name MyFlixS3MediaAccess --policy-document file://s3-media-policy.json

eksctl create iamserviceaccount --cluster myflix-eks --region <REGION> --namespace myflix \
  --name transcoding-service --attach-policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/MyFlixS3MediaAccess --approve

eksctl create iamserviceaccount --cluster myflix-eks --region <REGION> --namespace myflix \
  --name media-library-service --attach-policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/MyFlixS3MediaAccess --approve
```

**Confirmed real gotcha — run both commands, not just one.** In the actual rebuild, only the `transcoding-service` one got run; `media-library-service` was missed. Applying a Deployment that references `serviceAccountName: media-library-service` does **not** create that ServiceAccount — it's a separate, one-off command that's easy to forget for the second of the two services. Symptom if missed: the Deployment shows `FailedCreate` with **zero pods ever attempted** (not a crash — Kubernetes refuses to create the pod at all since the referenced ServiceAccount doesn't exist). Check both exist before moving on:
```bash
kubectl get serviceaccount transcoding-service media-library-service -n myflix
```

**Already fixed in your repo, no action needed:** `transcoding-service/storage_manager.py` and all of `media-library-service`'s S3 integration (`s3store/`, `scanner.go`, `handler.go`, `main.go`) already use IRSA-compatible credential auto-discovery — no static AWS keys anywhere. Just make sure the Deployment YAMLs (Phase 7) set `S3_BUCKET_NAME=<S3_BUCKET_NAME>` to your new bucket name.

**Verify IRSA is actually wired once pods are running:**
```bash
kubectl get pod -n myflix -l app=media-library-service -o jsonpath='{.items[0].spec.serviceAccountName}'
# must print "media-library-service", not "default"
```

---

## Phase 5 — Secrets (External Secrets Operator)

```bash
aws secretsmanager create-secret --name myflix/database-url --region <REGION> \
  --secret-string "postgres://myflix_admin:<percent-encoded-password>@<RDS_ENDPOINT>:5432/myflix?sslmode=require"
aws secretsmanager create-secret --name myflix/jwt-secret --region <REGION> --secret-string "<real JWT secret>"
aws secretsmanager create-secret --name myflix/razorpay --region <REGION> \
  --secret-string '{"RAZORPAY_KEY_ID":"...","RAZORPAY_KEY_SECRET":"..."}'
aws secretsmanager create-secret --name myflix/tmdb-api-key --region <REGION> --secret-string "<value>"
```

**Watch this one carefully — this exact secret failed to sync last time** (`SecretSyncedError`) and was never resolved. Double-check the JSON is valid and the property names exactly match what `k8s/external-secrets.yaml` expects (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) before moving on — don't just copy-paste the same mistake forward.

```bash
cat > secrets-read-policy.json << 'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],"Resource":"arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:myflix/*"}]}
EOF
aws iam create-policy --policy-name MyFlixSecretsRead --policy-document file://secrets-read-policy.json
```

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
# Use --server-side from the start this time — installCRDs=true does not
# reliably work; the CRDs (ClusterSecretStore/SecretStore) are large enough
# to exceed kubectl's 262,144-byte last-applied-configuration annotation
# limit under normal apply.
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace
kubectl apply --server-side -f https://raw.githubusercontent.com/external-secrets/external-secrets/main/deploy/crds/bundle.yaml

eksctl create iamserviceaccount --cluster myflix-eks --region <REGION> --namespace myflix \
  --name eso-secrets-reader --attach-policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/MyFlixSecretsRead --approve
```

```bash
kubectl apply -f eks/cluster-secret-store.yaml   # already uses external-secrets.io/v1 (not the deprecated v1beta1)
kubectl get clustersecretstore aws-secrets-manager -o jsonpath='{.status.conditions}'   # confirm Ready: True

kubectl apply -f eks/external-secrets.yaml
kubectl get externalsecret -n myflix   # confirm all show SecretSynced / READY True
```

---

## Phase 6 — AWS Load Balancer Controller

```bash
# Use the CURRENT policy from main, not a version-pinned release tag —
# a v2.7.2-pinned policy was missing elasticloadbalancing:DescribeListenerAttributes
# last time, which broke Ingress provisioning later. Save yourself that bug now.
curl -o iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy --policy-document file://iam-policy.json

eksctl create iamserviceaccount --cluster myflix-eks --region <REGION> --namespace kube-system \
  --name aws-load-balancer-controller --attach-policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy --approve

helm repo add eks https://aws.github.io/eks-charts
helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=myflix-eks \
  --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller

kubectl get deployment -n kube-system aws-load-balancer-controller   # confirm Running
```

---

## Phase 7 — Kubernetes manifests

All of these already exist in your repo (`eks/configmaps/`, `eks/deployments/` or `eks/service/`, `eks/observability/`, `eks/hpa.yaml`, `eks/ingress.yaml`). **Find-and-replace these values across every file before applying anything:**

- `025211337216` → `<ACCOUNT_ID>` (every `image:` field, every ARN reference)
- `ott-media-raw-025211337216` → `<S3_BUCKET_NAME>`
- Old RDS/Redis endpoints → new ones from Phase 3 (these live in Secrets Manager now, not directly in manifests — just confirm the Secrets Manager values themselves are updated, Phase 5)

```bash
kubectl apply -f eks/configmaps/common-config.yaml
kubectl apply -f eks/configmaps/frontend-ui-nginx-configmap.yaml
# ^ already has the client_max_body_size 2048m fix baked in — don't lose this
```

**Deploy services in this order** (dependency-driven, though not strictly required for a fresh cluster): `auth-service` → `user-service` → the rest of the simple services → `api-gateway` → `transcoding-service`/`media-library-service` (need IRSA `serviceAccountName` set) → `frontend-ui`/`admin-dashboard`.

**Every Deployment already has, from the first build — confirm these survived in your repo, don't skip them:**
- Resource requests/limits (sized from real `kubectl top` data)
- Liveness/readiness probes (`tcpSocket` for the 9 services with no `/health` endpoint; `httpGet` for `api-gateway`, `media-library-service`, `transcoding-service`, `admin-dashboard`)
- `serviceAccountName: transcoding-service` / `media-library-service` on those two specifically

```bash
kubectl apply -f eks/hpa.yaml   # after all Deployments are stable, not before
kubectl get hpa -n myflix   # expect real CPU% within 1-2 minutes, not permanent <unknown>
```

**Known crash risk, already understood:** `frontend-ui` may restart 1-2 times on first boot if `admin-dashboard`'s Service doesn't exist yet the instant nginx starts (nginx resolves `upstream` hostnames once at boot and hard-fails if unresolved). Self-resolves once both Services exist; not a new bug if you see it again.

### Observability stack

```bash
kubectl apply -f eks/storage-class.yaml   # gp3 via the real EBS CSI driver

# If PVCs stay stuck Pending, check the CSI driver is actually installed:
kubectl get pods -n kube-system | grep ebs-csi
# If missing:
eksctl create addon --cluster myflix-eks --region <REGION> --name aws-ebs-csi-driver --force
```

```bash
kubectl apply -f eks/configmaps/prometheus-config.yaml
kubectl apply -f eks/observability/prometheus.yaml
kubectl apply -f eks/configmaps/alertmanager-config.yaml
kubectl apply -f eks/observability/alertmanager.yaml
kubectl apply -f eks/configmaps/loki-config.yaml
kubectl apply -f eks/observability/loki.yaml
kubectl apply -f eks/configmaps/promtail-config.yaml
kubectl apply -f eks/observability/promtail.yaml
kubectl apply -f eks/configmaps/tempo-config.yaml
kubectl apply -f eks/observability/tempo.yaml
kubectl apply -f eks/configmaps/grafana-datasources-config.yaml
kubectl apply -f eks/configmaps/grafana-dashboards-config.yaml
kubectl apply -f eks/observability/grafana.yaml
```

**Already fixed in these files, confirm they survived:**
- Prometheus/Loki/Tempo/Grafana Deployments all have `securityContext.fsGroup` set (`65534`/`10001`/`10001`/`472` respectively) — without this, each crashes with `permission denied` writing to its PVC (official images run non-root)
- Loki's PVC mounts at `/tmp/loki`, matching `loki.yml`'s actual `path_prefix` (the original docker-compose setup had these mismatched and never actually persisted data)
- `loki.yml`'s `ruler.alertmanager_url` is `http://alertmanager:9093`, not `localhost:9093`
- Prometheus's scrape config has the `cadvisor`/`node-exporter` jobs already removed (no EKS equivalent deployed)
- Grafana's Pyroscope datasource is commented out (no such service exists)
- Promtail uses `kubernetes_sd_configs` (role: pod), **not** `docker_sd_configs` — this is a from-scratch rewrite requirement, not optional, since containerd (not Docker) is the EKS runtime

**Promtail known-good config — use this exactly, do not add a `selectors:` block under `kubernetes_sd_configs` (a later attempt at per-node filtering broke discovery entirely, `0/0` targets, never fully diagnosed before the account was blocked):**
```yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    pipeline_stages:
      - cri: {}
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_node_name]
        target_label: __host__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - action: replace
        source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - action: replace
        source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - action: replace
        source_labels: [__meta_kubernetes_pod_container_name]
        target_label: container
      - replacement: /var/log/pods/*$1/*.log
        separator: /
        source_labels: [__meta_kubernetes_pod_uid, __meta_kubernetes_pod_container_name]
        target_label: __path__
```
**Verify this actually works this time**, before moving on — don't assume:
```bash
kubectl port-forward -n myflix <a-promtail-pod> 9080:9080
# open http://localhost:9080/targets — must show real targets, not 0/0
```
If it's `0/0` again on a fresh cluster with this exact config, that's new information (rules out "bad config" as the cause) — check `kubectl logs <pod> --tail=100` and the RBAC (`ClusterRole`/`ClusterRoleBinding`/`ServiceAccount` — all three must exist and match) before assuming it's the same unresolved bug.

**DaemonSet + node capacity, if you hit it again:** if some Promtail pods stay `Pending` with both `NodeAffinity` and `Too many pods` in the same error — remember DaemonSet pods are hard-pinned to one specific node each (via `nodeAffinity` on `metadata.name`), so adding *more* nodes doesn't unstick an already-pinned pod stuck on a full node. Fix per stuck node:
```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
kubectl uncordon <node-name>
```

### Ingress

```bash
kubectl apply -f eks/ingress.yaml
kubectl get ingress -n myflix -w   # wait for a real ADDRESS, takes a few minutes
```

If it hangs with no `ADDRESS`, check `kubectl describe ingress myflix-ingress -n myflix` — if the Events show an `AccessDenied` on any `elasticloadbalancing:Describe*` action, the IAM policy from Phase 6 is stale; re-pull the current policy and `aws iam create-policy-version --set-as-default`.

Once you have the ALB's DNS name:
```bash
kubectl set env deployment/api-gateway -n myflix ALLOWED_ORIGINS="http://<ALB_DNS_NAME>"
```

**Test the full flow before considering this phase done:** load the ALB URL in a browser, log in, upload a video, confirm transcoding completes, confirm playback actually works (master playlist → per-quality playlist → segments, all authenticated). All of the HLS routing/token-injection fixes are already in `media-library-service`'s code — this should just work without repeating that whole debugging session, but don't skip verifying it.

---

## Phase 8 — Resources, probes, HPA

Already done as part of Phase 7 above (all 14 Deployments were built with this from the start this time, rather than retrofitted later). Nothing separate to do here — just confirm:
```bash
kubectl get hpa -n myflix   # all 14 present, real CPU% showing
```

---

## Phase 9 — GitOps (ArgoCD)

```bash
kubectl create namespace argocd
# Use --server-side from the start — same CRD-size issue as ESO hit this
# exact problem last time (applicationset-controller crash-looped on a
# missing CRD that plain kubectl apply silently failed to register).
kubectl apply --server-side -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl get pods -n argocd   # confirm all Running before continuing
```

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
kubectl port-forward svc/argocd-server -n argocd 8080:443
# https://localhost:8080, login admin + password above
```

```yaml
# argocd-application.yaml — apply directly via kubectl, keep OUTSIDE the
# eks/ folder ArgoCD watches (avoids the app managing its own definition)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myflix
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/thirumaalt/OTT_Project_Golang_EKS.git
    targetRevision: main
    path: eks
    directory:
      recurse: true
      # Only scan .yaml files — the repo has non-K8s files mixed in
      # (iam-policy*.json, cluster.yaml — eksctl's own config format,
      # never installed as a real CRD). "include" is more robust here
      # than trying to exclude every possible non-manifest file; combine
      # with "exclude" for cluster.yaml specifically since it IS a .yaml
      # file and "include" alone won't stop it.
      include: "*.yaml"
      exclude: "cluster.yaml"
  destination:
    server: https://kubernetes.default.svc
    namespace: myflix
  syncPolicy: {}   # manual sync — review the diff before every apply
```

**Before applying — confirm your repo's `eks/configmaps/` folder doesn't have any duplicate ConfigMap definitions** (this happened once before — `nginx-config.yaml` and `frontend-ui-nginx-configmap.yaml` both defined the same object with different, conflicting content, and would have silently reverted a real bug fix if synced blindly). Quick check:
```bash
grep -rl "name: frontend-ui-nginx-conf" eks/configmaps/
# should return exactly ONE file
```

```bash
kubectl apply -f argocd-application.yaml
kubectl get application myflix -n argocd   # SYNC STATUS should resolve within seconds, not hang
```

**Before clicking Sync:** review the diff in the UI. On a truly fresh cluster this should mostly show "create" for everything (expected) — pause and investigate if it proposes to *modify or delete* anything unexpected.

**If `kubectl patch` for a manual sync trigger fails with a JSON-escaping error** — this is a Windows PowerShell quoting issue, not a real problem. Either use the UI's Sync button, or delete-and-recreate the Application object to force a fresh state, rather than fighting PowerShell's escaping rules.

---

## Not yet built (same status as before the account was blocked)

- **CDN (CloudFront)** — decision made: CloudFront → S3 direct alone won't work without a custom domain, due to browser same-site cookie restrictions (the app's backend can't set a cookie CloudFront on an unrelated `*.cloudfront.net` domain would ever see). Two ways forward: (a) one CloudFront distribution in front of everything — default behavior → ALB, `/api/media/hls/*` behavior → S3 direct via OAC, unifying the domain; or (b) get a custom domain and use it for both. Signed **cookies** (not signed URLs) are the right CloudFront auth mechanism once you get there — cookies apply automatically to every request under a path pattern, avoiding the need to sign every nested HLS playlist/segment reference individually (unlike signed URLs, which would face the exact same nested-reference problem `GetHLSFile`'s token-injection code was built to solve).
- **`payment-service`'s Razorpay secret** — flagged above in Phase 5, don't let it repeat silently this time.
