variable "aws_region" {
  description = "AWS region to deploy SiskelBot into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name (e.g. dev, staging, prod)."
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name used as a prefix for all resources."
  type        = string
  default     = "siskelbot"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones to deploy subnets into. Must be exactly 2."
  type        = list(string)
  default     = []
}

variable "container_image" {
  description = "Container image reference for the SiskelBot task (e.g. ghcr.io/org/siskelbot:latest)."
  type        = string
  default     = "ghcr.io/siskelbot/siskelbot:latest"
}

variable "container_port" {
  description = "Port exposed by the SiskelBot container."
  type        = number
  default     = 11435
}

variable "cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired ECS service task count."
  type        = number
  default     = 2
}

variable "min_count" {
  description = "Minimum task count for autoscaling."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum task count for autoscaling."
  type        = number
  default     = 10
}

variable "enable_postgres" {
  description = "Provision an RDS PostgreSQL instance for persistent storage."
  type        = bool
  default     = false
}

variable "postgres_instance_class" {
  description = "RDS instance class for PostgreSQL."
  type        = string
  default     = "db.t4g.micro"
}

variable "postgres_allocated_storage" {
  description = "Initial storage allocation in GB for the RDS instance."
  type        = number
  default     = 20
}

variable "postgres_engine_version" {
  description = "PostgreSQL engine version for RDS."
  type        = string
  default     = "16.3"
}

variable "postgres_database_name" {
  description = "Initial database name created on the RDS instance."
  type        = string
  default     = "siskelbot"
}

variable "postgres_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "siskelbot"
}

variable "enable_redis" {
  description = "Provision an ElastiCache Redis cluster for caching and pubsub."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_nodes" {
  description = "Number of cache nodes in the Redis cluster."
  type        = number
  default     = 1
}

variable "domain_name" {
  description = "Optional fully-qualified domain name (e.g. chat.example.com) for the public endpoint."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for creating an A record. Leave empty to skip DNS."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "Existing ACM certificate ARN for the HTTPS listener. Leave empty to skip HTTPS."
  type        = string
  default     = ""
}

variable "backend" {
  description = "LLM backend provider: ollama, vllm, or openai."
  type        = string
  default     = "openai"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days."
  type        = number
  default     = 30
}

variable "api_key" {
  description = "API key protecting /v1/chat/completions. Stored in Secrets Manager and injected into the task."
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_api_key" {
  description = "Admin API key protecting /admin endpoints. Stored in Secrets Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "session_secret" {
  description = "Session cookie secret. Stored in Secrets Manager."
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key when BACKEND=openai. Stored in Secrets Manager."
  type        = string
  sensitive   = true
  default     = ""
}
