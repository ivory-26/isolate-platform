# Argo CD connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Code | none — no connector code exists in this repository |
| Free tier verified | 2026-10-31 (Apache 2.0, self-hosted; no project SaaS tier) |
| Auth model | Project-scoped Argo CD role token, Bearer, mandatory expiry |
| Inbound trigger | Argo CD Notifications webhook (outbound, unsigned) through the generic bridge |
| Read context | Application sync/health/history, resource tree, Argo Rollouts status |
| Writes | Sync/rollback `sensitive`; delete `destructive` (none in scope) |

Nothing below is implemented. Argo CD is free OSS; the connector is a read-only client with a project-scoped token.

## 1. Role in the agent

Argo CD answers "what is deployed, is it in sync, is it healthy, and what failed in the last sync". It does not answer "why the code is wrong"; that is the repository and CI context. The trigger is useful for a failed sync or a degraded application, but the context is the primary value: the deployed revision, the previous good revision, the operation message, and the health of the individual resources.

| Incident kind | Source state | Severity (proposed) | Fingerprint |
|---|---|---|---|
| `sync_failed` | `operationState.phase=Failed` or `Error` | `critical` in production, `high` otherwise | `argocd:<project>:<app>:sync:<revision>` |
| `app_degraded` | `status.health.status=Degraded` | `high` in production | `argocd:<project>:<app>:health:<revision>` |
| `app_out_of_sync` | `status.sync.status=OutOfSync` | `medium`; no task unless it persists past a configured window | `argocd:<project>:<app>:outofsync:<revision>` |
| `rollout_stuck` | Rollout `Progressing` beyond its deadline | `high` | `argocd:<project>:<app>:rollout:<name>` |

The fingerprint uses the resolved revision, never the operation id, sync id or timestamp: a retried sync of the same revision is the same incident. An `OutOfSync` that is expected during a deploy must not create a task; require it to persist for at least 10 minutes and require `health.status` to be `Degraded` or `Missing` for a task.

Evidence added: sync status and revision, health status and message, the last 10 history entries (`id`, `revision`, `deployedAt`), the current `operationState` message (redacted, ≤1,500 chars), a resource-tree summary (≤50 nodes: kind, name, health, status), and Argo Rollouts canary/blue-green status when the application owns a Rollout.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| Argo CD licence / price | Apache 2.0; no licence fee | [A10] |
| Argo Rollouts licence / price | Apache 2.0; no licence fee | [A7] |
| Hosting | Self-hosted only for this connector; the project ships OSS and no project-operated SaaS is in scope | [A10] |
| Application quota | None from Argo CD; cluster resources are the limit | [A1] |
| Notifications | Free; controller runs in-cluster | [A1] |
| API rate limit | No numeric Argo CD API limit documented; Kubernetes APF applies to Rollout reads — **UNVERIFIED** for Argo CD | [A3] |
| Retention | Sync history is stored in the Application object; the number of entries is controlled by `revisionHistoryLimit`, whose default was not extracted — **UNVERIFIED** | [A5] |
| Trial / expiry | None | [A10] |
| Overage | Infrastructure cost only | [A10] |

There is no overage meter and no free-tier cap, but a self-hosted control plane is still infrastructure. The connector reads at most 10 history entries and does not request more, independent of the Application's `revisionHistoryLimit`.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Identity | Argo CD project role, defined in `argocd-rbac-cm` as `p, proj:<project>:<role>, applications, <action>, <project>/*, allow` [A3] |
| Read action | `get` on `applications` in the one project [A3] |
| Write action | `sync` (and `action/*` for a rollback if the API requires it) only after an approval path exists [A3] |
| Token | `argocd proj role create-token <project> <role> --expires-in 24h` [A4] |
| Default expiry | **No expiration** if `--expires-in` is omitted — set it explicitly [A4] |
| Header | `Authorization: Bearer <token>` to the Argo CD API server |
| Lifetime | 24 hours for the connector; re-mint on a schedule or at worker boot |
| Rotation | Create a second token with a new id, deploy it, verify one read, delete the old token with `argocd proj role delete-token` |

Do not use the `admin` account, a personal account token, or a global role: a global role can read every project. Do not grant `*` actions or `applicationsets`; do not grant `delete`. A project token still inherits the project's destinations and source repositories, so keep the project limited to the applications in scope.

If writes are ever approved, use a second token with `sync` only, a separate env var, and an approval bound to `{app, revision, prune, dryRun}`. A sync with `prune: true` can delete live resources; it is not a read-adjacent operation.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/argocd` via the bridge; Argo CD cannot call the receiver directly with a verifiable signature |
| Signature header | **No HMAC in the Argo CD Notifications webhook service**; it supports `url`, static `headers`, `basicAuth` and `insecureSkipVerify` only [A2] |
| Bridge algorithm | HMAC-SHA256 over `${timestamp}.${body}`; the bridge authenticates Argo CD with mTLS/Basic and signs for Isolate |
| Timestamp | Bridge-generated `X-Isolate-Timestamp`, ±300 s |
| Dedupe key | `argocd:<project>:<app>:<kind>:<revision>`; never the notification delivery or operation id |
| Body cap | 64 KiB; one signal per application state change |
| Retries | Not documented for the Notifications webhook service — **UNVERIFIED** [A2] |
| Triggers | `on-sync-succeeded`, `on-sync-failed`, `on-health-degraded` [A1] |

The Notifications webhook is **outbound only**: Argo CD sends a templated generic HTTP request, and the template can shape the JSON but cannot compute an HMAC over it [A2]. Therefore the bridge is mandatory. Argo CD's own `/api/webhook` endpoint accepts Git/OCI provider events and triggers an application refresh; it is not an incident source and must not be repurposed as one [A11]. A resolved/healthy notification updates state and does not create a task.

Template the notification to include the application name, project, sync status, health status, revision and operation phase; the bridge rejects a body without them. Keep the notification body small: the resource tree is fetched later, not embedded in the webhook.

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Application state | `GET /api/v1/applications/{name}` | `status.sync.status`, `status.sync.revision`, `status.health.status`, `status.health.message`, `status.operationState`, `status.history[]`, `status.conditions` | [A5] |
| Sync history | Embedded in the Application | `history[].id`, `revision`, `deployedAt`; no separate history path was found — **UNVERIFIED** | [A5] |
| Resource tree | `GET /api/v1/applications/{name}/resource-tree` | Node `kind`, `name`, `health`, `status`; ≤50 nodes | [A5] |
| Managed resources | `GET /api/v1/applications/{name}/managed-resources` | Metadata only; do not return live manifests | [A5] |
| Application list | `GET /api/v1/applications` | Setup/health check only; never per incident | [A5] |
| Argo Rollouts | Kubernetes API `GET /apis/argoproj.io/v1alpha1/namespaces/{ns}/rollouts/{name}` | Canary/blue-green step, pause, analysis run status; no separate Argo Rollouts API server | [A7] |
| Sync (write) | `POST /api/v1/applications/{name}/sync` | Body `{revision, prune, dryRun}`; `sensitive` | [A5] |
| Rollback (write) | `POST /api/v1/applications/{name}/rollback` | Targets a history id; `sensitive` | [A6] |
| Delete (write) | `DELETE /api/v1/applications/{name}` | Deletes the Application; a cascade option also deletes live resources (default not extracted — **UNVERIFIED**); `destructive` | [A5] |

Fixed call order: normalize the notification → one Application get → one resource-tree get (only when health is not `Healthy`) → optionally one Rollout get. At most **3** calls per bundle. No model-authored application name, revision or project; all come from the validated signal plus server-side bindings.

Pagination: the Application API returns the whole object; the connector caps history and resource nodes client-side and uses no page parameters. The application list endpoint is never used per incident.

Caps: 100 items / 4,000 chars per excerpt / 256 KiB total. Within that: 1 application item, ≤10 history entries, ≤50 resource nodes, ≤1,500 chars of operation message, 1 Rollout summary. `truncated` is set when a call, node or history entry is dropped.

Never fetch: full manifests or `managed-resources` bodies, Secret values, repository credentials, the Argo CD `argocd-secret`, notification templates, all applications in the project, all resource trees, or cluster-scoped resources outside the application. A `403` means the project role is wrong; a `404` means the application is outside the role's project — both are bounded errors.

## 6. Framework fit

Proposed module: `packages/integrations/src/argocd/`.

Source enum: `argocd` is **not** in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`); `ContextItem.source` uses the same enum. Add `argocd` in a shared-contract commit before the adapter. Until then the bridge must send `source: "generic"`.

| Function | Purpose |
|---|---|
| `verifyArgoCDWebhook(...)` | Bridge verifier for the notification; no native Argo CD signature exists |
| `normalizeArgoCDIncident(payload, {project})` | Strict notification subset → `IncidentSignal`; revision fingerprint, production gate |
| `fetchArgoCDContext(deps, input)` | Application, history, resource tree, optional Rollout; redaction and caps |

Environment variables (names only):

| Variable | Purpose |
|---|---|
| `ARGOCD_BASE_URL` | Argo CD API origin, https, no userinfo |
| `ARGOCD_TOKEN` | Project-role token, 24 h expiry |
| `ARGOCD_PROJECT` | The one project the token may read |
| `ARGOCD_WEBHOOK_SECRET` | Bridge HMAC secret |
| `ARGOCD_ORG_ID` | Reserved for a future multi-tenant router; not used by Argo CD |

Proposed agent tools:

| Tool | Risk band | Behavior |
|---|---|---|
| `argocd.get_application` | `read_only` | Sync, health, revision, operation state |
| `argocd.get_history` | `read_only` | ≤10 history entries from the application object |
| `argocd.get_resource_tree` | `read_only` | ≤50 nodes, health only, no manifests |
| `argocd.sync` | `sensitive` | `dryRun` required first; approval bound to app/revision/prune |
| `argocd.rollback` | `sensitive` | History id; approval bound to app/id |
| `argocd.delete_application` | `destructive` | Denied by the current policy table; needs a policy change and human approval |

Sandbox implications: all Argo CD calls execute in the worker, server-side. Sandbox egress stays deny; the token never enters the sandbox environment, a tool argument, a prompt or a log. Results are allowlisted (status fields only) and redacted before truncation. Every write appends `audit_events` with `action = tool.execute`, `details.tool`, `details.risk` and `details.outcome`. Adding a tool requires the `ToolName` union, `SANDBOX_TOOL_RISKS`, the implementation map and the registry; `createRiskTablePolicy` returns `APPROVAL_REQUIRED` for `sensitive` and denies `destructive` outright.

Tests (fakes only): notification template parsing; revision fingerprint stable across retries; degraded/out-of-sync persistence window; history cap; resource-tree node cap; `401`/`403`/`404`/`429` mapping; redaction seeds in operation messages and revision annotations; project-role isolation; no token in errors.

## 7. Operator setup checklist

1. Confirm the Argo CD version and API base URL; put it behind TLS and restrict network access to the worker.
2. Create or reuse a project that contains only the applications in scope.
3. Add a project role with `get` on `applications`; add `sync` only when writes are approved.
4. Mint a token with `--expires-in 24h`; store it server-side; never use `admin` or a global role.
5. Configure the Notifications webhook service to call the bridge over TLS with Basic/mTLS auth; template the body with project, app, sync, health, revision and operation phase.
6. Subscribe only to `on-sync-failed`, `on-health-degraded` (and `on-sync-succeeded` for closure); do not send every event.
7. Offline gates twice with providers disabled; then one bounded application read and one test notification.
8. Record the rotation date; never place a token, kubeconfig or repository credential in this repository or a prompt.

```dotenv
ARGOCD_BASE_URL=
ARGOCD_TOKEN=
ARGOCD_PROJECT=
ARGOCD_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline first:

- [ ] Bridge verifier accepts a valid HMAC and rejects tampering, missing timestamp, 301 s skew and a 65 KiB body.
- [ ] `sync_failed` for revision R creates one signal; a retry of R is deduped; revision R+1 is a new signal.
- [ ] `OutOfSync` alone creates nothing; `Degraded` plus the persistence window creates one high signal.
- [ ] Reader returns ≤10 history entries, ≤50 resource nodes, no manifests and `truncated` when capped.
- [ ] A Secret-shaped value or token in `operationState.message` is redacted; no token appears in an error.
- [ ] `403` maps to `POLICY_DENIED`; `404` to `NOT_FOUND`; `429` to `RATE_LIMITED`.

Live (one bounded call, no retries):

- [ ] One `GET /api/v1/applications/{name}` returns sync/health/revision; assert no manifest or Secret content in the prompt.
- [ ] One bridge-signed notification creates exactly one task and a replay is deduped. Self-hosted Argo CD has no metered spend.

## 9. Risks / never in model context

Risks: project token default is **no expiry**; a global role sees every project; a sync with `prune` can delete resources; a rollback can revert a database migration; the Notifications webhook is unsigned and outbound-only, so an exposed bridge is spoofable without mTLS/Basic; Argo CD manifests and `managed-resources` can contain Secret references and plaintext values; Argo Rollouts changes production traffic and is never a read tool.

Never in model context: the project token, kubeconfig, repository credentials, Argo CD `argocd-secret`, webhook secrets; full Application manifests, `managed-resources` bodies, Secret or ConfigMap values; notification templates; all applications in a project; cluster-scoped resources outside the app; internal registry credentials.

## 10. Sources

All accessed 2026-10-31.

| ID | Source | URL |
|---|---|---|
| A1 | Argo CD Notifications overview and triggers | https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/ |
| A2 | Notifications webhook service (url, headers, basicAuth, no HMAC) | https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/services/webhook/ |
| A3 | Argo CD RBAC (project roles and actions) | https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/ |
| A4 | `argocd proj role create-token` (default no expiry) | https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_proj_role_create-token/ |
| A5 | Argo CD API description (application, sync, rollback, resource tree, managed resources) | https://raw.githubusercontent.com/argoproj/argo-cd/master/assets/swagger.json |
| A6 | `argocd app rollback` (history id) | https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_rollback/ |
| A7 | Argo Rollouts overview (CRD, canary/blue-green, analysis) | https://argo-rollouts.readthedocs.io/en/stable/ |
| A10 | Argo CD licence (Apache 2.0) | https://raw.githubusercontent.com/argoproj/argo-cd/master/LICENSE |
| A11 | Argo CD Git webhook endpoint (refresh only) | https://argo-cd.readthedocs.io/en/stable/operator-manual/webhook/ |
