variable "location" {
  description = "Azure region (e.g. eastus, westeurope)."
  type        = string
  default     = "eastus"
}

variable "environment" {
  description = "Deployment environment name (dev, staging, prod)."
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name used as a prefix for all resources."
  type        = string
  default     = "siskelbot"
}

variable "resource_group_name" {
  description = "Name of the resource group. Default derives from project_name + environment."
  type        = string
  default     = ""
}

variable "container_image" {
  description = "Container image reference for the Container App."
  type        = string
  default     = "ghcr.io/siskelbot/siskelbot:latest"
}

variable "container_port" {
  description = "Port exposed by the SiskelBot container."
  type        = number
  default     = 11435
}

variable "cpu" {
  description = "Container CPU allocation (e.g. 0.5, 1.0, 2.0)."
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Container memory allocation (e.g. '1Gi', '2Gi')."
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum replica count."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum replica count."
  type        = number
  default     = 10
}

variable "enable_postgres" {
  description = "Provision an Azure Database for PostgreSQL Flexible Server."
  type        = bool
  default     = false
}

variable "postgres_sku_name" {
  description = "PostgreSQL Flexible Server SKU (e.g. B_Standard_B1ms, GP_Standard_D2s_v3)."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_version" {
  description = "PostgreSQL version."
  type        = string
  default     = "16"
}

variable "postgres_storage_mb" {
  description = "Storage size in MB."
  type        = number
  default     = 32768
}

variable "postgres_database_name" {
  description = "Initial database name."
  type        = string
  default     = "siskelbot"
}

variable "postgres_username" {
  description = "Database administrator username."
  type        = string
  default     = "siskelbot"
}

variable "enable_redis" {
  description = "Provision an Azure Cache for Redis instance."
  type        = bool
  default     = false
}

variable "redis_sku_name" {
  description = "Redis SKU name (Basic, Standard, Premium)."
  type        = string
  default     = "Basic"
}

variable "redis_family" {
  description = "Redis SKU family (C for Basic/Standard, P for Premium)."
  type        = string
  default     = "C"
}

variable "redis_capacity" {
  description = "Redis capacity (0=250MB, 1=1GB, etc.)."
  type        = number
  default     = 0
}

variable "enable_application_gateway" {
  description = "Provision an Application Gateway in front of the Container App."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Custom domain name (used on Container App or Application Gateway)."
  type        = string
  default     = ""
}

variable "backend" {
  description = "LLM backend provider: ollama, vllm, or openai."
  type        = string
  default     = "openai"
}

variable "log_retention_days" {
  description = "Retention in days for the Log Analytics workspace."
  type        = number
  default     = 30
}

variable "api_key" {
  description = "API key for /v1/chat/completions. Stored in Key Vault."
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_api_key" {
  description = "Admin API key. Stored in Key Vault."
  type        = string
  sensitive   = true
  default     = ""
}

variable "session_secret" {
  description = "Session cookie secret. Stored in Key Vault."
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key when BACKEND=openai. Stored in Key Vault."
  type        = string
  sensitive   = true
  default     = ""
}
