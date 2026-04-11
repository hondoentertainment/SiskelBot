# SiskelBot on GCP (Cloud Run)

Terraform module for deploying SiskelBot to Google Cloud Platform as a Cloud Run v2 service, with optional Cloud SQL PostgreSQL, Memorystore Redis, and a global HTTPS load balancer protected by Cloud Armor.

## Architecture

```
Internet
   |
   v
Global HTTPS Load Balancer (optional)
   |  +-- Managed SSL cert (domain_name)
   |  +-- Cloud Armor (XSS/SQLi + rate limit)
   v
Cloud Run v2 service  (serverless, auto-scaling)
   |  +-- Runtime service account + Secret Manager access
   |  +-- VPC connector (if private resources enabled)
   v
+--> Cloud SQL PostgreSQL (optional, private IP via VPC peering)
+--> Memorystore Redis (optional, private service access)
+--> Secret Manager (API keys, session secret, connection strings)
+--> Cloud Logging (dedicated log bucket with retention)
```

## Prerequisites

- A GCP project with billing enabled.
- `gcloud auth application-default login` or a service account with sufficient rights (`roles/owner` for first apply, or a scoped set).
- Required APIs are enabled automatically by the module.

## Quick start

```bash
cd terraform/gcp

cat > terraform.tfvars <<EOF
project_id      = "my-gcp-project"
region          = "us-central1"
environment     = "prod"
container_image = "gcr.io/my-gcp-project/siskelbot:latest"

min_instances = 1
max_instances = 10

enable_postgres = true
enable_redis    = true

enable_load_balancer = true
domain_name          = "chat.example.com"

api_key        = "replace-me"
admin_api_key  = "replace-me"
session_secret = "replace-me-long-random"
openai_api_key = "sk-..."
EOF

terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

After apply, point your DNS `A` record for `chat.example.com` at `load_balancer_ip`.

## Optional components

| Feature | Variable | Effect |
|---------|----------|--------|
| Cloud SQL PostgreSQL | `enable_postgres = true` | Provisions private Postgres + injects `DATABASE_URL` |
| Memorystore Redis | `enable_redis = true` | Provisions Basic Redis + injects `REDIS_URL` |
| HTTPS LB + WAF | `enable_load_balancer = true` | Global LB, Cloud Armor rules, managed SSL cert |
| Custom domain | `domain_name = "..."` | Managed SSL for the LB |

When `enable_postgres` or `enable_redis` is true, the module provisions a dedicated VPC, Serverless VPC Access connector, and private services networking peering.

## Cost estimate (approximate, us-central1)

| Component | Cost per month |
|-----------|---------------|
| Cloud Run (2 min, 1 vCPU/1 GiB, light traffic) | $0 - $25 |
| Cloud SQL db-f1-micro (optional) | ~$10 |
| Memorystore Basic 1 GB (optional) | ~$35 |
| VPC Access connector | ~$10 |
| Global load balancer (optional) | ~$18 |
| Cloud Armor (optional) | $5 + $0.75 per rule |
| Secret Manager | ~$0.30 |
| **Minimum (Cloud Run only)** | **~$0 - $25** |
| **Full stack** | **~$85 - $110** |

Cloud Run scales to near-zero (cost = $0) when `min_instances = 0`, ideal for dev.

## Security considerations

- Cloud Run uses a dedicated runtime service account with `roles/secretmanager.secretAccessor` scoped to the SiskelBot secrets only, plus logs + metrics + trace writer.
- When `enable_load_balancer = true`, the Cloud Run service ingress is set to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, so it can only be reached via the LB (Cloud Armor is the only entry point).
- Cloud Armor preconfigured XSS and SQLi rules + per-IP rate limit at 600 req/min.
- Cloud SQL and Memorystore use private IPs via VPC service peering; no public endpoints.
- Protect your Terraform state backend (GCS bucket with versioning + IAM).
- Rotate secrets by updating `terraform.tfvars` and re-applying; Cloud Run picks up `latest` on the next revision.

## Upgrading

1. Push a new image to Artifact Registry / GCR.
2. Update `container_image`.
3. `terraform apply` creates a new Cloud Run revision and shifts 100% traffic. To canary, set per-revision traffic splits in the `traffic` block.

Rollback:

```bash
gcloud run services update-traffic siskelbot-prod-svc \
  --region us-central1 \
  --to-revisions PREVIOUS=100
```

## Outputs

| Output | Description |
|--------|-------------|
| `service_uri` | Default Cloud Run URL |
| `public_url` | LB URL (with custom domain) if enabled, otherwise service URL |
| `load_balancer_ip` | Global IP to point DNS at (if LB enabled) |
| `postgres_connection_name` | Cloud SQL connection name |
| `redis_host` | Memorystore host |

## Tearing down

```bash
terraform destroy -var-file=terraform.tfvars
```

Cloud SQL has deletion protection enabled in `prod`; disable it before destroying.
