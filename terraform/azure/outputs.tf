output "resource_group_name" {
  description = "Name of the resource group."
  value       = azurerm_resource_group.this.name
}

output "container_app_name" {
  description = "Name of the Container App."
  value       = azurerm_container_app.this.name
}

output "container_app_fqdn" {
  description = "Default FQDN of the Container App ingress."
  value       = azurerm_container_app.this.latest_revision_fqdn
}

output "container_app_url" {
  description = "Default HTTPS URL of the Container App."
  value       = "https://${azurerm_container_app.this.latest_revision_fqdn}"
}

output "container_app_environment_id" {
  description = "ID of the Container Apps environment."
  value       = azurerm_container_app_environment.this.id
}

output "key_vault_name" {
  description = "Name of the Key Vault holding SiskelBot secrets."
  value       = azurerm_key_vault.this.name
}

output "key_vault_uri" {
  description = "Key Vault URI."
  value       = azurerm_key_vault.this.vault_uri
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace resource ID."
  value       = azurerm_log_analytics_workspace.this.id
}

output "postgres_fqdn" {
  description = "Postgres Flexible Server FQDN (if enabled)."
  value       = var.enable_postgres ? azurerm_postgresql_flexible_server.this[0].fqdn : null
}

output "redis_hostname" {
  description = "Redis hostname (if enabled)."
  value       = var.enable_redis ? azurerm_redis_cache.this[0].hostname : null
}

output "redis_ssl_port" {
  description = "Redis SSL port (if enabled)."
  value       = var.enable_redis ? azurerm_redis_cache.this[0].ssl_port : null
}

output "application_gateway_public_ip" {
  description = "Public IP of the Application Gateway (if enabled)."
  value       = var.enable_application_gateway ? azurerm_public_ip.appgw[0].ip_address : null
}

output "public_url" {
  description = "Public URL for the SiskelBot deployment."
  value       = var.enable_application_gateway ? "http://${azurerm_public_ip.appgw[0].ip_address}" : "https://${azurerm_container_app.this.latest_revision_fqdn}"
}
