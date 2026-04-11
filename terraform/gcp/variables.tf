variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "GCP region for regional resources."
  type        = string
  default     = "us-central1"
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

variable "container_image" {
  description = "Container image reference (e.g. gcr.io/PROJECT/siskelbot:TAG)."
  type        = string
  default     = "gcr.io/cloudrun/hello"
}

variable "container_port" {
  description = "Port exposed by the SiskelBot container."
  type        = number
  default     = 11435
}

variable "cpu" {
  description = "Cloud Run CPU allocation (e.g. '1', '2', '4')."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Cloud Run memory allocation (e.g. '512Mi', '1Gi')."
  type        = string
  default     = "1Gi"
}

variable "min_instances" {
  description = "Minimum Cloud Run instances."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum Cloud Run instances."
  type        = number
  default     = 10
}

variable "concurrency" {
  description = "Max concurrent requests per instance."
  type        = number
  default     = 80
}

variable "timeout_seconds" {
  description = "Request timeout in seconds (max 3600)."
  type        = number
  default     = 600
}

variable "enable_postgres" {
  description = "Provision a Cloud SQL PostgreSQL instance."
  type        = bool
  default     = false
}

variable "postgres_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "postgres_version" {
  description = "Cloud SQL PostgreSQL version."
  type        = string
  default     = "POSTGRES_16"
}

variable "postgres_database_name" {
  description = "Initial database name."
  type        = string
  default     = "siskelbot"
}

variable "postgres_username" {
  description = "Database username."
  type        = string
  default     = "siskelbot"
}

variable "enable_redis" {
  description = "Provision a Memorystore Redis instance."
  type        = bool
  default     = false
}

variable "redis_tier" {
  description = "Memorystore Redis tier (BASIC or STANDARD_HA)."
  type        = string
  default     = "BASIC"
}

variable "redis_memory_size_gb" {
  description = "Memorystore memory size in GB."
  type        = number
  default     = 1
}

variable "enable_load_balancer" {
  description = "Create a global HTTPS load balancer with Cloud Armor in front of Cloud Run."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Fully-qualified domain name for the managed SSL certificate."
  type        = string
  default     = ""
}

variable "backend" {
  description = "LLM backend provider: ollama, vllm, or openai."
  type        = string
  default     = "openai"
}

variable "allow_unauthenticated" {
  description = "Allow public (unauthenticated) invocations of the Cloud Run service."
  type        = bool
  default     = true
}

variable "api_key" {
  description = "API key for /v1/chat/completions. Stored in Secret Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_api_key" {
  description = "Admin API key. Stored in Secret Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "session_secret" {
  description = "Session cookie secret. Stored in Secret Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key when BACKEND=openai. Stored in Secret Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "log_retention_days" {
  description = "Retention in days for the Cloud Logging sink bucket."
  type        = number
  default     = 30
}
