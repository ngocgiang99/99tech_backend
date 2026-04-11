# =============================================================================
# variables.tf — TEMPLATE
# Set actual values in values.tfvars (never commit secrets there).
# =============================================================================

variable "image_repository" {
  description = "Container image repository (e.g. your-registry/problem6-scoreboard-api)"
  type        = string
  default     = "your-registry/problem6-scoreboard-api"  # TODO: replace with actual registry
}

variable "image_tag" {
  description = "Container image tag"
  type        = string
  default     = "v1.0.0-rc1"
}

variable "replica_count" {
  description = "Number of Deployment replicas. Min 3 for HA; must be > podDisruptionBudget.minAvailable."
  type        = number
  default     = 3
}

variable "namespace" {
  description = "Kubernetes namespace to deploy into"
  type        = string
  default     = "scoreboard"  # TODO: set to your target namespace
}

variable "ingress_host" {
  description = "Hostname for the Ingress rule"
  type        = string
  default     = "scoreboard.example.com"  # TODO: replace with your actual domain
}

variable "resources_requests_cpu" {
  description = "CPU request for the scoreboard-api container"
  type        = string
  default     = "250m"
}

variable "resources_requests_memory" {
  description = "Memory request for the scoreboard-api container"
  type        = string
  default     = "512Mi"
}

variable "resources_limits_cpu" {
  description = "CPU limit for the scoreboard-api container"
  type        = string
  default     = "1000m"
}

variable "resources_limits_memory" {
  description = "Memory limit for the scoreboard-api container"
  type        = string
  default     = "1Gi"
}
