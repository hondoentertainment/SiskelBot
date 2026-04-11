# SiskelBot on Azure (Container Apps)

Terraform module for deploying SiskelBot to Azure using Azure Container Apps, with optional Azure Database for PostgreSQL Flexible Server, Azure Cache for Redis, Key Vault, and an Application Gateway (WAF v2) in front.

## Architecture

```
Internet
   |
   v
Application Gateway (optional, WAF v2 OWASP 3.2)
   |
   v
Azure Container Apps environment  (VNet-integrated)
   |  +-- Container App: siskelbot (auto-scaling 1-10)
   |  +-- User-assigned managed identity
   v
+--> Azure Database for PostgreSQL Flexible Server (optional, private)
+--> Azure Cache for Redis (optional, SSL-only)
+--> Key Vault (secrets, RBAC authorized)
+--> Log Analytics workspace
```

## Prerequisites

- An Azure subscription.
- `az login` and `az account set --subscription <id>`.
- Provider registrations: `Microsoft.App`, `Microsoft.ContainerService`, `Microsoft.DBforPostgreSQL`, `Microsoft.Cache`, `Microsoft.KeyVault`, `Microsoft.OperationalInsights`.

## Quick start

```bash
cd terraform/azure

cat > terraform.tfvars <<EOF
location        = "eastus"
environment     = "prod"
project_name    = "siskelbot"
container_image = "ghcr.io/your-org/siskelbot:latest"

min_replicas = 1
max_replicas = 10
cpu          = 0.5
memory       = "1Gi"

enable_postgres            = true
enable_redis               = true
enable_application_gateway = true

api_key        = "replace-me"
admin_api_key  = "replace-me"
session_secret = "replace-me-long-random"
openai_api_key = "sk-..."
EOF

terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

## Components

| Feature | Variable | Effect |
|---------|----------|--------|
| Postgres Flexible Server | `enable_postgres = true` | Provisions private Postgres and injects `DATABASE_URL` |
| Cache for Redis | `enable_redis = true` | Provisions Redis Basic and injects `REDIS_URL` (TLS) |
| Application Gateway | `enable_application_gateway = true` | WAF v2 in front of the Container App; sets app ingress to internal |
| Custom domain | `domain_name = "..."` | Reserved for Container App or App GW binding |

All secrets live in Key Vault; the Container App references them through a user-assigned managed identity with `Key Vault Secrets User` role. Secrets are mounted as Container App secrets then mapped to env vars via `secret_name`.

## Cost estimate (approximate, East US)

| Component | Cost per month |
|-----------|---------------|
| Container Apps (1 replica, 0.5 vCPU / 1 GB, low traffic) | ~$20 |
| Log Analytics (5 GB ingested) | ~$12 |
| Key Vault (standard, low ops) | ~$1 |
| Postgres Flex B_Standard_B1ms (optional) | ~$13 |
| Redis Basic C0 250 MB (optional) | ~$16 |
| Application Gateway WAF_v2 (optional) | ~$200 |
| **Minimum (Container Apps only)** | **~$33** |
| **With Postgres + Redis** | **~$62** |
| **Full stack with WAF** | **~$262** |

Container Apps scales to zero if you set `min_replicas = 0` (dev only). The Application Gateway WAF_v2 is the biggest line item — for non-prod, disable it and rely on Container Apps ingress + HTTPS.

## Security considerations

- Container App runs with a user-assigned managed identity — no secrets in environment variables or Terraform state (beyond references).
- Key Vault uses RBAC authorization; the identity only gets `Key Vault Secrets User`.
- Postgres Flex Server uses `public_network_access_enabled = false` and is delegated into a dedicated subnet via private DNS.
- Redis is configured for TLS-only (`non_ssl_port_enabled = false`, `minimum_tls_version = 1.2`).
- When `enable_application_gateway = true`, Container App ingress switches to internal; WAF v2 runs OWASP 3.2 in Prevention mode.
- Use a remote backend (`azurerm` with Storage Account + state locking via blob lease) and enable versioning.
- Rotate secrets by updating `terraform.tfvars` and re-applying; the Container App picks up new secret versions on the next revision.

## Upgrading

1. Push a new image to your registry.
2. Update `container_image` in `terraform.tfvars`.
3. `terraform apply` creates a new Container App revision and promotes it (single revision mode).

Rollback with:

```bash
az containerapp revision activate \
  --name siskelbot-prod-app \
  --resource-group siskelbot-prod-rg \
  --revision <previous-revision>
```

Switch `revision_mode` to `Multiple` in `main.tf` for blue-green / canary strategies.

## Outputs

| Output | Description |
|--------|-------------|
| `container_app_url` | Default Container App HTTPS URL |
| `public_url` | App Gateway URL if enabled, otherwise Container App URL |
| `key_vault_uri` | Key Vault URI |
| `postgres_fqdn` | Postgres server FQDN |
| `redis_hostname` | Redis hostname |
| `application_gateway_public_ip` | Public IP of the App GW |

## Tearing down

```bash
terraform destroy -var-file=terraform.tfvars
```

For `prod` environments, Key Vault purge protection and Postgres deletion protection must be addressed before destroy succeeds.
