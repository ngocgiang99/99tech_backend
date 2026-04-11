# Infrastructure Templates — 99tech problem6 scoreboard

**⚠️ These are TEMPLATES. Operators MUST customize before applying.**

The _shape_ of these templates (3 replicas, sticky sessions on `/v1/leaderboard/stream`, PDB `minAvailable=2`, liveness/readiness probes) is the contract; the _values_ (registry, domain, secrets, resource quotas) are placeholders.

---

## Contents

| Directory | Purpose |
|-----------|---------|
| [`helm/`](./helm/) | Helm chart — Chart.yaml, values.yaml, templates |
| [`k8s/`](./k8s/) | Standalone Kubernetes manifests (no Helm) |
| [`terraform/`](./terraform/) | Terraform scaffold using the `hashicorp/kubernetes` provider |

---

## Before applying

Work through this checklist before running `helm install` / `kubectl apply` / `terraform apply`:

- [ ] **Replace image registry** — update `image.repository` (Helm), `image:` field (k8s), or `var.image_repository` (Terraform) with your actual registry and image name
- [ ] **Set ingress host** — replace `scoreboard.example.com` with your actual domain in `values.yaml`, `k8s/ingress.yaml`, or `terraform/variables.tf`
- [ ] **Populate secrets** — do NOT commit real values; inject `INTERNAL_JWT_SECRET`, `ACTION_TOKEN_SECRET`, `ACTION_TOKEN_SECRET_PREV` via your secret manager (External Secrets Operator, Sealed Secrets, AWS Secrets Manager, GCP Secret Manager, etc.)
- [ ] **Set env vars** — review all `TODO` comments in `configmap.yaml` / `values.yaml`: `DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` must point to real services
- [ ] **Adjust resources** — tune `cpu`/`memory` requests and limits to match your node class and observed load
- [ ] **Set replicaCount** — default is 3 (matches PDB `minAvailable=2`); do not drop below 3 without adjusting the PDB
- [ ] **NATS replicas** — set `NATS_STREAM_REPLICAS` to 3 in a production NATS cluster (default is 1 for local dev)
- [ ] **Namespace** — create the target namespace before applying; Terraform uses `var.namespace` (default: `scoreboard`)

---

## Publishing the image

### Step 1 — Build and validate locally

```bash
# From the problem6/ directory

# Build (uses ESM webpack bundle; requires docker buildx / BuildKit)
mise run docker:build
# → tags as problem6/scoreboard-api:dev

# Start the infra (Postgres, Redis, NATS) if not already running
mise run infra:up

# Run the container against the compose network and validate
mise run docker:run &   # or run detached; see Task 9.2 notes

# Verify health (container port 3000; adjust host port if occupied)
curl http://localhost:3000/health          # → 200 {"status":"ok"}

# Verify non-root user
docker exec problem6-api whoami            # → app
```

### Step 2 — Tag for release

Once the `dev` image passes the health check, tag it for the release candidate:

```bash
docker tag problem6/scoreboard-api:dev problem6/scoreboard-api:v1.0.0-rc1
```

### Step 3 — Retag for your registry and push

> **⚠️ IMPORTANT**: Replace `your-registry.example.com/problem6` with your actual
> registry URL. This can be an AWS ECR repository, GCP Artifact Registry, Docker Hub
> org, GitHub Container Registry (`ghcr.io`), JFrog Artifactory, etc.
> **Do NOT push to a public registry without reviewing the image for secrets.**

```bash
# Re-tag for your private registry
docker tag problem6/scoreboard-api:v1.0.0-rc1 \
    your-registry.example.com/problem6/scoreboard-api:v1.0.0-rc1

# (Optional) Also push a 'latest' alias
docker tag problem6/scoreboard-api:v1.0.0-rc1 \
    your-registry.example.com/problem6/scoreboard-api:latest

# Authenticate to your registry first (example for ECR):
# aws ecr get-login-password --region us-east-1 | \
#     docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

# Push
docker push your-registry.example.com/problem6/scoreboard-api:v1.0.0-rc1
```

After pushing, update the `image.repository` / `image.tag` values in `helm/values.yaml`,
`k8s/*.yaml`, or `terraform/variables.tf` to point to your registry URL and tag.

---

## Deploying with Helm

```bash
# Install
helm install scoreboard ./infra/helm \
  --namespace scoreboard --create-namespace \
  --set image.repository=your-registry/problem6-scoreboard-api \
  --set ingress.host=scoreboard.yourdomain.com

# Upgrade
helm upgrade scoreboard ./infra/helm \
  --namespace scoreboard \
  --set image.tag=v1.0.1
```

---

## Deploying with kubectl (standalone manifests)

```bash
# Edit k8s/*.yaml to replace TODO values first, then:
kubectl apply -f infra/k8s/ -n scoreboard
```

---

## Deploying with Terraform

```bash
cd infra/terraform

# Create values.tfvars with your cluster-specific values (not committed)
cat > values.tfvars <<EOF
image_repository = "your-registry/problem6-scoreboard-api"
image_tag        = "v1.0.0-rc1"
namespace        = "scoreboard"
ingress_host     = "scoreboard.yourdomain.com"
EOF

terraform init
terraform plan -var-file=values.tfvars
terraform apply -var-file=values.tfvars
```

---

## What's INCLUDED

| Feature | Detail |
|---------|--------|
| **3-replica Deployment** | Matches PDB `minAvailable=2`; survives one voluntary disruption |
| **ClusterIP Service** | Internal cluster access on port 3000 |
| **nginx Ingress with sticky sessions** | Cookie affinity on `/v1/leaderboard/stream`; `proxy-read-timeout: 3600` + `proxy-buffering: off` for SSE |
| **ConfigMap** | All non-secret env vars from `src/config/schema.ts` |
| **Secret (stub)** | Slot for `INTERNAL_JWT_SECRET`, `ACTION_TOKEN_SECRET`, `ACTION_TOKEN_SECRET_PREV` |
| **PodDisruptionBudget** | `minAvailable: 2` — safe rolling updates and node drain |
| **Liveness probe** | `GET /health` — fails only on process crash |
| **Readiness probe** | `GET /ready` — fails if Postgres/Redis/NATS are down or leaderboard rebuilding |

---

## What's NOT included

These are deliberate operator choices — they depend on your platform and are out of scope for this assignment:

- **cert-manager / TLS** — bring your own certificate provisioning
- **External Secrets Operator / Sealed Secrets** — bring your own secret management
- **HPA / KEDA** — horizontal autoscaling (depends on your metrics stack)
- **Prometheus Operator / ServiceMonitor** — the app exposes `/metrics` in Prometheus text format; wiring it into your Prometheus instance is operator responsibility
- **Service mesh (Istio / Linkerd)** — mTLS, traffic policies, observability sidecars
- **RBAC / NetworkPolicies** — cluster-level access control
- **Managed service migration guides** — RDS, ElastiCache, Confluent, etc.
