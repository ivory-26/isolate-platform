# Kubernetes connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Code | none — no connector code exists in this repository |
| Free tier verified | 2026-10-31 (no SaaS free tier; OSS is Apache 2.0) |
| Auth model | Dedicated ServiceAccount, namespaced Role + RoleBinding, short-lived bound token |
| Inbound trigger | None native; Alertmanager or an event watcher through the generic bridge |
| Read context | Events, pod status, bounded pod logs, Deployment/ReplicaSet status |
| Writes | Deploy/rollback `sensitive`; delete `destructive` (none in scope) |

Nothing below is implemented. The connector reads one namespace with a read-only ServiceAccount; it never receives a kubeconfig in the agent sandbox.

## 1. Role in the agent

Kubernetes answers "what did the cluster do to this workload": why a pod is not starting, whether it was OOM-killed, which image pull failed, whether a rollout is stuck, and what the last 200 log lines say. It is a context source; the trigger normally arrives from Prometheus/Alertmanager (`KubePodCrashLooping`, `KubeDeploymentReplicasMismatch`) or from a server-side event watcher. The Kubernetes API itself has no incident webhook.

| Incident kind | Evidence | Severity (proposed) | Fingerprint |
|---|---|---|---|
| `pod_crashloop` | `waiting.reason=CrashLoopBackOff`, restart count, last termination | `high` in production, `medium` otherwise | `k8s:<cluster>:<ns>:pod/<name>:CrashLoopBackOff` |
| `pod_oomkilled` | `lastState.terminated.reason=OOMKilled`, limits | `critical` in production, `high` otherwise | `k8s:<cluster>:<ns>:pod/<name>:OOMKilled` |
| `image_pull_failed` | `waiting.reason=ErrImagePull`/`ImagePullBackOff` | `high` | `k8s:<cluster>:<ns>:pod/<name>:ImagePull` |
| `deployment_unavailable` | `availableReplicas < replicas`, rollout condition | `high` in production | `k8s:<cluster>:<ns>:deployment/<name>:Unavailable` |
| `node_not_ready` | Node condition `Ready=False` | `critical` | `k8s:<cluster>:node/<name>:NotReady` |

The fingerprint excludes pod hash suffixes and replica ids: a rolling update replaces `api-7c9f...` with `api-8d2e...` but the incident is the same Deployment. Use the owner (Deployment/StatefulSet) name plus reason; keep the concrete pod in the context, not in the key.

`node_not_ready` is the exception: nodes are cluster-scoped, so it cannot be served by the namespaced role in §3. It requires a separate ClusterRole/ClusterRoleBinding, a separate review, and is **out of scope** for the default connector.

Evidence added: up to 10 Warning events (reason, message, count, first/last timestamp), container states and restart counts, the last termination reason and exit code, a 200-line/2,000-char log tail, Deployment/ReplicaSet rollout status, and (through Prometheus) kube-state-metrics series. `kubectl describe` output is not fetched wholesale; only allowlisted fields are composed into an excerpt.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| Kubernetes licence / price | Apache 2.0; no licence fee for the OSS distribution | [K11] |
| SaaS free tier | **None from the Kubernetes project.** The project ships OSS only; self-host (kubeadm, k3s, kind) or pay a managed control plane | [K11] |
| Connector quota | None; the API server's own limits and RBAC apply | [K1] |
| Events retention | 1 hour by default (`--event-ttl 1h0m0s`); events are best-effort and may be missing | [K4] |
| metrics-server | `metrics.k8s.io/v1beta1`, sampled every 15 seconds; short history only | [K6] |
| kube-state-metrics | Object-state metrics on `/metrics` port 8080; needs cluster-wide list/watch | [K5] |
| Prometheus retention | 15 days by default if metrics are stored there | `prometheus.md` §2 |
| API rate limits | API Priority and Fairness (APF) per flow; a throttled flow can return `429` — **UNVERIFIED** on the pages read | [K10] |
| Trial / expiry | None | [K11] |
| Overage | Infrastructure cost only; no vendor billing | [K11] |

The absence of a free managed tier is the main constraint: a cluster costs money even when the connector is free. Events disappear after an hour and metrics-server keeps only a short window, so an incident older than that needs Prometheus or a log pipeline. Do not treat an empty event list as "nothing happened".

## 3. Auth and least privilege

Create one ServiceAccount in the workload namespace and bind a read-only Role. A ClusterRole may hold the reusable rules, but bind it with a **namespaced RoleBinding** so the grant is effective only in that namespace; this is the "namespaced ClusterRole" pattern and it does not grant cluster-wide access [K1].

| API group | Resource | Verbs | Why |
|---|---|---|---|
| `""` (core) | `pods` | `get`, `list`, `watch` | Status, container states, restarts |
| `""` (core) | `pods/log` | `get` | Bounded log tail only |
| `""` (core) | `events` | `get`, `list`, `watch` | Warning events for the object |
| `""` (core) | `services` | `get`, `list` | Service selector and endpoints context |
| `apps` | `deployments`, `replicasets`, `statefulsets` | `get`, `list`, `watch` | Rollout and replica status |
| `events.k8s.io` | `events` | `get`, `list` | Newer events API, if the cluster serves it |

Do **not** grant `secrets`, `configmaps`, `pods/exec`, `pods/portforward`, `pods/attach`, `serviceaccounts/token`, or any `create`/`update`/`patch`/`delete` verb. Do not grant `nodes` unless the cluster-scoped node health signal is explicitly in scope; that requires a ClusterRoleBinding and a separate review.

Token: use a projected, audience-bound ServiceAccount token. The default `expirationSeconds` is 3,600 seconds (1 hour), and the kubelet rotates it [K2]. Set `automountServiceAccountToken: false` on application pods so only the connector's pod carries the credential. If the connector runs outside the cluster, mint a short-lived token with the TokenRequest API (≤24 h), keep it in a server-side file, and never export it to the sandbox. Kubeconfig, token and CA file are server-only paths.

Rotation: the bound token rotates automatically in-cluster. For an external token, mint a new one, reload the connector, verify, then revoke the old token by deleting the TokenRequest object or rotating the ServiceAccount. Rotation cadence: 24 hours or less for external tokens.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | None native. `POST /api/webhooks/kubernetes` via the bridge, or a server-side watcher that submits signals internally |
| Signature header | **No webhook and no HMAC from Kubernetes.** The API server authenticates the *client*; it does not sign events |
| Bridge algorithm | HMAC-SHA256 over `${timestamp}.${body}`, with proxy mTLS/Basic auth for the upstream watcher |
| Timestamp | Bridge-generated, ±300 s |
| Dedupe key | `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`; never the event `metadata.uid` or `resourceVersion` |
| Body cap | 64 KiB; one signal per object/reason, not per event repetition |
| Retries | Watcher/bridge retries are deployment-specific; the Kubernetes API watch itself reconnects with a resource version — **UNVERIFIED** for any vendor bridge |

Event objects repeat and are garbage-collected after about an hour [K4]. A watcher must coalesce by `(involvedObject, reason)` and count occurrences rather than emitting one delivery per event. A native adapter is not possible without an in-cluster agent or a webhook bridge; the current receiver cannot verify a Kubernetes caller, because Kubernetes sends no signature.

## 5. Read-only context

| Need | Endpoint | Parameters / notes | Source |
|---|---|---|---|
| Warning events | `GET /api/v1/namespaces/{ns}/events` | `fieldSelector=involvedObject.name=<name>,type=Warning`, `limit=50`; core/v1 fields `reason`, `message`, `count`, `firstTimestamp`, `lastTimestamp`, `involvedObject` | [K3] |
| Pod status | `GET /api/v1/namespaces/{ns}/pods/{name}` | `status.containerStatuses[].state`, `lastState.terminated`, `restartCount`, `conditions` | [K8] |
| Pod logs | `GET /api/v1/namespaces/{ns}/pods/{name}/log` | `container`, `tailLines=200`, `timestamps=true`, `sinceSeconds=3600`; never `follow=true` | [K8] |
| Deployment | `GET /apis/apps/v1/namespaces/{ns}/deployments/{name}` | `spec.replicas`, `status.availableReplicas`, `conditions`, `observedGeneration` | [K9] |
| ReplicaSets | `GET /apis/apps/v1/namespaces/{ns}/replicasets` | `labelSelector`, `limit=20`; image and revision annotations only | [K9] |
| kube-state-metrics | Prometheus series, not a direct scrape | `kube_pod_container_status_restarts_total`, `kube_deployment_status_replicas_unavailable` | [K5] |
| metrics-server | `metrics.k8s.io/v1beta1` pods/nodes | CPU/memory usage at 15 s resolution; no history | [K6] |

Fixed call order: normalize the signal → one Events list for the owner object → one Pod get (if the pod still exists) → one log tail → one Deployment get → optionally one ReplicaSet list. At most **5** API calls per bundle. Use `limit` + `continue` for lists; the parameter text was not exposed on the pages read — **UNVERIFIED** — and the connector never follows pagination beyond the first page (50 items for events, 20 for ReplicaSets).

Caps: 100 items / 4,000 chars per excerpt / 256 KiB total. Within that: 10 events, 1 pod, 200 log lines / 2,000 chars, 1 deployment, 5 ReplicaSets. Compose excerpts from allowlisted fields; never return a raw object. Set `truncated` when a call, item or line is dropped.

Never fetch: Secrets or ConfigMaps, environment variables, `pods/exec` or `attach`, all pods in the namespace, all events in the cluster, node kubelet endpoints, full logs, container images layers, service account tokens, or any object in another namespace. A `403` on an optional resource drops that item; a `401`/`403` on the core read fails the bundle with `POLICY_DENIED`.

## 6. Framework fit

Proposed module: `packages/integrations/src/kubernetes/`.

Source enum: `kubernetes` is **not** in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`); `ContextItem.source` uses the same enum. Add `kubernetes` in a shared-contract commit before the adapter. Until then the bridge must send `source: "generic"`.

| Function | Purpose |
|---|---|
| `verifyKubernetesWebhook(...)` | Bridge verifier only. There is no native Kubernetes webhook; this must not imply one |
| `normalizeKubernetesIncident(event, {cluster})` | Event/pod/deployment condition → `IncidentSignal`; owner-based fingerprint, production gate |
| `fetchKubernetesContext(deps, input)` | Fixed 5-call plan over the typed reader, log tail, redaction, `truncated` |

Environment variables (names only):

| Variable | Purpose |
|---|---|
| `KUBERNETES_API_URL` | In-cluster `https://kubernetes.default.svc` or the external API endpoint |
| `KUBERNETES_NAMESPACE` | The one namespace this connector may read |
| `KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE` | Server-side path to the bound token; never an inline value |
| `KUBERNETES_CA_FILE` | Server-side path to the cluster CA |
| `KUBERNETES_CLUSTER_ID` | Stable cluster label for the fingerprint |
| `KUBERNETES_WEBHOOK_SECRET` | Bridge HMAC secret |

The token is file-based by design; an inline `KUBERNETES_TOKEN` environment variable is deliberately not used, because environment values leak into crash dumps, child processes and prompt-adjacent tooling more easily than a file path.

Proposed agent tools:

| Tool | Risk band | Behavior |
|---|---|---|
| `kubernetes.get_events` | `read_only` | Warning events for one owner object, ≤50 |
| `kubernetes.get_pod` | `read_only` | Status and container states, no spec dump |
| `kubernetes.pod_logs` | `read_only` | `tailLines ≤ 200`, no follow, redacted |
| `kubernetes.get_deployment` | `read_only` | Replica and rollout status |
| `kubernetes.rollout_restart` | `sensitive` | Restart a Deployment; approval bound to namespace/name |
| `kubernetes.rollback` | `sensitive` | Roll back to a ReplicaSet revision; approval bound to revision |
| `kubernetes.apply` | `sensitive` | Deploy a manifest; separate write credential and approval |
| `kubernetes.delete` | `destructive` | Delete a workload; human approval even for admins |

Sandbox implications: all Kubernetes calls execute in the worker, server-side. The sandbox never receives a kubeconfig, a ServiceAccount token, a CA file or a proxy. Sandbox egress stays deny, so a compromised command cannot reach the API server. Tool arguments are namespace/name/reason only, bounded by the Zod schema; results are allowlisted, redacted and capped before returning. Every call appends `audit_events` with `action = tool.execute`, `details.tool`, `details.risk` and `details.outcome`. Adding a tool requires the `ToolName` union, `SANDBOX_TOOL_RISKS`, the implementation map and the registry; `createRiskTablePolicy` denies `destructive` outright, so `kubernetes.delete` cannot be enabled by a table entry alone.

Tests (fakes only): RBAC manifest contains no secrets/exec/delete; event normalisation and owner fingerprint; log tail cap and `follow` refusal; redaction seeds in log lines and event messages; `401`/`403`/`404`/`429` mapping; namespace isolation; foreign-namespace read returns `NOT_FOUND`; no token in any error.

## 7. Operator setup checklist

1. Create the namespace-scoped ServiceAccount, Role and RoleBinding in §3; do not reuse `default` or a cluster-admin binding.
2. Set `automountServiceAccountToken: false` on application pods; mount a projected token only in the connector pod.
3. Deploy the connector in-cluster, or mint a ≤24 h token via TokenRequest for an external deployment.
4. Verify with `kubectl auth can-i --as=system:serviceaccount:<ns>:<sa> list pods -n <ns>`; also verify `delete` is denied.
5. Point Alertmanager rules (`KubePodCrashLooping`, `KubeDeploymentReplicasMismatch`) at the bridge; keep the event watcher opt-in and coalesced.
6. Record the cluster id and the one namespace; do not add a second namespace without a new binding and review.
7. Offline gates twice with providers disabled; then one bounded events read and one log tail in a disposable namespace.
8. Never place a kubeconfig or token in this repository, a prompt, a fixture or a ticket.

```dotenv
KUBERNETES_API_URL=
KUBERNETES_NAMESPACE=
KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE=
KUBERNETES_CA_FILE=
KUBERNETES_CLUSTER_ID=
KUBERNETES_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline first:

- [ ] The RBAC manifest grants only `get`/`list`/`watch` on the resources in §3 and contains no `secrets`, `exec`, `delete` or `create`.
- [ ] A CrashLoopBackOff fixture yields `high` in production and the owner-based fingerprint; a pod-hash change does not change it.
- [ ] A 250-line log yields 200 lines / 2,000 chars with `truncated: true`; `follow=true` is refused by the schema.
- [ ] A token or email in a log line is redacted before truncation; no ServiceAccount token appears in any error.
- [ ] `403` on an optional resource drops the item; `403` on the core read fails closed; `429` maps to `RATE_LIMITED`.
- [ ] A foreign-namespace read is `NOT_FOUND`, not `FORBIDDEN`.

Live (one bounded call, no retries):

- [ ] One Events list and one `tailLines=20` log read in a disposable namespace return bounded items; assert no Secret/ConfigMap data and no token in the prompt.
- [ ] One bridge-signed signal creates exactly one task; a replay is deduped. Self-hosted Kubernetes has no metered spend.

## 9. Risks / never in model context

Risks: a kubeconfig is often cluster-admin and must never reach the sandbox; events are best-effort and expire in about an hour; pod logs can contain credentials and customer data; a broad list/watch can overload the API server; APF throttling returns `429`; a namespaced binding can be widened accidentally by a ClusterRoleBinding; delete and apply are one mistake away from an outage.

Never in model context: kubeconfig, ServiceAccount token, CA private key, `Authorization` header; Secret or ConfigMap data; environment variables; `pods/exec` or `attach` output; full pod specs, full logs, or all events in the cluster; node kubelet credentials; container image pull secrets; internal IPs and node names beyond what the incident needs.

## 10. Sources

All accessed 2026-10-31.

| ID | Source | URL |
|---|---|---|
| K1 | Kubernetes RBAC (Role, ClusterRole, RoleBinding, verbs) | https://kubernetes.io/docs/reference/access-authn-authz/rbac/ |
| K2 | Service accounts (bound tokens, expiry, least privilege) | https://kubernetes.io/docs/concepts/security/service-accounts/ |
| K3 | Core/v1 Event API fields | https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/ |
| K4 | kube-apiserver flags (`--event-ttl` default 1h) | https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/ |
| K5 | kube-state-metrics (object-state metrics, port 8080, cluster-wide read) | https://github.com/kubernetes/kube-state-metrics |
| K6 | metrics-server (`metrics.k8s.io/v1beta1`, 15 s) | https://github.com/kubernetes-sigs/metrics-server |
| K8 | Pod API (status, containers, log subresource) | https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/ |
| K9 | Deployment API (replicas, conditions) | https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/deployment-v1/ |
| K10 | Kubernetes API concepts (verbs, resource scope, flow control) | https://kubernetes.io/docs/reference/using-api/api-concepts/ |
| K11 | Kubernetes licence (Apache 2.0) | https://raw.githubusercontent.com/kubernetes/kubernetes/master/LICENSE |
