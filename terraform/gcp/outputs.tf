output "service_name" {
  description = "Name of the Cloud Run service."
  value       = google_cloud_run_v2_service.siskelbot.name
}

output "service_uri" {
  description = "Default Cloud Run service URL."
  value       = google_cloud_run_v2_service.siskelbot.uri
}

output "service_account_email" {
  description = "Email of the Cloud Run runtime service account."
  value       = google_service_account.runtime.email
}

output "load_balancer_ip" {
  description = "Global load balancer IP (if enabled)."
  value       = length(google_compute_global_address.lb_ip) > 0 ? google_compute_global_address.lb_ip[0].address : null
}

output "vpc_network" {
  description = "VPC network ID (if enabled)."
  value       = length(google_compute_network.vpc) > 0 ? google_compute_network.vpc[0].id : null
}

output "postgres_connection_name" {
  description = "Cloud SQL connection name for use with the Cloud SQL proxy."
  value       = var.enable_postgres ? google_sql_database_instance.postgres[0].connection_name : null
}

output "postgres_private_ip" {
  description = "Private IP of the Cloud SQL instance."
  value       = var.enable_postgres ? google_sql_database_instance.postgres[0].private_ip_address : null
}

output "redis_host" {
  description = "Memorystore Redis host."
  value       = var.enable_redis ? google_redis_instance.redis[0].host : null
}

output "redis_port" {
  description = "Memorystore Redis port."
  value       = var.enable_redis ? google_redis_instance.redis[0].port : null
}

output "public_url" {
  description = "Public URL for the SiskelBot deployment."
  value       = local.enable_lb && var.domain_name != "" ? "https://${var.domain_name}" : google_cloud_run_v2_service.siskelbot.uri
}
