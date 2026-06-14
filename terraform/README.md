# SiskelBot Terraform modules

Production-ready infrastructure modules for deploying SiskelBot to the three major clouds. Each module is self-contained under its own subdirectory and can be used independently — pick the one matching your target cloud.

```
terraform/
├── aws/      # AWS: ECS Fargate + ALB + optional RDS/Redis
├── gcp/      # GCP: Cloud Run v2 + optional Cloud SQL/Memorystore + LB/WAF
└── azure/    # Azure: Container Apps + optional Postgres Flex/Redis + App Gateway
```

All three modules share the same design goals:

- One container image (SiskelBot) deployed as a managed, auto-scaling service.
- Optional managed PostgreSQL and Redis, gated behind `enable_postgres` / `enable_redis`.
- Secrets stored in the cloud-native secret manager, injected into the workload at runtime.
- Dedicated VPC / private networking for database tier.
- Observability wired up (CloudWatch / Cloud Logging / Log Analytics).
- Sensible defaults for small production workloads; variables to scale up.

## Platform comparison

| Capability | AWS (ECS Fargate) | GCP (Cloud Run) | Azure (Container Apps) |
|---|---|---|---|
| Compute model | Long-running Fargate tasks | Serverless, scale-to-0 optional | Container App revisions |
| Load balancer | Application Load Balancer | Global HTTPS LB (optional) | Container Apps ingress or App Gateway |
| WAF | (bring your own WAF) | Cloud Armor (built-in to this module) | App Gateway WAF v2 OWASP 3.2 |
| Managed Postgres | RDS PostgreSQL | Cloud SQL PostgreSQL | PostgreSQL Flexible Server |
| Managed Redis | ElastiCache | Memorystore | Azure Cache for Redis |
| Secret storage | Secrets Manager | Secret Manager | Key Vault |
| Logs | CloudWatch Logs | Cloud Logging | Log Analytics |
| Scale to zero | No | Yes (`min_instances = 0`) | Yes (`min_replicas = 0`) |
| Cold-start latency | None | ~1-3s | ~1-3s |
| Typical min cost (no DB/Redis) | ~$116/mo | ~$0-25/mo | ~$33/mo |
| Typical full-stack cost | ~$141/mo | ~$85-110/mo | ~$62/mo (or ~$262 with WAF) |

**Rules of thumb:**

- Need scale-to-zero or bursty traffic on a budget? **GCP Cloud Run** or **Azure Container Apps**.
- Already committed to AWS or need VPC-peered connectivity to other AWS services? **AWS ECS Fargate**.
- Need an enterprise WAF turnkey? **GCP** (Cloud Armor) or **Azure** (App Gateway WAF v2) — both are in-module.

## Quick start

Each module uses the same three-step workflow. Pick your cloud, `cd` into it, populate `terraform.tfvars`, and apply.

### AWS

```bash
cd terraform/aws
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Minimum `terraform.tfvars`:

```hcl
aws_region      = "us-east-1"
container_image = "ghcr.io/your-org/siskelbot:latest"
api_key         = "..."
admin_api_key   = "..."
session_secret  = "..."
```

### GCP

```bash
cd terraform/gcp
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Minimum `terraform.tfvars`:

```hcl
project_id      = "my-gcp-project"
region          = "us-central1"
container_image = "gcr.io/my-gcp-project/siskelbot:latest"
api_key         = "..."
admin_api_key   = "..."
session_secret  = "..."
```

### Azure

```bash
cd terraform/azure
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Minimum `terraform.tfvars`:

```hcl
location        = "eastus"
container_image = "ghcr.io/your-org/siskelbot:latest"
api_key         = "..."
admin_api_key   = "..."
session_secret  = "..."
```

## Common variables

All modules accept this shared set of variables (with cloud-specific names where needed):

| Concept | AWS | GCP | Azure |
|---|---|---|---|
| Region | `aws_region` | `region` | `location` |
| Container image | `container_image` | `container_image` | `container_image` |
| CPU | `cpu` (units) | `cpu` (string) | `cpu` (number) |
| Memory | `memory` (MiB) | `memory` (string) | `memory` (string) |
| Scaling | `min_count`/`max_count` | `min_instances`/`max_instances` | `min_replicas`/`max_replicas` |
| Enable Postgres | `enable_postgres` | `enable_postgres` | `enable_postgres` |
| Enable Redis | `enable_redis` | `enable_redis` | `enable_redis` |
| Custom domain | `domain_name` | `domain_name` | `domain_name` |
| API keys | `api_key`, `admin_api_key`, `session_secret`, `openai_api_key` (sensitive) | same | same |

## Container image

All modules expect a SiskelBot OCI image. Build and push the image in your own pipeline, e.g.:

```bash
docker build -t ghcr.io/your-org/siskelbot:$(git rev-parse --short HEAD) .
docker push ghcr.io/your-org/siskelbot:$(git rev-parse --short HEAD)
```

Then set `container_image` to that tag.

Do **not** use `:latest` in production — pin to an immutable tag so rollbacks and reproducibility work.

## Remote state

These modules do not configure a remote state backend; you should add one before running in production. Examples:

**AWS (S3 + DynamoDB):**

```hcl
terraform {
  backend "s3" {
    bucket         = "my-tfstate"
    key            = "siskelbot/aws/prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}
```

**GCP (GCS):**

```hcl
terraform {
  backend "gcs" {
    bucket = "my-tfstate"
    prefix = "siskelbot/gcp/prod"
  }
}
```

**Azure (Storage Account):**

```hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "tfstate-rg"
    storage_account_name = "mytfstate"
    container_name       = "tfstate"
    key                  = "siskelbot/azure/prod.tfstate"
  }
}
```

## Security considerations

- **Never commit `terraform.tfvars` containing real secrets.** Add it to `.gitignore` and pass via `-var-file=` from a secure location, or source secrets from a secret manager in CI.
- All modules use sensitive variables for API keys; Terraform will not print them in plan output.
- The Terraform state file contains the actual secret values at rest — protect the state backend with encryption, IAM, and versioning.
- Prefer OIDC federation from CI (GitHub Actions / GitLab) to short-lived cloud credentials rather than long-lived access keys.
- Rotate `api_key`, `admin_api_key`, `session_secret` periodically. All three modules update the managed secret and re-deploy the workload on the next apply.

See each module's `README.md` for cloud-specific security guidance (security groups, private networking, WAF rules, etc.).

## Upgrading SiskelBot

Across all three clouds the upgrade flow is identical:

1. Build and push a new image.
2. Update `container_image` in `terraform.tfvars`.
3. `terraform apply`.

The managed service (ECS / Cloud Run / Container Apps) performs a rolling update with health checks against `/health`. If the new revision is unhealthy it stops shifting traffic automatically.

To roll back, set `container_image` to the previous tag and apply again, or use the cloud-native revision rollback (`gcloud run services update-traffic` for Cloud Run, `az containerapp revision activate` for Azure, re-deploy previous task definition for ECS).

## Tearing down

Each module supports `terraform destroy`. For `environment = "prod"`:

- AWS: RDS deletion protection is enabled; disable and re-apply before destroying.
- GCP: Cloud SQL deletion protection is enabled; set `environment = "dev"` or disable manually.
- Azure: Key Vault purge protection is enabled; it must age out of soft-delete.

```bash
terraform destroy -var-file=terraform.tfvars
```

## See also

- `docs/DEPLOYMENT.md` — high-level deployment guide
- `docs/DOCKER.md` — building and running the container image
- `docs/RUNBOOK.md` — operational runbook
- `helm/siskelbot/` — alternative deployment via Kubernetes + Helm
