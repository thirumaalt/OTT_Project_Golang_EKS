# MyFlix OTT Platform — EKS Migration Runbook

**Account ID:** `025211337216` **— BLOCKED. Rebuild in progress on new account `723300665462`.**
**Region:** `ap-south-1`
**Cluster name:** `myflix-eks`
**Status:** **Platform fully rebuilt, stable, and now has a CDN and a custom observability tool.** Cluster, RDS, ElastiCache, S3, ECR, IAM policies, ESO, ALB Controller, EBS CSI driver, and ArgoCD are all live and healthy. Promtail's long-unresolved zero-target bug was root-caused as a version incompatibility and fixed by migrating to Grafana Alloy (Phase 11). CloudFront CDN is live in front of both the app and S3 media (Phase 12). A custom internal tool, `devops-dashboard-service`, now provides a real-time health checklist and deployment UI (Phase 13). 13 of 14 services `Running` (`payment-service` intentionally parked — real Razorpay credentials aren't available yet, not a technical blocker).

---

## Phase 13 — devops-dashboard-service: a custom internal observability/deployment tool

**Why:** across this entire project, "is everything actually okay?" has meant running 10-30+ individual `kubectl`/`aws` commands by hand. This phase builds a single internal tool that answers that in one HTTP call — encoding essentially every "real health vs. object exists" lesson learned throughout the project (pods `Running` AND `Ready`, HPA reporting real metrics not `<unknown>`, secrets actually `SecretSynced`, ArgoCD actually `Synced`) into reusable checks.

**Naming:** originally called `dashboard-service`, renamed to `devops-dashboard-service` immediately after creation — `admin-dashboard` already existed as the CMS/admin frontend, and the collision would have been genuinely confusing to read back later. Renamed consistently across the Go module path, binary name, ECR repo, every Kubernetes resource name, and the IAM policy name before anything was deployed.

### Architecture
Two services, mirroring the main app's own `frontend-ui` + `api-gateway` split:
- **`devops-dashboard-service`** (Go, Gin) — the actual checks + deploy logic
- **`devops-dashboard-frontend`** (React/Vite) — the UI

**Backend needs two independent permission grants, not one:**
- **IRSA** (read-only IAM policy: `eks:DescribeCluster`, `rds:DescribeDBInstances`, `elasticache:DescribeCacheClusters`, `s3:ListBucket`/`GetBucketLocation`, `ecr:Describe*`, `cloudfront:Get*`/`List*`) — for the AWS-side checks
- **Kubernetes RBAC** (`ClusterRole` + `ClusterRoleBinding`) — for pods/services/deployments/HPAs, plus the CRDs `externalsecrets.external-secrets.io` and `applications.argoproj.io` (read via the *dynamic* client, since neither has a generated typed client available) — for the cluster-side checks

**Gotcha hit during setup:** the RBAC (`ClusterRole`/`ClusterRoleBinding`) was applied via a plain YAML file, but IRSA is attached via `eksctl create iamserviceaccount` — and since the `ServiceAccount` already existed from the RBAC apply, `eksctl` refused to touch it without `--override-existing-serviceaccounts`. First deploy attempt had AWS checks passing but every single Kubernetes-side check failing with `forbidden` — a clean signal, in hindsight, of exactly which of the two permission systems was missing (the `devops-dashboard-rbac.yaml` file had simply never been applied at all).

### Backend endpoints
- `GET /api/checklist` — every check (pods, HPA, ExternalSecrets, ArgoCD sync, EKS/RDS/ElastiCache/S3/CloudFront status, ECR image presence for all 14 services), returns pass/fail/detail per check plus a summary count
- `GET /api/services` — deployed tag (read live from the Deployment) vs. latest tag in ECR, flags anything behind
- `POST /api/deploy/:service` — bumps a service's manifest to a new tag via a **real GitHub API commit** (not a local git checkout — this runs in-cluster, so it has none). Deliberately does **not** touch the cluster directly; ArgoCD still gates the actual rollout, same discipline as every other change in this project.
- `GET /api/logs/:service` — last 50 log lines for a service's pod, for a quick look without opening a terminal

**Deploying via this tool needs its own GitHub token**, synced through Secrets Manager → ESO → K8s Secret, same pattern as every other secret in this project. `manifestPaths` in `main.go` maps each service name to its manifest file in the repo — hardcoded, needs updating if the repo's layout ever changes.

### First real verification
Deployed and tested against the live cluster: **50/53 checks passing**, the 3 failures being exactly the known `payment-service`/Razorpay gap, nothing new or unexpected. Confirmed the tool genuinely replaces the manual verification process this whole project has relied on.

### Frontend features (built in two passes)
**First pass:** Checklist tab (grouped by category, pass/fail badges) and Deploy tab (deployed-vs-latest table with a Deploy button).

**Second pass, after "make it more interactive":**
- Health ring (animated circular progress, overall pass %)
- Auto-refresh (15s poll, toggleable) + "failures only" filter
- **Known-issues list** (`payment-service`, `myflix-razorpay-secret`) shown as a calm grey "KNOWN" badge instead of a fresh red alarm every poll — summary line explicitly separates "need attention" from "known/expected" so the real health count is never obscured
- Deploy confirmation dialog — since Deploy triggers a real git commit, a stray click shouldn't be able to do that silently
- **HPA bars showing real CPU% vs. target**, not just pass/fail — required a small backend change (`Result` gained optional `Current`/`Target` fields, `CheckHPA` rewritten to extract real values from `hpa.Status.CurrentMetrics`/`hpa.Spec.Metrics` instead of just checking whether a value exists)
- **Sparklines** — small trend line per check using an in-memory rolling history (`StampHistory`, 40-entry ring buffer keyed by `category/name`, stamped onto every `/api/checklist` response). Resets on backend pod restart — this is "recent session trend," not a permanent record (that's what Grafana/Loki are for)
- **Inline log viewer** — click a service name, see its last 50 log lines in a modal, no terminal needed. Needed a new RBAC grant (`pods/log`, `get` — a distinct permission from listing pod objects)
- **Search box** — live filter by check name
- **Flip-highlighting** — compares each poll to the previous one client-side (free, since polling already happens every 15s); anything that changed pass↔fail gets a 6-second yellow glow, so a change among 53 rows doesn't require manually scanning for it
- **Export snapshot** — downloads the current checklist as Markdown, formatted to paste straight into this runbook

### Verification approach
Genuine, not just eyeballed — this sandbox has both a working Go toolchain (for `gofmt`, confirmed clean on every file) and, unlike the main project's own services, **actual working `npm install && npm run build`** (the frontend's dependency tree doesn't hit the same vanity-import domain restrictions Go's `client-go`/`golang.org/x/*` did) — every frontend change in this phase was verified with a real production build, not just syntax-checked.

### Not yet built (explicitly deferred)
- **Write-action features** (a restart button, a CloudFront invalidation button) — would need new RBAC (`patch` on deployments) and new IAM (`cloudfront:CreateInvalidation`), deliberately held back until the read-only foundation was solid
- **Auth in front of the dashboard** — currently reachable only via `kubectl port-forward`, same posture as Grafana. A CloudFront routing attempt (`/platform-status`) was built (Vite `base` path config, a prefix-stripping nginx rewrite) but never fully verified working — see Phase 12's routing notes, which hit the identical class of issue

---

## Phase 12 — CloudFront CDN

**Decision context:** picked back up mid-session after being paused when the original account was blocked. Original ask was CloudFront → S3 direct with signed cookies for auth. That plan changed twice during actual implementation — worth recording why, not just the final state.

### Real architectural finding: signed cookies need a unified domain, which changes everything
Signed cookies (chosen over signed URLs specifically because HLS's nested playlist/segment references would otherwise face the same problem Bug 5 solved manually in the original build) require the app and CloudFront to share one domain — browsers won't apply a cookie set by the app's origin to a separate `*.cloudfront.net` domain. Since no custom domain existed, this meant either getting one or making CloudFront front *everything* (app + media) under its own single domain.

### Decision: DRM and CloudFront signed cookies both explicitly declined
When DRM came up as "the real production answer," it was correctly scoped as a separate, expensive undertaking (a paid license server, CENC encryption in the transcoding pipeline, EME-capable player) — same category as the Razorpay integration: a legitimate future project, not something to build now. **Signed cookies were also explicitly declined** once the domain-unification tradeoff was understood — proceeding with **OAC-only**, meaning **HLS content is currently publicly accessible to anyone with a URL, no login required**. A deliberate, informed choice for a learning project's test content, not an oversight.

### What was actually built
- **Origin Access Control (OAC)** — lets CloudFront read the private S3 bucket directly via SigV4; bucket policy scoped with an `AWS:SourceArn` condition to this exact distribution (not any CloudFront distribution in any account)
- **CloudFront Function** — rewrites `/api/media/hls/*` → `/hls/*` at the edge, so requests match real S3 keys without any app-code changes
- **Two-origin distribution**: default behavior → ALB (`CachingDisabled` — the app is dynamic, login/uploads/API responses must never be cached; `AllViewer` origin request policy so cookies/headers/query strings reach the app unmodified), `/api/media/hls/*` → S3 direct (`CachingOptimized` — segments are immutable once written)

### Gotchas hit, in order
1. **OAC ID mix-up** — first attempt used a documentation-example ID (`ETVPDKIKX0DER`) instead of the real one, then *that* exact string turned out to actually be the CloudFront Function's ETag from an unrelated earlier command — an easy mix-up since both are `E`-prefixed strings from adjacent commands. Fixed by explicitly listing OACs and using the real ID.
2. **AWS-managed cache/origin-request policy IDs** (`CachingDisabled`, `CachingOptimized`, `AllViewer`) were written from memory into the distribution config — verified against the real account via `list-cache-policies`/`list-origin-request-policies` before applying, all three confirmed correct.
3. **A 403 that was actually correct behavior, not a bug** — first HLS test returned 403 before any transcoding had ever run on the rebuilt account; since the bucket policy grants only `GetObject` (no `ListBucket`), S3 correctly returns 403 rather than 404 for a nonexistent object, so this looked alarming but was accurate.
4. **Wrong URL guessed for a nonexistent HLS path** — after confirming the raw upload existed but HLS didn't, a follow-up request guessed at a path that didn't match the real S3 key structure either; resolved by checking `aws s3 ls --recursive` directly rather than continuing to guess.
5. **Transcoding appeared to fail but actually succeeded** — GPU (`h264_nvenc`) attempts failed loudly on every quality (`t3.small` nodes have no GPU), each one falling back to CPU correctly per the code's existing design; the real success lines were buried under thousands of interleaved health-probe log lines from two pods. Confirmed success via direct `grep` filtering, not by reading raw logs top to bottom.
6. **Content-Type wrong after switching to CloudFront** — `application/octet-stream` instead of `application/vnd.apple.mpegurl`/`video/mp2t`, because Content-Type is S3 object metadata set at upload time, and `storage_manager.py` never set one. Fixed with a `guess_content_type()` helper (extension → MIME type map) applied as a default whenever the caller doesn't specify one — verified via `head-object` after a re-transcode, then a CloudFront invalidation to clear the previously-cached wrong headers.
7. **A real deployment-loop mistake, twice** — code changes (the Content-Type fix, later a Faro URL fix) were built and pushed to ECR, but the manifest's image tag was never bumped in git, so `git log` and ArgoCD both showed everything current/`Synced` while the *cluster* silently kept running the old image. This is the single most repeatable failure mode in this whole project: **a code change is always two commits — the new image, and the manifest pointing at it** — and it fails completely silently when the second one is skipped.
8. **Video played successfully even with the wrong browser-side proxy assumption** — confirmed via DevTools Network tab: `206 Partial Content`, correct range-request handling, playback worked. Separately noticed 31 console errors from `http://localhost/faro/collect` (Grafana Faro browser telemetry) — a hardcoded local-dev URL identical in nature to the original `VITE_API_BASE` bug from the very first deployment, just never caught this time until CDN work put a second set of eyes on the console.

### Faro (browser telemetry) — config built, not fully wired
Extended the existing Alloy config with a `faro.receiver` component (separate port 12347, CORS scoped to the CloudFront origin) forwarding to Loki (tagged `source=faro`) and, in principle, Tempo for traces (since the frontend also imports `TracingInstrumentation`) — but the nginx `/faro/` route and the frontend's `main.jsx` URL fix were never fully verified working together end-to-end before attention moved to the dashboard tool. Left explicitly paused, not broken.

### `/platform-status` and `/grafana` CloudFront routing — built, not fully verified
Added nginx `location` blocks in `frontend-ui/nginx.conf` proxying to `devops-dashboard-frontend` and `grafana` respectively. Hit the exact same class of bug on `/platform-status` as Faro did: Vite's default root-absolute asset paths (`/assets/...`) don't survive being nested behind a reverse-proxy subpath — the browser's request for the JS bundle fell through to the *outer* app's own SPA catch-all, returning HTML with a MIME-type error instead of the actual script. **Full three-part fix identified and built** (Vite `base: '/platform-status/'`, API calls prefixed via `import.meta.env.BASE_URL`, an nginx `rewrite` stripping the prefix before forwarding so the inner app never needs to know it's nested) — verified via a real build showing correctly-prefixed asset paths in the generated `index.html`, but the actual redeploy (new image tag + ConfigMap update + restart) was never completed; **user explicitly chose to keep using `kubectl port-forward` instead** rather than chase this further. Grafana's equivalent (`GF_SERVER_ROOT_URL`/`GF_SERVER_SERVE_FROM_SUB_PATH`) was configured but likewise never confirmed working end-to-end.

### Result
CDN genuinely live and delivering real value: HTTPS for free, edge caching on video segments, and — as an unplanned but genuine bonus — CloudFront's URL worked from the same corporate network whose firewall had blocked the raw ALB URL earlier in the project.

---

## Phase 10 — Account blocked, rebuilding on a new AWS account

**What happened:** the original AWS account (`025211337216`) got blocked. Reason not yet confirmed/diagnosed — worth finding out if it's something avoidable (e.g. a billing issue) before it recurs on the new account, but not blocking the rebuild itself.

**What this means practically:** every account-specific value baked into the manifests, images, and infrastructure across Phases 1-9 is now invalid and needs to be recreated fresh under the new account. **The actual content/logic of everything built so far remains valid and doesn't need to be redesigned** — Dockerfiles, K8s manifest structure and patterns, the bug fixes (VITE_API_BASE, client_max_body_size, HLS routing/token-injection, etc.), the ESO/ArgoCD setup approach — all of that thinking transfers directly. This is a re-provisioning exercise, not a redesign.

### Values that will need to change everywhere (new account)
- **ECR registry URLs** — every Deployment's `image:` field currently points at `025211337216.dkr.ecr.ap-south-1.amazonaws.com/...` — all 14 images need rebuilding and pushing to new ECR repos under the new account, then every manifest updated to the new registry URL
- **S3 bucket name** — `ott-media-raw-025211337216` includes the old account ID; new bucket needs a new globally-unique name
- **All IAM policy/role ARNs** — every `arn:aws:iam::025211337216:...` reference (S3 policy, Secrets Manager policy, ALB Controller policy, all IRSA roles) needs recreating under the new account
- **RDS/ElastiCache endpoints** — brand new instances, new endpoints, new connection strings, new Secrets Manager entries
- **VPC/subnet/security group IDs** — all new, since these are created fresh by `eksctl create cluster`
- **The ALB's public DNS name** — will be different once Ingress is rebuilt; `api-gateway`'s `ALLOWED_ORIGINS` will need updating again once known

### What transfers directly, no changes needed
- All application source code and Dockerfiles (including every bug fix from the post-deployment debugging session)
- The overall `k8s/` manifest structure and every YAML's *logic* (just needs the account-specific values above swapped in)
- The GitHub repo itself and its history — still valid, just needs updating rather than recreating
- The whole phased approach and every lesson learned (t3.small's 11-pod ceiling, the CRD annotation-size limit affecting both ESO and ArgoCD, the DaemonSet-pinning-vs-capacity interaction, etc.) — these will very likely recur on the new account too, so knowing about them in advance saves real time

### Status of in-flight work when the account was blocked
- **CDN (CloudFront) planning** — paused mid-discussion. Decision already made: CloudFront → S3 direct is not viable without a custom domain (browser same-site cookie restrictions prevent the app's backend from setting cookies CloudFront would ever see across two unrelated domains) — either a unified single-distribution-with-two-origins approach, or a custom domain, is needed. Not yet built.
- **GitOps (ArgoCD)** — was fully working (`Synced`) on the old account before it was blocked. Needs full reinstall on the new cluster; the same CRD annotation-size gotcha will likely recur (`kubectl apply --server-side` is the fix, already known).
- **Promtail zero-target investigation** — unresolved when the account was blocked. Confirmed so far: RBAC was correct, the config matched a known-good hash, the pod was healthy (not crash-looping, `Restart Count: 0`), yet `/targets` showed `0/0` even after restoring the correct `kubernetes_sd_configs` block. Debug-level logging (`log_level: debug`) was enabled to investigate further but results were never captured before the account was blocked. **Worth re-testing fresh on the new cluster before assuming the same bug exists** — it's possible this was environment-specific (e.g., something about that particular cluster's API server or CNI setup) rather than a config problem that will necessarily recur.

### Immediate next steps (in progress)
1. Confirm `aws sts get-caller-identity` shows the new account, not the old blocked one
2. Confirm the new cluster (`eksctl create cluster`) has finished provisioning
3. Point `kubectl` at the new cluster via `aws eks update-kubeconfig`
4. Work back through Phases 1-9 in order, substituting new account-specific values, using this runbook as the primary reference to move faster than the first time through

### Session update — new account confirmed as `723300665462`

**Discovered via direct AWS/Kubernetes inspection (an AWS API MCP connector and a Kubernetes MCP connector were both available and used for read-only discovery, at the user's explicit direction — used only for checking/debugging, not for doing the build work itself, per the user's stated preference to do the hands-on work themselves):**

Far more had already been provisioned than initially assumed. Confirmed already existing on the new account before this session's active debugging began:
- EKS cluster `myflix-eks` — `ACTIVE`, v1.34, 5 nodes all `Ready`
- RDS `myflix-postgres` — `available`
- ElastiCache `myflix-redis` — `available`
- S3 bucket `723300665462-ott-media`
- All 14 ECR repos, with at least `auth-service:v1` already pushed
- All 3 IAM policies (`MyFlixS3MediaAccess`, `MyFlixSecretsRead`, `AWSLoadBalancerControllerIAMPolicy`)
- ESO (`external-secrets` namespace) — all 3 pods `Running`
- ALB Controller — both pods `Running`
- EBS CSI driver — controller + all node pods `Running`
- `myflix` namespace applied, most application Deployments already applied via plain `kubectl` (not yet via ArgoCD — `argocd` namespace didn't exist yet)

**What was actually broken when this session started digging in:**
- 8 database-dependent services (`auth`, `analytics`, `interaction`, `metadata`, `recommendation`, `subscription`, `user`, `watchhistory`) — all `CrashLoopBackOff`
- Entire observability stack (Prometheus, Alertmanager, Loki, Tempo, Grafana, all 5 Promtail pods) — all `ImagePullBackOff`
- `media-library-service` — `FailedCreate`, zero pods ever attempted
- `payment-service` — `CreateContainerConfigError` (already-known Razorpay issue, unrelated to the rebuild)

### Bug found and fixed: RDS/Secrets Manager/K8s Secret password mismatch across all 3 layers
The 8 crash-looping services all failed identically: `password authentication failed for user "myflix_admin" (SQLSTATE 28P01)`. Root cause, in the end, was that **three independent places all had to agree on the same password, and none of them did**:
1. The actual RDS instance's `myflix_admin` user password (set once at creation, easy to lose track of)
2. The `myflix/database-url` secret in AWS Secrets Manager
3. The `myflix-database-secret` Kubernetes Secret that ESO syncs from #2

**A real mistake made along the way, worth flagging so it isn't repeated:** the first fix attempt updated the Secrets Manager value (#2) to point at the hostname from the *old, blocked account's* RDS instance (copied from this very runbook's Phase 3 section without noticing it was stale) — this made things temporarily worse, not better, since it pointed at an endpoint that may not even exist anymore. Also, updating Secrets Manager (#2) alone does **not** change the real database password (#1) — those are completely independent actions that both have to happen and agree.

**Fix, done properly:**
```bash
# 1. Actually change the real RDS password
aws rds modify-db-instance --db-instance-identifier myflix-postgres \
  --master-user-password '<password>' --apply-immediately --region ap-south-1
# wait for DBInstanceStatus to return to "available" before proceeding

# 2. Update Secrets Manager with the matching password AND the correct
#    (new account's) RDS endpoint
aws secretsmanager update-secret --secret-id myflix/database-url \
  --secret-string "postgres://myflix_admin:<password>@myflix-postgres.c9gscaua6mvs.ap-south-1.rds.amazonaws.com:5432/myflix?sslmode=require" \
  --region ap-south-1

# 3. Force ESO to resync (its refreshInterval won't pick this up for up to
#    an hour on its own — same behavior as the original build)
kubectl delete secret myflix-database-secret -n myflix
# confirm it regenerates with the NEW value before restarting anything:
kubectl get secret myflix-database-secret -n myflix -o jsonpath="{.data.DATABASE_URL}"

# 4. Only then restart the affected deployments
kubectl rollout restart deployment/auth-service -n myflix
```
**Lesson reinforced:** verify each of the 3 layers independently before assuming a fix worked — this was caught partway through specifically because the K8s Secret was checked directly and found to still contain a third, different stale password, rather than assuming the update had propagated.

### Bug found and fixed: missing IRSA ServiceAccount for media-library-service
`media-library-service`'s Deployment showed `FailedCreate` with the ReplicaSet creating zero pods — no crash, a complete failure to even attempt pod creation. Root cause: its `serviceAccountName: media-library-service` reference pointed at a ServiceAccount that was never actually created on this new cluster. **Important to understand why this happens:** applying a Deployment YAML that references a ServiceAccount by name does *not* create that ServiceAccount — `eksctl create iamserviceaccount` is a completely separate, one-off CLI command (from Phase 4) that has to be re-run explicitly per cluster; it's easy to do for one of the two IRSA-needing services (`transcoding-service`, which worked fine) and simply forget the other.
```bash
eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name media-library-service --attach-policy-arn arn:aws:iam::723300665462:policy/MyFlixS3MediaAccess --approve
```
Confirmed working afterward via the same jsonpath check used throughout the original build (`serviceAccountName` prints `media-library-service`, not `default`).

**Only two services in the whole 14 ever need this IRSA treatment** — `transcoding-service` and `media-library-service` — since they're the only two that talk directly to AWS APIs (S3). Every other service only ever talks to RDS/Redis via plain connection strings, no IAM/AWS auth involved, so they correctly run under the plain `default` ServiceAccount.

### False alarm, ruled out: ALB "ERR_TIMED_OUT" was a local network restriction, not a deployment problem
The ALB's public DNS name timed out in-browser. Methodically ruled out, in order: target group health (`healthy`), node security group rules (correctly allows the ALB's security group in on port 80 — the ALB Controller's own auto-managed rule), the ALB's own state (`active`), and DNS resolution (resolved to real AWS IPs). The user's `nslookup` revealed an internal corporate DNS server (`sun-dc03.sunnetwork.in`), strongly suggesting a corporate network — the actual, unconfirmed-but-likely cause is a corporate firewall blocking the outbound connection, unrelated to anything built. **Worth remembering as a diagnostic pattern:** when every AWS-side check passes cleanly but a browser still can't connect, suspect the network the browser is *on*, not the infrastructure — testing from an unrestricted network (mobile data, home Wi-Fi) is the fastest way to confirm this class of issue.

### Observability stack — resolved without further action
All `ImagePullBackOff` pods (Prometheus, Alertmanager, Loki, Tempo, Grafana, Promtail) recovered to `Running` on their own between check-ins, with no manifest changes made. Consistent with the original build's suspicion that these images (pulled from public Docker Hub, unlike every other service's ECR-hosted image) are subject to Docker Hub's anonymous-pull rate limiting, shared across all nodes via the single NAT gateway IP — and that this is transient, self-resolving pressure rather than a permanent block. Not fully confirmed as the definitive cause, just consistent with it resolving without intervention.

### Current state (this session)
13 of 14 services `Running`. `payment-service` left parked, same known issue as the original build. **ArgoCD reinstalled and re-synced successfully** — see below. CDN work remains paused at the same decision point as before the account was blocked.

### ArgoCD reinstall on the new cluster
Same install command as the original build, `--server-side` from the start this time (no need to rediscover the CRD-size issue):
```bash
kubectl create namespace argocd
kubectl apply --server-side -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**Hit the same node-capacity ceiling as everything else in this project.** 3 pods (`argocd-server`, `argocd-application-controller`, one `dex-server` replica) stuck `Pending` for 19+ hours with `"5 Too many pods"` across all 5 nodes simultaneously — the identical `t3.small` 11-pod ceiling from Phase 7's Promtail DaemonSet saga, just hitting ArgoCD this time instead. Checked whether this new account allowed larger instance types (it would have been the real, permanent fix) but it didn't — added one more node instead:
```bash
eksctl scale nodegroup --cluster myflix-eks --region ap-south-1 --name myflix-workers --nodes 6 --nodes-min 2 --nodes-max 7
```
All 3 stuck pods scheduled automatically once the new node joined, no manual nudge needed.

**Bonus diagnostic insight worth remembering:** `dex-server`'s separate-looking crash (`"server.secretkey is missing"`, 798 restarts) turned out to be a **downstream symptom of the capacity issue, not an independent bug**. That secret key is generated by `argocd-server` on its first successful boot — since `argocd-server` had never once been able to schedule, the key never existed, so `dex-server` failed every single time it tried to start. Resolved on its own once `argocd-server` could finally run. Worth remembering as a pattern: a crash loop that seems unrelated to a scheduling problem elsewhere in the same namespace is worth checking for a dependency relationship before assuming it's a second, separate bug.

**Application re-applied cleanly, first try** — no repeat of the original build's `include`/`exclude` CRD-parsing issue or the duplicate-ConfigMap problem (both explicitly re-checked and confirmed clean before syncing):
```bash
kubectl apply -f argocd-application.yaml
kubectl get application myflix -n argocd
# NAME     SYNC STATUS   HEALTH STATUS
# myflix   Synced        Degraded   ← Degraded is payment-service, expected
```

---

## Phase 11 — Promtail's zero-target bug: root cause found, resolved by migrating to Grafana Alloy

**Background:** the Promtail `/targets` showing `0/0` bug was first hit late in the original build (Phase 7 era) and never resolved before the account was blocked — at the time, it was genuinely unclear whether this was a config problem, an RBAC problem, or something specific to that one cluster. This phase settles it definitively.

### Re-confirmed broken on a completely fresh cluster
On the rebuilt cluster (new account, new cluster, new everything), Promtail's `/targets` page showed `0/0` again — **this rules out "old cluster was just weird" as an explanation.** Same bug, reproducible from scratch.

### Systematic elimination, this time thorough enough to actually conclude something
1. **RBAC re-verified from scratch** (new `ClusterRole`/`ClusterRoleBinding`/`ServiceAccount`, not transferred from the old cluster) — `kubectl auth can-i list pods --as=system:serviceaccount:myflix:promtail --all-namespaces` → `yes`. Ruled out, a second time, on a second cluster.
2. **A red herring found and cleared first:** the live `/config` page showed a broken `selectors: {field: spec.nodeName=<pod-name>}` block — the exact same mistake from the old account's investigation. Initially looked like the fix had never made it into git, but `grep` against the actual repo file confirmed **git was clean** — the live ConfigMap object also matched git exactly. The stale `selectors` block was being served by a Promtail process that simply hadn't reloaded since an earlier point — a `kubectl rollout restart daemonset/promtail` alone didn't change the outcome (still `0/0` afterward), which is what elevated this from "probably the same old bug" to "something more fundamental."
3. **Debug-level logs, examined properly this time** (the old account's investigation enabled `log_level: debug` but the account was blocked before results could be captured). On a confirmed-clean config, freshly restarted pod: the Kubernetes discovery provider logs `"Starting provider" provider=kubernetes/0` — **and then nothing else, ever.** No watch events, no sync confirmation, no error. The only other log lines were HTTP access logs for manual `/targets` page requests. A genuinely running discovery loop, even one legitimately finding zero pods, should produce more activity than this at debug level.

### Conclusion: Promtail 3.6.8 vs. Kubernetes v1.34 API incompatibility
With RBAC and config both eliminated twice, across two independent AWS accounts and two independent clusters, and debug logs showing the discovery provider going silent immediately after starting (not erroring, not finding zero — just never doing anything), the most likely explanation is a **version-compatibility issue**: Promtail has been in Grafana's maintenance-only phase for a while, and its `client-go`-based discovery mechanism may not correctly negotiate against a Kubernetes v1.34 API server — silently, rather than with a visible error.

**Decision: stop debugging Promtail, migrate log shipping to Grafana Alloy** (Grafana's actively-developed replacement) rather than continue open-ended troubleshooting with four rounds of identical results already behind it.

### Alloy migration — implementation
Genuine architectural improvement came along with the fix, not just a swap:

- **`loki.source.kubernetes` reads logs via the Kubernetes API's log endpoint** (`/api/v1/namespaces/<ns>/pods/<pod>/log` — the same mechanism `kubectl logs` uses), not a `hostPath` mount + local file parsing like Promtail. The API server itself proxies the request to whichever node actually hosts the pod — Alloy never needs direct node-local filesystem access.
- **This means Alloy runs as a `Deployment`, not a `DaemonSet`** — one replica (from any single node) can see logs from every pod across the entire cluster, since discovery and log-fetching both go through the central API server, not local disk. This directly reduces the pod-count pressure that caused real scheduling trouble twice already in this project (Phase 7's Promtail DaemonSet-pinning saga, and Phase 10's ArgoCD capacity issue) — 1 pod instead of 6.
- **No `cri: {}` parsing stage needed** (unlike Promtail's config) — the Kubernetes API returns clean log lines directly, not containerd's raw wrapped file format that needed unwrapping.
- Same label scheme preserved (`namespace`, `pod`, `container`, plus `labelmap` for all pod labels including `app`) — existing Grafana queries like `{app="frontend-ui"}` continue to work unchanged.

```yaml
# eks/configmaps/alloy-config.yaml — key components
discovery.kubernetes "pods" { role = "pod" }
discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets
  # ... namespace/pod/container/labelmap/__host__ rules, same as Promtail's relabel_configs
}
loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.write.default.receiver]
}
loki.write "default" {
  endpoint { url = "http://loki:3100/loki/api/v1/push" }
}
```

**New RBAC requirement, not needed by Promtail:** reading log content via the Kubernetes API's `/log` subresource needs its own explicit permission, separate from just listing/watching pod objects:
```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "watch", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

**Verification approach:** applied directly via `kubectl` first (not through ArgoCD), specifically because the `.alloy` config syntax was constructed from Alloy's documented component model without the ability to test it live beforehand — deliberately avoided committing untested config straight to git. Confirmed working (Alloy's own UI at `:12345` showed real discovered targets, and a direct Loki query against `{namespace="myflix"}` returned real log entries, not `"result":[]`) before committing to the repo and removing Promtail's DaemonSet/ServiceAccount/ClusterRole/ClusterRoleBinding entirely.

### Result
Logging pipeline fully restored — confirmed via direct Loki query returning real data, not just "pods are Running." Pod count reduced by 5 (6 Promtail DaemonSet pods → 1 Alloy Deployment pod), meaningfully easing the recurring node-capacity pressure this project has hit repeatedly.

---

## Phase 9 — GitOps (ArgoCD)

**Why now, why this order:** deliberately done *before* the CDN work, so the whole existing cluster state comes under git management first — avoids drift between "what's manually deployed for CDN" and "what git says should be running" right at the moment git becomes the source of truth.

**Decisions made:** ArgoCD (not Flux) for its web UI, matching a visual/learning-friendly workflow. Manual sync (not automated) to start — review the diff, click Sync yourself, rather than every git push immediately applying live. Repo: `https://github.com/thirumaalt/OTT_Project_Golang_EKS.git`, `eks/` directory, `main` branch — already existed before this phase, pushed independently.

### Install
```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**Gotcha — same CRD annotation-size limit as ESO in Phase 5.** The `applicationset-controller` pod crash-looped with `no matches for kind "ApplicationSet"` — its own CRD never actually registered. Root cause identical to the ESO issue: ArgoCD's CRDs are large enough that plain `kubectl apply` silently fails against the 262,144-byte `last-applied-configuration` annotation limit. Same fix:
```bash
kubectl apply --server-side -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```
Confirmed via `kubectl get crd | grep argoproj` before and after — all pods reached `1/1 Running` once the CRDs were actually present.

### Application manifest
```yaml
# argocd-application.yaml — applied directly via kubectl, deliberately
# kept OUTSIDE the eks/ folder ArgoCD watches (avoids the app managing
# its own definition — a real mistake caught and fixed, see below)
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
      include: "*.yaml"
      exclude: "cluster.yaml"
  destination:
    server: https://kubernetes.default.svc
    namespace: myflix
  syncPolicy: {}   # empty — no "automated:" block means manual sync only
```

### Gotchas found while wiring this up — worth reading before touching the repo again

**1. Non-manifest files mixed into the watched `eks/` folder caused a `ComparisonError`.** The raw AWS IAM policy JSON (`iam-policy-latest.json`, from Phases 4-6) and `cluster.yaml` (`eksctl`'s own client-side `ClusterConfig` format — never installed as a real CRD, so not something ArgoCD can ever apply) both live inside `eks/`. ArgoCD's directory mode tries to parse every file it finds as a K8s object.
- First attempt: `exclude: "*.json,cluster.yaml"` — confirmed correctly stored on the live object via `kubectl get application ... -o jsonpath`, but **did not actually stop the error**, even after a genuinely fresh comparison (confirmed via a changed `lastTransitionTime`, ruling out stale cache).
- **Working fix:** switched to `include: "*.yaml"` (only ever scan yaml files — more robust than trying to exclude every possible non-manifest file type) **combined with** `exclude: "cluster.yaml"` (since `cluster.yaml` is itself a `.yaml` file and `include` alone wouldn't stop it). Both filters together resolved it.
- **Diagnostic technique worth keeping:** `kubectl delete application myflix -n argocd && kubectl apply -f argocd-application.yaml` is a reliable way to force a fully fresh comparison when in doubt about stale state — simpler than fighting `kubectl patch`'s JSON-escaping quirks in PowerShell (a `--type merge -p '{...}'` patch attempt failed with a quoting error and was abandoned in favor of delete+recreate).

**2. A stale duplicate ConfigMap was caught before it could cause silent damage.** `configmaps/nginx-config.yaml` and `configmaps/frontend-ui-nginx-configmap.yaml` both defined the same object (`frontend-ui-nginx-conf`) with **different content** — the former was missing the `client_max_body_size 2048m;` fix from the post-deployment bug-fixing session. Confirmed via direct `grep`/`diff` before syncing anything. **This is exactly the "ArgoCD reverts a real fix because git is stale/inconsistent" risk flagged before ever running a sync** — caught in the diff-review step specifically because that step wasn't skipped. Fixed by deleting the stale duplicate from the repo (`git rm`) and re-pushing.

**3. `argocd-application.yaml` was initially committed inside the watched `eks/` folder** — meaning the app would have been managing its own definition (self-referential, not fatal but messy). Moved out via `git mv` to the repo root.

### Verified working
```bash
kubectl get application myflix -n argocd
NAME     SYNC STATUS   HEALTH STATUS
myflix   Synced        Degraded
```
`Synced` confirms the repo matches live cluster state exactly — critically, the Phase 8 resource/probe/HPA tuning and the `client_max_body_size` fix were **not** reverted, meaning the repo was genuinely current by the time the first real sync happened. `Degraded` health is expected and correct — ArgoCD accurately surfacing the same pre-existing `payment-service` issue from Phase 5 (Open Items #1), not something GitOps caused. Good confirmation that ArgoCD's health aggregation works as intended.

### Not yet done
- [ ] CDN (CloudFront) — planned next. Decision made: CloudFront → S3 directly via Origin Access Control (best performance), which requires **replacing** the current JWT-in-query-param HLS auth scheme with **CloudFront signed cookies** (not signed URLs — cookies avoid needing to sign every nested playlist/segment reference individually, which is exactly the class of problem solved manually in Bug 5's playlist-rewrite logic; that logic could eventually be removed once this migration happens). No custom domain — using default `*.cloudfront.net`.
- [ ] Consider bringing ArgoCD itself, and/or the Helm-installed cluster add-ons (ESO controller, ALB Controller, metrics-server), under GitOps management too (the "app of apps" pattern) — currently only the `eks/` app-manifest folder is managed this way; underlying infra add-ons remain installed imperatively via Helm/eksctl, outside GitOps scope for now.
- [ ] No sync-wave/ordering annotations exist yet — fine today since this was an *adoption* of already-running resources, but would matter if the cluster were ever destroyed and rebuilt fresh from git alone (namespace/secrets/storageclass would need to apply before things that depend on them).

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
  --bucket ott-media-raw-025211337216 \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-public-access-block \
  --bucket ott-media-raw-025211337216 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --region ap-south-1
```
Bucket name includes the account ID for global uniqueness. Single-bucket design confirmed in code — raw and transcoded output separated by S3 key prefix, not separate buckets.

### IAM policy
```bash
aws iam create-policy --policy-name MyFlixS3MediaAccess --policy-document file://s3-media-policy.json
# → arn:aws:iam::025211337216:policy/MyFlixS3MediaAccess
```
Object-level actions (`GetObject`/`PutObject`/`DeleteObject`) scoped to `.../ott-media-raw-025211337216/*`; bucket-level action (`ListBucket`) scoped to the bucket ARN without `/*`.

### IRSA service accounts (one per service, not shared)
```bash
eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name transcoding-service --attach-policy-arn arn:aws:iam::025211337216:policy/MyFlixS3MediaAccess --approve

eksctl create iamserviceaccount --cluster myflix-eks --region ap-south-1 --namespace myflix \
  --name media-library-service --attach-policy-arn arn:aws:iam::025211337216:policy/MyFlixS3MediaAccess --approve
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
# → arn:aws:iam::025211337216:policy/MyFlixSecretsRead
```
`secretsmanager:GetSecretValue` only, scoped to `arn:aws:secretsmanager:ap-south-1:025211337216:secret:myflix/*`.

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
  --name eso-secrets-reader --attach-policy-arn arn:aws:iam::025211337216:policy/MyFlixSecretsRead --approve
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
  --name aws-load-balancer-controller --attach-policy-arn arn:aws:iam::025211337216:policy/AWSLoadBalancerControllerIAMPolicy --approve
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
  --policy-arn arn:aws:iam::025211337216:policy/AWSLoadBalancerControllerIAMPolicy \
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

1. **`payment-service` intentionally parked** — real Razorpay credentials aren't available right now (not a technical blocker; the `myflix-razorpay-secret` `SecretSyncedError` was never root-caused, but the actual blocker is simply not having real API keys to put in it yet). Revisit once credentials are available: `kubectl describe externalsecret myflix-razorpay-secret -n myflix` to pick up the sync debugging where it left off.
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
13. **HLS content served via CloudFront has no auth at all** — OAC-only, signed cookies explicitly declined (see Phase 12). Anyone with a URL can stream it, no login, no expiry. Fine for test content, a real gap if this ever serves anything sensitive.
14. **`/platform-status` and `/grafana` CloudFront routes are built but not live** — the full fix (Vite `base` path, `BASE_URL`-prefixed API calls, an nginx prefix-stripping rewrite) exists and was verified via a real build, but the actual redeploy was never completed. User is using `kubectl port-forward` instead in the meantime.
15. **Faro (frontend browser telemetry) is configured but not wired up** — Alloy's `faro.receiver` component exists, the frontend's hardcoded `localhost` URL was fixed to a relative path, but the nginx `/faro/` route was never confirmed working end-to-end.
16. **Grafana's default admin password still hasn't been changed** — now genuinely more pressing than before, since exposing it via CloudFront (item 14, whenever that gets finished) would make the default `admin`/`admin` a real public login, not just a theoretical risk.
17. **`devops-dashboard-service`'s write-action features are deferred** — a restart button and a CloudFront invalidation button were scoped but not built, pending new RBAC/IAM grants beyond the current read-only permission set.
18. **`devops-dashboard-service` has no auth in front of it either** — same posture as Grafana (port-forward only), but arguably higher stakes, since it can trigger real git commits via its Deploy tab.
