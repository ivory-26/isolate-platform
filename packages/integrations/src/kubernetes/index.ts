/**
 * Kubernetes connector — read-only context plane.
 *
 * There is **no native inbound webhook** for Kubernetes. The API server
 * authenticates its clients and never signs events, so an incident signal
 * arrives through Alertmanager/Prometheus rules or the signed generic webhook
 * bridge; this module only normalizes events and reads bounded cluster state.
 *
 * No kubeconfig is supported and no credential is exported: the API server is
 * reached through an injected `KubernetesHttpClient` built from a
 * ServiceAccount token file and the cluster CA file, server-side only.
 */
export * from "./context";
export * from "./normalize";
export * from "./redact";
export * from "./schemas";
export * from "./tools";
export * from "./types";
