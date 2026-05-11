###############################################################################
# Locals and shared data
###############################################################################

data "azurerm_client_config" "current" {}

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  rg_name       = var.resource_group_name != "" ? var.resource_group_name : "${local.name_prefix}-rg"
  kv_name       = substr(lower(replace("${local.name_prefix}-kv", "-", "")), 0, 24)
  law_name      = "${local.name_prefix}-law"
  cae_name      = "${local.name_prefix}-cae"
  app_name      = "${local.name_prefix}-app"
  psql_name     = "${local.name_prefix}-psql"
  redis_name    = "${local.name_prefix}-redis"
  vnet_name     = "${local.name_prefix}-vnet"
  enable_net    = var.enable_postgres || var.enable_redis || var.enable_application_gateway
}

resource "random_password" "postgres" {
  count            = var.enable_postgres ? 1 : 0
  length           = 32
  special          = true
  override_special = "!#%*()-_=+[]{}<>?"
}

###############################################################################
# Resource group
###############################################################################

resource "azurerm_resource_group" "this" {
  name     = local.rg_name
  location = var.location

  tags = {
    project     = var.project_name
    environment = var.environment
    managed_by  = "terraform"
  }
}

###############################################################################
# Networking (optional)
###############################################################################

resource "azurerm_virtual_network" "vnet" {
  count               = local.enable_net ? 1 : 0
  name                = local.vnet_name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  address_space       = ["10.40.0.0/16"]
}

resource "azurerm_subnet" "containerapps" {
  count                = local.enable_net ? 1 : 0
  name                 = "containerapps"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.40.0.0/23"]
}

resource "azurerm_subnet" "postgres" {
  count                = var.enable_postgres ? 1 : 0
  name                 = "postgres"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.40.4.0/24"]

  delegation {
    name = "fs"
    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }

  service_endpoints = ["Microsoft.Storage"]
}

resource "azurerm_subnet" "appgw" {
  count                = var.enable_application_gateway ? 1 : 0
  name                 = "appgw"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.vnet[0].name
  address_prefixes     = ["10.40.5.0/24"]
}

resource "azurerm_private_dns_zone" "postgres" {
  count               = var.enable_postgres ? 1 : 0
  name                = "${local.name_prefix}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count                 = var.enable_postgres ? 1 : 0
  name                  = "${local.name_prefix}-psql-link"
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  virtual_network_id    = azurerm_virtual_network.vnet[0].id
  resource_group_name   = azurerm_resource_group.this.name
}

###############################################################################
# Log Analytics workspace
###############################################################################

resource "azurerm_log_analytics_workspace" "this" {
  name                = local.law_name
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
}

###############################################################################
# Key Vault
###############################################################################

#trivy:ignore:AVD-AZU-0013 # Reviewed 2026-05-11: RBAC-only vault acceptable for this module; default Deny network ACLs require env-specific IP rules and break Terraform/GitHub OIDC secret provisioning without private runners.
resource "azurerm_key_vault" "this" {
  name                       = local.kv_name
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = var.environment == "prod"
  soft_delete_retention_days = 7
  enable_rbac_authorization  = true
}

resource "azurerm_role_assignment" "kv_admin" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name_prefix}-identity"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
}

resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

locals {
  secrets = {
    "api-key"        = var.api_key
    "admin-api-key"  = var.admin_api_key
    "session-secret" = var.session_secret
    "openai-api-key" = var.openai_api_key
    "database-url"   = var.enable_postgres ? "postgres://${var.postgres_username}:${random_password.postgres[0].result}@${azurerm_postgresql_flexible_server.this[0].fqdn}:5432/${var.postgres_database_name}?sslmode=require" : ""
    "redis-url"      = var.enable_redis ? "rediss://:${azurerm_redis_cache.this[0].primary_access_key}@${azurerm_redis_cache.this[0].hostname}:${azurerm_redis_cache.this[0].ssl_port}" : ""
  }
}

resource "azurerm_key_vault_secret" "secrets" {
  for_each     = local.secrets
  name         = each.key
  value        = each.value == "" ? "unset" : each.value
  key_vault_id = azurerm_key_vault.this.id

  depends_on = [azurerm_role_assignment.kv_admin]
}

###############################################################################
# Azure Database for PostgreSQL Flexible Server (optional)
###############################################################################

resource "azurerm_postgresql_flexible_server" "this" {
  count                         = var.enable_postgres ? 1 : 0
  name                          = local.psql_name
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  version                       = var.postgres_version
  delegated_subnet_id           = azurerm_subnet.postgres[0].id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres[0].id
  administrator_login           = var.postgres_username
  administrator_password        = random_password.postgres[0].result
  sku_name                      = var.postgres_sku_name
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = 7
  public_network_access_enabled = false
  zone                          = "1"

  high_availability {
    mode = var.environment == "prod" ? "ZoneRedundant" : "Disabled"
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "siskelbot" {
  count     = var.enable_postgres ? 1 : 0
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.this[0].id
  collation = "en_US.utf8"
  charset   = "UTF8"
}

###############################################################################
# Azure Cache for Redis (optional)
###############################################################################

resource "azurerm_redis_cache" "this" {
  count                         = var.enable_redis ? 1 : 0
  name                          = local.redis_name
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  capacity                      = var.redis_capacity
  family                        = var.redis_family
  sku_name                      = var.redis_sku_name
  non_ssl_port_enabled          = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true

  redis_configuration {
    maxmemory_policy = "allkeys-lru"
  }
}

###############################################################################
# Container Apps environment + Container App
###############################################################################

resource "azurerm_container_app_environment" "this" {
  name                       = local.cae_name
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id

  infrastructure_subnet_id = local.enable_net ? azurerm_subnet.containerapps[0].id : null
}

resource "azurerm_container_app" "this" {
  name                         = local.app_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  dynamic "secret" {
    for_each = local.secrets
    content {
      name                = secret.key
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.secrets[secret.key].id
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "siskelbot"
      image  = var.container_image
      cpu    = var.cpu
      memory = var.memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = tostring(var.container_port)
      }

      env {
        name  = "BACKEND"
        value = var.backend
      }

      env {
        name  = "ENABLE_METRICS"
        value = "1"
      }

      env {
        name  = "STORAGE_BACKEND"
        value = var.enable_postgres ? "postgres" : "json"
      }

      env {
        name        = "API_KEY"
        secret_name = "api-key"
      }

      env {
        name        = "ADMIN_API_KEY"
        secret_name = "admin-api-key"
      }

      env {
        name        = "SESSION_SECRET"
        secret_name = "session-secret"
      }

      env {
        name        = "OPENAI_API_KEY"
        secret_name = "openai-api-key"
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = var.container_port
        interval_seconds  = 30
        failure_count_threshold = 3
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = var.container_port
        interval_seconds = 10
      }

      startup_probe {
        transport = "HTTP"
        path      = "/health"
        port      = var.container_port
        interval_seconds = 5
      }
    }

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "80"
    }
  }

  ingress {
    external_enabled           = !var.enable_application_gateway
    target_port                = var.container_port
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  depends_on = [
    azurerm_key_vault_secret.secrets,
    azurerm_role_assignment.kv_secrets_user,
  ]
}

###############################################################################
# Application Gateway (optional)
###############################################################################

resource "azurerm_public_ip" "appgw" {
  count               = var.enable_application_gateway ? 1 : 0
  name                = "${local.name_prefix}-appgw-pip"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_application_gateway" "this" {
  count               = var.enable_application_gateway ? 1 : 0
  name                = "${local.name_prefix}-appgw"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location

  sku {
    name     = "WAF_v2"
    tier     = "WAF_v2"
    capacity = 2
  }

  waf_configuration {
    enabled          = true
    firewall_mode    = "Prevention"
    rule_set_type    = "OWASP"
    rule_set_version = "3.2"
  }

  gateway_ip_configuration {
    name      = "gw-ip-config"
    subnet_id = azurerm_subnet.appgw[0].id
  }

  frontend_port {
    name = "http-port"
    port = 80
  }

  frontend_ip_configuration {
    name                 = "frontend-ip"
    public_ip_address_id = azurerm_public_ip.appgw[0].id
  }

  backend_address_pool {
    name  = "containerapp-pool"
    fqdns = [azurerm_container_app.this.latest_revision_fqdn]
  }

  backend_http_settings {
    name                                = "https-settings"
    cookie_based_affinity               = "Disabled"
    port                                = 443
    protocol                            = "Https"
    request_timeout                     = 60
    pick_host_name_from_backend_address = true
  }

  http_listener {
    name                           = "http-listener"
    frontend_ip_configuration_name = "frontend-ip"
    frontend_port_name             = "http-port"
    protocol                       = "Http"
  }

  request_routing_rule {
    name                       = "default"
    priority                   = 100
    rule_type                  = "Basic"
    http_listener_name         = "http-listener"
    backend_address_pool_name  = "containerapp-pool"
    backend_http_settings_name = "https-settings"
  }
}
