# Kubernetes connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Code | `packages/integrations/src/kubernetes/` (implemented; fake-client tested) |
| Free tier verified | 2026-10-31 (no SaaS free tier; OSS is Apache 2.0) |
| Auth model | Dedicated ServiceAccount, namespaced Role + RoleBinding, short-lived bound token |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "kubernetes"` |
| Read | Events, pod status, bounded pod logs, Deployment/ReplicaSet status |
| Writes | None in scope; the write tool names below are documented but have no implementation |

The adapter, read context and relay tools exist in `packages/integrations/src/kubernetes/` and `apps/device-daemon/src/vendors/kubernetes.ts`. Wave 24 added the paired fields (API URL, namespace, token-file path, optional CA file) and the `k8s.context.fetch` device tool. There is no Kubernetes intake mode in `apps/web`, so no webhook can create a task directly; a delivery must be re-signed onto the generic bridge. A local `kind` cluster proof exists; it is not an inbound webhook source. No live Kubernetes acceptance run has been recorded. The connector reads one namespace with a read-only ServiceAccount and never receives a kubeconfig in the agent sandbox.

## 1. Role in the agent

Kubernetes answers "what did the cluster do to this workload": why a pod is not starting, whether it was OOM-killed, which image pull failed, whether a rollout is stuck, and what the last 200 log lines say. It is a context source; the trigger normally arrives from Prometheus/Alertmanager (`KubePodCrashLooping`, `KubeDeploymentReplicasMismatch`) or from a server-side event watcher. The Kubernetes API itself has no incident webhook.

| Incident kind | Evidence | Severity | Fingerprint |
|---|---|---|---|
| `pod_crashloop` | `waiting.reason=CrashLoopBackOff`, restart count, last termination | `high` in production, `medium` otherwise | `k8s:<cluster>:<ns>:pod/<name>:CrashLoopBackOff` |
| `pod_oomkilled` | `lastState.terminated.reason=OOMKilled`, limits | `critical` in production, `high` otherwise | `k8s:<cluster>:<ns>:pod/<name>:OOMKilled` |
| `image_pull_failed` | `ErrImagePull`, `ImagePullBackOff`, `ErrImageNeverPull`, `InvalidImageName` | `high` | `k8s:<cluster>:<ns>:pod/<name>:ImagePull` |
| `deployment_unavailable` | `availableReplicas < replicas`, rollout condition | `high` in production; `medium` for the replica-failure reasons | `k8s:<cluster>:<ns>:deployment/<name>:Unavailable` |
| `node_not_ready` | Node condition `Ready=False` | `critical` | `k8s:<cluster>:<ns>:node/<name>:NotReady` |

The normalizer (`normalizeKubernetesEvent`) accepts only `type: Warning`; any other Warning reason becomes `kubernetes_warning` with `medium` severity. The fingerprint excludes pod hash suffixes and replica ids: a rolling update replaces `api-7c9f...` with `api-8d2e...` but the incident is the same Deployment. A caller that knows the owner (Deployment/StatefulSet) passes it in `owner` and the fingerprint uses it; the concrete pod stays in the context, not in the key. The event's `metadata.uid` and `resourceVersion` are never part of the key. `ImagePull` coalesces the four pull reasons, and `Unavailable` coalesces the rollout reasons.

`node_not_ready` is the exception: nodes are cluster-scoped, so it cannot be served by the namespaced role in §3. It requires a separate ClusterRole/ClusterRoleBinding, a separate review, and is **out of scope** for the default connector.

Evidence added: up to 10 Warning events (reason, message, count, first/last timestamp), container states and restart counts, the last termination reason and exit code, a 200-line / 2,000-char log tail, Deployment/ReplicaSet rollout status, and (through Prometheus) kube-state-metrics series. `kubectl describe` output is not fetched wholesale; only allowlisted fields are composed into an excerpt.

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

Token: use a projected, audience-bound ServiceAccount token. The default `expirationSeconds` is 3,600 seconds (1 hour), and the kubelet rotates it [K2]. Set `automountServiceAccountToken: false` on application pods so only the connector's pod carries the credential. If the connector runs outside the cluster, mint a short-lived token with the TokenRequest API (<=24 h), write it to a file, and pair that file path. Kubeconfig, token and CA file are server-only paths.

Storage: the paired credential holds the token-file path (and the optional CA path); the server holds only `credential_ref` metadata. Rotation: the bound token rotates automatically in-cluster. For an external token, mint a new one, write it to the same path (or re-pair with the new path), verify, then revoke the old token by deleting the TokenRequest object or rotating the ServiceAccount. Rotation cadence: 24 hours or less for external tokens.

## 4. Inbound trigger

**There is no native Kubernetes intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. Kubernetes sends no webhook and no HMAC, so a watcher or Alertmanager must map the event to a signal and re-sign it onto the generic bridge. The module has no Kubernetes delivery verifier; the bridge verifies its own HMAC.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `kubernetes` |
| Fingerprint | `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`, with the lowercased kind and a coalesced reason |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated segment 1-64 characters; charset `[A-Za-z0-9._:@/-]`. Over 128 characters the builder emits `k8s:<20>:<20>:<12>/<32>:<16>~<12hex>`, which the parser rejects, so such a fingerprint yields no evidence; a name longer than 64 characters is also rejected by the parser |
| Actions | A `Warning` event creates a task; a `Normal` event is not an incident |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the event uid and resource version are traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

The repo normalizer (`normalizeKubernetesEvent`) accepts only `type: Warning`, requires a namespace, derives the service from the first configured app label (`app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app`, `k8s-app`) and falls back to the namespace, and redacts the message before it reaches the signal. A bridge sender that reuses it inherits those rules; the platform receiver itself never inspects a Kubernetes event. A watcher must coalesce by `(involvedObject, reason)` and count occurrences rather than emitting one delivery per repeated event object, because events repeat and are garbage-collected after about an hour [K4].

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`kubernetes`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no Kubernetes evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

| Need | Endpoint | Parameters / notes | Source |
|---|---|---|---|
| Warning events | `GET /api/v1/namespaces/{ns}/events` | `fieldSelector=involvedObject.name=<name>,type=Warning`, `limit=50`; the reader keeps at most 10 by default (a tool may ask for up to 50) | [K3] |
| Pod status | `GET /api/v1/namespaces/{ns}/pods/{name}` | Phase, conditions, container states, `lastState.terminated`, `restartCount`, resource limits; no spec dump, IPs or node names | [K8] |
| Pod logs | `GET /api/v1/namespaces/{ns}/pods/{name}/log` | `container`, `tailLines<=200`, `timestamps=true`, `sinceSeconds` 60-3,600 (default 3,600); never `follow=true` | [K8] |
| Deployment | `GET /apis/apps/v1/namespaces/{ns}/deployments/{name}` | `spec.replicas`, `status.readyReplicas`/`availableReplicas`/`unavailableReplicas`/`updatedReplicas`, conditions, observed generation | [K9] |
| ReplicaSets | `GET /apis/apps/v1/namespaces/{ns}/replicasets` | `labelSelector` from the Deployment's selector, `limit=20`; keeps at most 5, with revision and image only | [K9] |
| kube-state-metrics | Prometheus series, not a direct scrape | `kube_pod_container_status_restarts_total`, `kube_deployment_status_replicas_unavailable` | [K5] |
| metrics-server | `metrics.k8s.io/v1beta1` pods/nodes | CPU/memory usage at 15 s resolution; no history | [K6] |

Fixed five-call plan on the device path: Warning events for the involved object (1) -> pod status (2) -> pod log tail (3) when a pod is named or the kind is `Pod` -> Deployment status (4) -> ReplicaSets for that Deployment (5) when a Deployment is named. A Pod incident therefore uses events, pod and log tail (3 calls); a Deployment incident uses events, deployment and ReplicaSets (3 calls). At most **5 API calls** per bundle, 10-second timeout each (clamped to 30 s), one page each: `limit` plus `continue` is not followed, so events stop at 50 and ReplicaSets at 20 before the item caps apply.

Caps: at most **5 items** from this source, **4,000 characters** per excerpt (log excerpts 2,000), **256 KiB** per response and per bundle. Within that: 10 events, 1 pod, 200 log lines / 2,000 chars, 1 deployment, 5 ReplicaSets. Compose excerpts from allowlisted fields; never return a raw object. Set `truncated` when a call, item, line or field is dropped.

The context bundle treats the events read as the core read: a `401` fails with `INTEGRATION_UNAVAILABLE`, a `403` fails closed with `POLICY_DENIED`, and a `429` maps to `RATE_LIMITED`. On the optional reads (pod, logs, deployment, ReplicaSets) a `403`, `404` or other non-2xx drops that item and sets `truncated` instead. The explicit tools use the same mapping but surface a `404` as `NOT_FOUND` and a `403` as `POLICY_DENIED` for the requested resource.

Never fetch: Secrets or ConfigMaps, environment variables, `pods/exec` or `attach`, all pods in the namespace, all events in the cluster, node kubelet endpoints, full logs, container image layers, service account tokens, or any object in another namespace. A call naming a namespace other than the configured one fails `NOT_FOUND` before any API request.

### 5.1 Evidence loading

The worker never holds the ServiceAccount token. For a task carrying a `k8s:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, kubernetes, fingerprint)`, and enqueues exactly one `k8s.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`, uses the namespace, kind and name from the fingerprint (it does not require a service), and canonicalizes the lowercased fingerprint kind (`pod`) to the adapter enum (`Pod`). A `kind` parameter that conflicts with the fingerprint is rejected. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without Kubernetes evidence and is never failed by context loading.

## 6. Framework fit

- Module: `packages/integrations/src/kubernetes/` (`normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, `types.ts`, tests); device handlers in `apps/device-daemon/src/vendors/kubernetes.ts`.
- Source enum: `kubernetes` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`); the normalizer emits `source: "kubernetes"`.
- Implemented functions: `normalizeKubernetesEvent` (Warning events only, reason-to-kind and severity map, owner-based fingerprint, production bands, redaction), `fetchKubernetesContext` (fixed five-call plan above), and the four bounded read functions behind the tools. There is no bridge verifier in this module.
- Device tools: `k8s.list_events`, `k8s.get_pod`, `k8s.get_deployment`, `k8s.logs_tail`, plus `k8s.context.fetch` for incident context. The context call is worker-enqueued; the four read tools are available to the model only when the registry finds an `active` credential and the tool is enabled.
- Pairing fields: secret `serviceAccountTokenFile` (a server-side path, never the token) and optional secret `caFile`; required selectors `apiUrl` and `namespace`; optional selector `clusterId`. The API URL and namespace also fall back to `KUBERNETES_API_URL` and `KUBERNETES_NAMESPACE`; the two paths are read from the paired credential or the deployment-chosen env names in `vendors.kubernetes.secretEnv`. The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all Kubernetes calls execute on the user's device; the sandbox never receives a kubeconfig, token, CA file or proxy; sandbox egress stays denied; the token never enters a prompt, tool result, error or audit detail.
- Tests: fake client only; RBAC manifest contains no secrets/exec/delete; event normalisation and owner fingerprint; log tail cap and `follow` refusal; redaction seeds in log lines and event messages; `401`/`403`/`404`/`429` mapping; namespace isolation; foreign-namespace read returns `NOT_FOUND`; no token in any error.

Documented but **not implemented** (no code path, no approval flow; `createRiskTablePolicy` denies `destructive` outright):

| Tool | Risk band | Would-be behavior |
|---|---|---|
| `k8s.rollout_restart` | `sensitive` | Restart a Deployment; approval bound to namespace/name |
| `k8s.rollback` | `sensitive` | Roll back to a ReplicaSet revision; approval bound to revision |
| `k8s.apply` | `sensitive` | Deploy a manifest; separate write credential and approval |
| `k8s.scale` | `sensitive` | Change replicas; approval bound to namespace/name/replicas |
| `k8s.exec` | `destructive` | Arbitrary command in a container; never a tool |
| `k8s.delete` | `destructive` | Delete a workload; human approval even for admins |

## 7. Operator setup checklist

1. Create the namespace-scoped ServiceAccount, Role and RoleBinding in §3; do not reuse `default` or a cluster-admin binding.
2. Set `automountServiceAccountToken: false` on application pods; mount a projected token only in the connector pod.
3. Deploy the connector in-cluster, or mint a <=24 h token via TokenRequest for an external deployment and write it to a file.
4. Verify with `kubectl auth can-i --as=system:serviceaccount:<ns>:<sa> list pods -n <ns>`; also verify `delete` is denied.
5. Pair the `kubernetes` connector on the relay with the `serviceAccountTokenFile` path, the optional `caFile` path, the `apiUrl` and `namespace` selectors and, when known, the `clusterId`. The values stay in the relay's encrypted local store; never put them in the repository, a prompt or a fixture.
6. Configure the bridge sender (Alertmanager rule or event watcher) to map the delivery to a strict `IncidentSignal` with `source: "kubernetes"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
7. Point the sender at `https://<host>/api/webhooks/<any-path>`; set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow). The payload never selects a tenant.
8. Create an enabled subscription for the `kubernetes` connector if the task should carry provenance and load evidence (§4).
9. Offline gates twice with providers disabled; then one bounded events read and one log tail in a disposable namespace.
10. Never place a kubeconfig or token in this repository, a prompt, a fixture or a ticket.

```dotenv
WEBHOOK_SIGNING_SECRET=
KUBERNETES_API_URL=
KUBERNETES_NAMESPACE=
# Relay-local examples only: the daemon reads the env var names configured in
# `vendors.kubernetes.secretEnv`, so a deployment may name them differently.
KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE=
KUBERNETES_CA_FILE=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] The RBAC manifest grants only `get`/`list`/`watch` on the resources in §3 and contains no `secrets`, `exec`, `delete` or `create`.
- [x] A CrashLoopBackOff fixture yields `high` in production and the owner-based fingerprint; a pod-hash change does not change it; a `Normal` event is not an incident.
- [x] A 250-line log yields 200 lines / 2,000 chars with `truncated: true`; `follow=true` is refused by the schema.
- [x] A token or email in a log line is redacted before truncation; no ServiceAccount token appears in any error.
- [x] The five-call plan stops at 5 calls; events stop at 10 by default and ReplicaSets at 5.
- [x] `403` on an optional resource drops the item; `403` on the core events read fails closed; `429` maps to `RATE_LIMITED`.
- [x] A foreign-namespace read is `NOT_FOUND`, not `FORBIDDEN`.
- [x] Relay context: `k8s.context.fetch` parses `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`, canonicalizes the kind and rejects a conflicting `kind`; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **run 2026-11-13** against a disposable `kind` cluster (`kind-isolate-demo`, namespace `isolate-demo`, pod `crash-demo` in `ImagePullBackOff`). The first delivery's `k8s.context.fetch` failed `INTEGRATION_UNAVAILABLE` in 63 ms because the stored ServiceAccount token was stale (the API answered `401`); after minting a fresh token with `kubectl create token isolate-reader --duration=24h`, a second delivery returned a real bundle in 5.0 s — 2 items (warning events and pod logs), `truncated: true`. No Secret/ConfigMap data and no token reached the prompt. Full run log: [`live-verification.md`](live-verification.md).

Offline measurement against an external benchmark: [`scripts/bench-itbench-k8s.ts`](../../scripts/bench-itbench-k8s.ts) replays the ITBench-AA `sre/Scenario-16` snapshot (public Hugging Face dataset) through the real `fetchKubernetesContext`, with no cluster and no model. First result: 3 items (pod, deployment, replicasets), 1,077 bytes, `truncated: false`, root-cause **entity recall 1.00**, decisive condition tokens **0.00** — the fault was `QUOTE_ADDR=0000`, and the deployment excerpt rendered only replicas, generation and conditions. The excerpt now renders a bounded container-env line (names always; a literal value only for a config-shaped name, never for a credential-shaped one, never when the value carries `@`; `valueFrom` shows `<ref>`), and the same run then scored **1.00** with a byte-identical digest across two runs. See §9 for the exact rule.

## 9. Risks / never in model context

Risks: a kubeconfig is often cluster-admin and must never reach the sandbox; events are best-effort and expire in about an hour; pod logs can contain credentials and customer data; a broad list/watch can overload the API server; APF throttling returns `429`; a namespaced binding can be widened accidentally by a ClusterRoleBinding; delete and apply are one mistake away from an outage.

Never in model context: kubeconfig, ServiceAccount token, CA private key, `Authorization` header, bridge `WEBHOOK_SIGNING_SECRET`; Secret or ConfigMap data; `pods/exec` or `attach` output; full pod specs, full logs, or all events in the cluster; node kubelet credentials; container image pull secrets; internal IPs and node names beyond what the incident needs.

Environment variables are the one exception, and it is narrow and bounded. The deployment excerpt renders at most 16 env entries per container, 480 characters per line, from literal `value` fields only: `valueFrom` shows `<ref>` (a Secret/ConfigMap ref is never resolved), a credential-shaped name (`SECRET|TOKEN|PASSWORD|PASS|API_KEY|KEY|CREDENTIAL|AUTH|DSN|CONN|CERT|PRIVATE`) shows `[redacted]`, a non-config-shaped name shows `<hidden>`, and any value containing `@` (userinfo in a URL or an address) shows `<hidden>`. Only a config-shaped name (`PORT|ADDR|HOST|ENDPOINT|URL|TIMEOUT|INTERVAL|MODE|LEVEL|REGION|REPLICAS|THRESHOLD|LIMIT`) with a clean literal value is rendered, and the whole line still passes `redactKubernetesLine`. This exists because the ITBench-AA measurement above showed that a wrong port in an env var — the most common rollout misconfiguration — was invisible to the reader.

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
