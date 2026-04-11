###############################################################################
# Locals and shared data
###############################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  required_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "certificatemanager.googleapis.com",
  ]

  enable_vpc_connector = var.enable_postgres || var.enable_redis
  enable_lb            = var.enable_load_balancer
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "random_password" "postgres" {
  count            = var.enable_postgres ? 1 : 0
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>?"
}

###############################################################################
# Networking (VPC, connector, private services)
###############################################################################

resource "google_compute_network" "vpc" {
  count                   = local.enable_vpc_connector ? 1 : 0
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  count         = local.enable_vpc_connector ? 1 : 0
  name          = "${local.name_prefix}-subnet"
  ip_cidr_range = "10.30.0.0/20"
  region        = var.region
  network       = google_compute_network.vpc[0].id

  private_ip_google_access = true
}

resource "google_compute_global_address" "private_ip" {
  count         = local.enable_vpc_connector ? 1 : 0
  name          = "${local.name_prefix}-priv-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc[0].id
}

resource "google_service_networking_connection" "private_vpc" {
  count                   = local.enable_vpc_connector ? 1 : 0
  network                 = google_compute_network.vpc[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip[0].name]

  depends_on = [google_project_service.apis]
}

resource "google_vpc_access_connector" "connector" {
  count         = local.enable_vpc_connector ? 1 : 0
  name          = "${substr(local.name_prefix, 0, 18)}-vpcconn"
  region        = var.region
  network       = google_compute_network.vpc[0].name
  ip_cidr_range = "10.31.0.0/28"

  depends_on = [google_project_service.apis]
}

###############################################################################
# Cloud SQL PostgreSQL (optional)
###############################################################################

resource "google_sql_database_instance" "postgres" {
  count               = var.enable_postgres ? 1 : 0
  name                = "${local.name_prefix}-postgres"
  database_version    = var.postgres_version
  region              = var.region
  deletion_protection = var.environment == "prod"

  settings {
    tier              = var.postgres_tier
    availability_type = var.environment == "prod" ? "REGIONAL" : "ZONAL"
    disk_size         = 20
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc[0].id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "database" {
  count    = var.enable_postgres ? 1 : 0
  name     = var.postgres_database_name
  instance = google_sql_database_instance.postgres[0].name
}

resource "google_sql_user" "user" {
  count    = var.enable_postgres ? 1 : 0
  name     = var.postgres_username
  instance = google_sql_database_instance.postgres[0].name
  password = random_password.postgres[0].result
}

###############################################################################
# Memorystore Redis (optional)
###############################################################################

resource "google_redis_instance" "redis" {
  count              = var.enable_redis ? 1 : 0
  name               = "${local.name_prefix}-redis"
  tier               = var.redis_tier
  memory_size_gb     = var.redis_memory_size_gb
  region             = var.region
  authorized_network = google_compute_network.vpc[0].id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_version      = "REDIS_7_0"

  depends_on = [google_service_networking_connection.private_vpc]
}

###############################################################################
# Secret Manager
###############################################################################

locals {
  secrets = {
    api_key        = var.api_key
    admin_api_key  = var.admin_api_key
    session_secret = var.session_secret
    openai_api_key = var.openai_api_key
    database_url   = var.enable_postgres ? "postgres://${var.postgres_username}:${random_password.postgres[0].result}@${google_sql_database_instance.postgres[0].private_ip_address}:5432/${var.postgres_database_name}" : ""
    redis_url      = var.enable_redis ? "redis://${google_redis_instance.redis[0].host}:${google_redis_instance.redis[0].port}" : ""
  }
}

resource "google_secret_manager_secret" "secret" {
  for_each  = local.secrets
  secret_id = "${local.name_prefix}-${replace(each.key, "_", "-")}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secret_version" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.secret[each.key].id
  secret_data = each.value == "" ? "unset" : each.value
}

###############################################################################
# Service account for Cloud Run
###############################################################################

resource "google_service_account" "runtime" {
  account_id   = "${local.name_prefix}-run"
  display_name = "SiskelBot Cloud Run runtime"
}

resource "google_secret_manager_secret_iam_member" "run_access" {
  for_each  = google_secret_manager_secret.secret
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "run_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "run_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "run_trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

###############################################################################
# Cloud Run v2 service
###############################################################################

resource "google_cloud_run_v2_service" "siskelbot" {
  name     = "${local.name_prefix}-svc"
  location = var.region
  ingress  = local.enable_lb ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    max_instance_request_concurrency = var.concurrency
    timeout                          = "${var.timeout_seconds}s"

    dynamic "vpc_access" {
      for_each = local.enable_vpc_connector ? [1] : []
      content {
        connector = google_vpc_access_connector.connector[0].id
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }

    containers {
      image = var.container_image

      ports {
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

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
        name = "API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["api_key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "ADMIN_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["admin_api_key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["session_secret"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["openai_api_key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["database_url"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["redis_url"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = var.container_port
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = var.container_port
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.secret_version,
    google_secret_manager_secret_iam_member.run_access,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated && !local.enable_lb ? 1 : 0
  location = google_cloud_run_v2_service.siskelbot.location
  name     = google_cloud_run_v2_service.siskelbot.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

###############################################################################
# Global HTTPS load balancer + Cloud Armor (optional)
###############################################################################

resource "google_compute_region_network_endpoint_group" "serverless" {
  count                 = local.enable_lb ? 1 : 0
  name                  = "${local.name_prefix}-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.siskelbot.name
  }
}

resource "google_compute_security_policy" "waf" {
  count = local.enable_lb ? 1 : 0
  name  = "${local.name_prefix}-waf"

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-stable')"
      }
    }
    description = "Block XSS"
  }

  rule {
    action   = "deny(403)"
    priority = 1100
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-stable')"
      }
    }
    description = "Block SQLi"
  }

  rule {
    action   = "throttle"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
    description = "Rate limit per IP"
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }
}

resource "google_compute_backend_service" "siskelbot" {
  count                 = local.enable_lb ? 1 : 0
  name                  = "${local.name_prefix}-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.waf[0].id
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.serverless[0].id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "siskelbot" {
  count           = local.enable_lb ? 1 : 0
  name            = "${local.name_prefix}-urlmap"
  default_service = google_compute_backend_service.siskelbot[0].id
}

resource "google_compute_managed_ssl_certificate" "siskelbot" {
  count = local.enable_lb && var.domain_name != "" ? 1 : 0
  name  = "${local.name_prefix}-cert"

  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_target_https_proxy" "siskelbot" {
  count            = local.enable_lb && var.domain_name != "" ? 1 : 0
  name             = "${local.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.siskelbot[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.siskelbot[0].id]
}

resource "google_compute_global_address" "lb_ip" {
  count = local.enable_lb ? 1 : 0
  name  = "${local.name_prefix}-lb-ip"
}

resource "google_compute_global_forwarding_rule" "siskelbot" {
  count                 = local.enable_lb && var.domain_name != "" ? 1 : 0
  name                  = "${local.name_prefix}-fr"
  target                = google_compute_target_https_proxy.siskelbot[0].id
  port_range            = "443"
  ip_address            = google_compute_global_address.lb_ip[0].address
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

###############################################################################
# Cloud Logging sink
###############################################################################

resource "google_logging_project_bucket_config" "logs" {
  project        = var.project_id
  location       = "global"
  retention_days = var.log_retention_days
  bucket_id      = "${local.name_prefix}-logs"
}

resource "google_logging_project_sink" "run_sink" {
  name        = "${local.name_prefix}-run-sink"
  destination = "logging.googleapis.com/projects/${var.project_id}/locations/global/buckets/${google_logging_project_bucket_config.logs.bucket_id}"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.siskelbot.name}\""

  unique_writer_identity = true
}
