# =============================================================================
# outputs.tf — useful references after apply
# =============================================================================

output "service_name" {
  description = "Name of the Kubernetes Service"
  value       = kubernetes_service.scoreboard.metadata[0].name
}

output "ingress_host" {
  description = "Hostname configured on the Ingress"
  value       = var.ingress_host
}

output "namespace" {
  description = "Kubernetes namespace where resources were deployed"
  value       = var.namespace
}
