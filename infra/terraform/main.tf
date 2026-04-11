# =============================================================================
# main.tf — TEMPLATE
# Operators MUST customize provider configuration and resource values before
# applying. All TODO comments mark cluster-specific settings.
# =============================================================================

terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

# TODO: Configure the Kubernetes provider for your cluster.
# Options: kubeconfig file, exec plugin (EKS/GKE/AKS auth), or in-cluster SA.
provider "kubernetes" {
  # Option A: kubeconfig file (local/dev)
  # config_path = "~/.kube/config"
  # config_context = "your-cluster-context"  # TODO: set your context name

  # Option B: EKS — uncomment and fill in:
  # host                   = data.aws_eks_cluster.cluster.endpoint
  # cluster_ca_certificate = base64decode(data.aws_eks_cluster.cluster.certificate_authority[0].data)
  # exec {
  #   api_version = "client.authentication.k8s.io/v1beta1"
  #   args        = ["eks", "get-token", "--cluster-name", var.cluster_name]
  #   command     = "aws"
  # }

  # Option C: GKE — uncomment and fill in:
  # host  = google_container_cluster.primary.endpoint
  # token = data.google_client_config.default.access_token
}

# -----------------------------------------------------------------------------
# Deployment
# -----------------------------------------------------------------------------
resource "kubernetes_deployment" "scoreboard" {
  metadata {
    name      = "scoreboard"
    namespace = var.namespace  # TODO: set namespace in values.tfvars
    labels = {
      app = "scoreboard"
    }
  }

  spec {
    replicas = var.replica_count  # TODO: set in values.tfvars (default: 3)

    selector {
      match_labels = {
        app = "scoreboard"
      }
    }

    template {
      metadata {
        labels = {
          app = "scoreboard"
        }
      }

      spec {
        container {
          name              = "scoreboard-api"
          image             = "${var.image_repository}:${var.image_tag}"  # TODO: set in values.tfvars
          image_pull_policy = "IfNotPresent"

          port {
            container_port = 3000
            protocol       = "TCP"
          }

          resources {
            requests = {
              cpu    = var.resources_requests_cpu     # TODO: set in values.tfvars
              memory = var.resources_requests_memory  # TODO: set in values.tfvars
            }
            limits = {
              cpu    = var.resources_limits_cpu     # TODO: set in values.tfvars
              memory = var.resources_limits_memory  # TODO: set in values.tfvars
            }
          }

          env_from {
            config_map_ref {
              name = kubernetes_config_map.scoreboard.metadata[0].name
            }
          }

          env_from {
            secret_ref {
              name = kubernetes_secret.scoreboard.metadata[0].name
            }
          }

          readiness_probe {
            http_get {
              path = "/ready"
              port = 3000
            }
            initial_delay_seconds = 10
            period_seconds        = 5
            timeout_seconds       = 1
            failure_threshold     = 3
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = 3000
            }
            initial_delay_seconds = 15
            period_seconds        = 10
            timeout_seconds       = 1
            failure_threshold     = 3
          }
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Service
# -----------------------------------------------------------------------------
resource "kubernetes_service" "scoreboard" {
  metadata {
    name      = "scoreboard"
    namespace = var.namespace
    labels = {
      app = "scoreboard"
    }
  }

  spec {
    type = "ClusterIP"

    selector = {
      app = "scoreboard"
    }

    port {
      name        = "http"
      protocol    = "TCP"
      port        = 3000
      target_port = 3000
    }
  }
}

# -----------------------------------------------------------------------------
# Ingress (nginx, with sticky sessions for SSE)
# -----------------------------------------------------------------------------
resource "kubernetes_ingress_v1" "scoreboard" {
  metadata {
    name      = "scoreboard"
    namespace = var.namespace
    labels = {
      app = "scoreboard"
    }
    annotations = {
      # Sticky sessions for SSE long-lived connections on /v1/leaderboard/stream
      "nginx.ingress.kubernetes.io/affinity"             = "cookie"
      "nginx.ingress.kubernetes.io/affinity-mode"        = "persistent"
      "nginx.ingress.kubernetes.io/session-cookie-name"  = "scoreboard-sticky"
      "nginx.ingress.kubernetes.io/session-cookie-path"  = "/v1/leaderboard/stream"
      # SSE requires long read timeout and disabled buffering
      "nginx.ingress.kubernetes.io/proxy-read-timeout"   = "3600"
      "nginx.ingress.kubernetes.io/proxy-buffering"      = "off"
    }
  }

  spec {
    ingress_class_name = "nginx"

    rule {
      host = var.ingress_host  # TODO: set in values.tfvars

      http {
        path {
          path      = "/"
          path_type = "Prefix"

          backend {
            service {
              name = kubernetes_service.scoreboard.metadata[0].name
              port {
                number = 3000
              }
            }
          }
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# ConfigMap (non-secret env vars)
# -----------------------------------------------------------------------------
resource "kubernetes_config_map" "scoreboard" {
  metadata {
    name      = "scoreboard-config"
    namespace = var.namespace
    labels = {
      app = "scoreboard"
    }
  }

  data = {
    # Runtime
    NODE_ENV = "production"
    PORT     = "3000"

    # Datastores — TODO: set actual endpoints in values.tfvars or replace here
    DATABASE_URL = "postgres://user:password@postgres:5432/scoreboard"
    REDIS_URL    = "redis://redis:6379"

    # NATS JetStream — TODO: replace with actual cluster endpoints
    NATS_URL                   = "nats://nats:4222"
    NATS_STREAM_NAME           = "SCOREBOARD"
    NATS_STREAM_MAX_AGE_SECONDS = "2592000"
    NATS_STREAM_MAX_MSGS       = "1000000"
    NATS_STREAM_MAX_BYTES      = "1073741824"
    NATS_STREAM_REPLICAS       = "1"  # TODO: set to 3 for production NATS cluster
    NATS_DEDUP_WINDOW_SECONDS  = "120"

    # Auth token TTL (non-secret)
    ACTION_TOKEN_TTL_SECONDS = "300"

    # Rate limiting & SSE
    RATE_LIMIT_PER_SEC          = "10"
    MAX_SSE_CONN_PER_INSTANCE   = "5000"
    LEADERBOARD_REBUILD_TOP_N   = "10000"

    # Outbox publisher
    OUTBOX_POLL_INTERVAL_MS   = "50"
    OUTBOX_LOCK_TTL_SECONDS   = "10"
    OUTBOX_COALESCE_WINDOW_MS = "100"

    # SSE backpressure
    SSE_BACKPRESSURE_MAX_PENDING_MESSAGES = "50"
    SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS     = "5000"
    SSE_HEARTBEAT_INTERVAL_MS             = "15000"

    # Observability
    LOG_LEVEL                    = "info"
    OTEL_EXPORTER_OTLP_ENDPOINT  = ""  # TODO: set to your OTLP collector endpoint
  }
}

# -----------------------------------------------------------------------------
# Secret (STUB — do NOT populate real values here)
# Use your secret manager to inject actual values at deploy time.
# -----------------------------------------------------------------------------
resource "kubernetes_secret" "scoreboard" {
  metadata {
    name      = "scoreboard-secret"
    namespace = var.namespace
    labels = {
      app = "scoreboard"
    }
    annotations = {
      # TODO: if using External Secrets Operator, annotate here
      # "externalsecrets.io/backend" = "your-secret-store"
    }
  }

  type = "Opaque"

  # WARNING: Do NOT commit real secrets here.
  # These are stub placeholders — populate via your secret management pipeline.
  data = {
    INTERNAL_JWT_SECRET      = ""  # TODO: supply via secret manager (min 32 chars)
    ACTION_TOKEN_SECRET      = ""  # TODO: supply via secret manager (min 32 chars)
    ACTION_TOKEN_SECRET_PREV = ""  # TODO: supply via secret manager (rotation key, min 32 chars)
  }
}

# -----------------------------------------------------------------------------
# PodDisruptionBudget
# -----------------------------------------------------------------------------
resource "kubernetes_pod_disruption_budget_v1" "scoreboard" {
  metadata {
    name      = "scoreboard"
    namespace = var.namespace
    labels = {
      app = "scoreboard"
    }
  }

  spec {
    min_available = "2"

    selector {
      match_labels = {
        app = "scoreboard"
      }
    }
  }
}
