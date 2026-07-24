# CI/CD — myflix OTT Platform

Monorepo CI for 14 buildable services (11 Go, 2 Vite frontends, 1 Python).
Two pipelines are provided; they share the same registry (`thiru98`) and image
naming (`thiru98/<service>`), so you can run either or both.

| File | What it does |
|------|--------------|
| `.github/workflows/ci.yml` | GitHub Actions — path-filtered matrix build, Trivy, SonarQube, push |
| `Jenkinsfile` (root) | Monorepo Jenkins pipeline — same stages, parameterized |
| `sonar-project.properties` | Repo-level SonarQube config |
| `.golangci.yml` | Lint baseline for the Go services |

## Pipeline behavior

**Only changed services build.** A push that touches `auth-service/` builds and
scans just `auth-service` — not all 14.

- **Pull request → `main`**: build + `go vet`/`go build` + golangci-lint + Trivy. No push.
- **Push to `main`**: same, then push `thiru98/<service>:<short-sha>` and `:v1` to Docker Hub.
- **Manual full rebuild**: Actions tab → *Run workflow* → `build_all = true`.

Images are tagged with the **short commit SHA** (immutable — ideal for the ArgoCD
phase) and `latest`.

## Required GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `DOCKERHUB_USERNAME` | `thiru98` |
| `DOCKERHUB_TOKEN` | Docker Hub access token (not your password) |
| `SONAR_TOKEN` | SonarQube/SonarCloud token |
| `SONAR_HOST_URL` | e.g. `https://sonarcloud.io` or your self-hosted URL |

> Using **SonarCloud**? Uncomment `sonar.organization` in `sonar-project.properties`
> and swap the action in `ci.yml` for `SonarSource/sonarcloud-github-action`.

## Required Jenkins credentials

| ID | Type | Value |
|----|------|-------|
| `docker-hub-creds` | Username/password | Docker Hub login |
| `sonar-token` | Secret text | Sonar token |

Run with `SERVICES=changed` (default), `all`, or an explicit list like
`auth-service,user-service`. Toggle `RUN_SECURITY_SCAN`, `RUN_SONAR`,
`PUSH_TO_REGISTRY` as needed.

## Sensible defaults you may want to flip later

- **golangci-lint** runs as *informational* (`continue-on-error: true`). Once the
  Go code is lint-clean, set it to `false` to enforce.
- **Trivy** reports but does not fail the build (`TRIVY_EXIT_CODE: "0"`). Set to
  `"1"` to block on HIGH/CRITICAL.
- **Registry**: `DOCKERFILE: Dockerfile` builds the Docker Hub (scratch) image.
  Set it to `Dockerfile.eks` to build the distroless ECR image when you move to EKS.

## One-time cleanup

The 27 MB `api-gateway/api-gateway.exe` was committed before `.gitignore` caught it.
If it's still tracked, drop it from history-going-forward with:

```bash
git rm --cached api-gateway/api-gateway.exe
git commit -m "chore: stop tracking built binary"
```

---

## Phase 2 — Helm + ArgoCD (next)

The current pipeline pushes images. Phase 2 makes deployment GitOps-driven:

1. **Helm chart** — collapse the 14 near-identical manifests in `k8s/services/`
   into one reusable chart (`charts/service/`) plus a per-service `values.yaml`
   (image, port, env, resources, HPA). This kills the copy-paste and makes the
   image tag a single value ArgoCD can bump.
2. **CI writes the tag** — on a successful `main` build, the pipeline updates the
   service's `values.yaml` image tag to the new short SHA and commits it (to this
   repo or a separate `*-gitops` repo).
3. **ArgoCD** — an `Application` (or `ApplicationSet` over the 14 services) watches
   the chart path and syncs the cluster to match git. Push code → image builds →
   tag commit → ArgoCD deploys. No `kubectl apply` by hand.

I can build the Helm chart + ArgoCD `ApplicationSet` whenever you're ready.
