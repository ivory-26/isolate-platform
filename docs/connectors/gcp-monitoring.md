# Google Cloud Monitoring connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** (no module, verifier, reader or tool exists) |
| Free tier verified | 2026-10-31 (Google Cloud free features and Observability pricing) |
| Auth | Service account with viewer roles, or Workload Identity Federation (preferred) |
| Inbound | Cloud Monitoring webhook notification channel (token or basic auth, unsigned) → bridge → our HMAC webhook |
| Read | Monitoring API `timeSeries.list`, Logging API `entries:list`, Error Reporting `events.list` |
| Writes | None in scope (no policy, channel, uptime-check or log-sink mutation) |

This page follows [`_template.md`](_template.md) and [`README.md`](README.md). Everything below is design; no Google Cloud code exists in this repository.

## 1. Role in the agent

Google Cloud Monitoring is the alerting and metrics plane for GCP projects; Cloud Logging holds the corresponding logs, and Error Reporting groups application exceptions. The connector turns one open incident into one task and then answers "which policy fired, on which resource, with what metric shape, and what bounded error group or log summary explains it". The trigger is the primary value.

It must not be used as a generic log reader, a log sink manager, or a way to enumerate projects. The model selects a logical template; trusted code supplies the project, filter, time range and page size.

## 2. Free tier and quotas

| Item | Value | Notes |
|---|---|---|
| Cloud Logging ingestion | **50 GiB per project per month** free | Recurring allowance; applies per project [S1] |
| Default log retention | **30 days** at no retention cost | Logs retained longer are charged [S1][S2] |
| Maximum retention | 3,650 days (10 years) | Per bucket; retention beyond 30 days is billed [S3] |
| Retention overage | USD 0.01 per GiB per month beyond the default 30 days | Verified on the pricing page [S2] |
| GCP-owned metrics | All non-chargeable Google Cloud metrics are free | [S1] |
| Monitoring API reads | First **1,000,000 time series returned per billing account** per month free | Read-call allowance, not ingestion [S1] |
| Logging read quota | 60 `entries.list` requests per minute per project | Read quota [S3] |
| `timeSeries.list` page | Up to 100,000 results per page; 200 MB maximum response | Larger requests are clamped to 100,000 [S6] |
| Alert policies | 2,000 per metrics scope (up to 10,000) | [S3] |
| Notification channels | 4,000 per metrics scope | [S3] |
| Ingestion overage | Billed per GiB; exact per-GiB rate not extracted in this pass — **UNVERIFIED** | Do not estimate a price in code or docs |
| New-customer trial | Google Cloud trial credit is time-limited; amount and term not re-verified here — **UNVERIFIED** | The 50 GiB and 1M-read allowances are the recurring ones |

Cost control: one log query and at most three metric queries per bundle; retain only aggregates; set a budget alert on Monitoring read volume and log ingestion. The 50 GiB project allowance is shared by every log bucket in that project.

## 3. Auth and least privilege

Prefer Workload Identity Federation so no service-account key exists. If the worker cannot federate, use one dedicated service account with a JSON key stored server-side.

| Role | Scope | Why |
|---|---|---|
| `roles/monitoring.viewer` | Project or metrics scope | Read alert policies, notification channels, metric descriptors and time series |
| `roles/logging.viewer` | Project | Read log entries and log names; excludes private log streams |
| `roles/errorreporting.viewer` | Project | Read error groups and events |

A custom role with only `monitoring.timeSeries.list`, `monitoring.alertPolicies.get/list`, `logging.logEntries.list` and `errorreporting.events.list` is narrower, but the exact permission strings were not extracted — **UNVERIFIED**. Start with the three viewer roles and reduce after an IAM audit.

Token acquisition: Application Default Credentials in the worker; scope `https://www.googleapis.com/auth/cloud-platform` (or the narrower `monitoring.read`, `logging.read`, `cloud-platform` combination). Never place the service-account email, key ID or access token in a prompt. Rotation: WIF credentials expire automatically; a JSON key must be rotated on a 90-day schedule with one active key, and deleted after the deploy is verified.

## 4. Inbound trigger

Cloud Monitoring notification channels include webhook channels. They authenticate to the endpoint; they do **not** sign the payload.

| Property | Value |
|---|---|
| Channel types | `webhook_basicauth` (labels `url`, `username`, `password`) and `webhook_tokenauth` (labels `url`, `auth_token`) [S5] |
| Request auth | HTTP basic auth, or a token configured on the channel. The token placement is not stated on the page — **UNVERIFIED**; assume a query parameter or header and verify in the channel descriptor [S4][S5] |
| Body signature | **None documented.** No HMAC, certificate or signed timestamp is described; absence of documentation is not a positive security statement, so treat the body as untrusted [S4] |
| Payload | Alerting payload version 1.2 by default: `incident_id`, `policy_name`, `state`, `started_at`, `summary`, `labels`, `documentation`, `resource` [S4] |
| Size | The payload is small; enforce 64 KiB at the bridge and receiver regardless |
| Retries | Not documented on the retrieved page — **UNVERIFIED**; assume at-most-once and reconcile by reading the alert policy / metric, not by trusting redelivery |
| Bridge requirement | Validate the channel token or basic-auth credential in constant time, enforce a project and policy allowlist, then **re-read the alert policy and metric** before task creation, then sign with our generic HMAC |
| Receiver | `POST /api/webhooks/gcp-monitoring` with `X-Isolate-Timestamp` and `X-Isolate-Signature` over `${timestamp}.${body}` |
| Trigger filter | Only `state: "open"` creates a task; `closed` is ignored because there is no lifecycle update path |
| Severity | GCP incidents have no native severity. Read an operator label (for example `severity=critical`); default to `high`; drop `medium`/`info` at the bridge |
| Dedupe | Fingerprint `gcp:<project>:<policy_name>:<hash of sorted resource labels>`, 30-minute bucket; `incident_id` is traceability only |

The bridge must not trust `summary` or `documentation`; both are free text and may contain a runbook URL, a resource name or pasted customer data. The platform's intake performs the normal dedupe, two-task cap and 202-before-model behavior.

## 5. Read-only context

| Need | Endpoint | Parameters and bounds | Source |
|---|---|---|---|
| Alert policy | `GET https://monitoring.googleapis.com/v3/projects/{project}/alertPolicies/{policyId}` | Allowlisted policy ID; one call; read conditions and documentation only | [S6] |
| Metric shape | `GET https://monitoring.googleapis.com/v3/projects/{project}/timeSeries` | `filter=metric.type="…" AND resource.type="…"`; `interval.startTime`/`endTime`; `aggregation`; `pageSize` 60; one page | [S6] |
| Log summary | `POST https://logging.googleapis.com/v2/entries:list` | Body `resourceNames: ["projects/<id>"]`, `filter` with a log name and severity, `pageSize: 50`, `orderBy: "timestamp desc"`; one page | [S7] |
| Error groups | `GET https://clouderrorreporting.googleapis.com/v1beta1/projects/{project}/groupStats` | `serviceFilter.resourceType`, `timeRange.period=PERIOD_1_DAY`; path inferred — **UNVERIFIED** | [S8] |
| Error events | `GET https://clouderrorreporting.googleapis.com/v1beta1/{projectName}/events` | `groupId` required; `pageSize` small; one page | [S8] |

Caps: at most 6 provider calls per bundle (1 policy, 3 metric queries, 1 log query, 1 error query); 100 items (shared contract); 60 points per series; 10 series; 50 log entries; 4,000 characters per item; 256 KiB total. The log filter must name one allowlisted log and `severity>=ERROR`; `entries:list` must not run an empty filter over a whole project.

Fixed metric filter example (not model-authored):

```text
metric.type="run.googleapis.com/request_count"
AND resource.type="cloud_run_revision"
AND resource.labels.service_name="<allowlisted-service>"
```

Logging filter example:

```text
resource.type="cloud_run_revision"
AND logName="projects/<project>/logs/<allowlisted-log>"
AND severity>=ERROR
```

Never query audit logs, VPC flow logs, or `textPayload` wholesale. `jsonPayload` can contain tokens, emails and request bodies; project two or three scalar fields only, and redact before truncation.

## 6. Framework fit

| Item | Design |
|---|---|
| Module | `packages/integrations/src/gcp-monitoring/` (design only) |
| Source enum | Add `gcp_monitoring` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a **contract commit before any adapter** |
| Transport | `verifyGcpChannelToken` and `normalizeGcpIncident` in the operator bridge; `signGenericDelivery` for our HMAC |
| Reader | `fetchGcpMonitoringIncidentContext(deps, input)` with injected Google auth client, fetch and clock |
| Tools | `gcp.query_metrics` (`read_only`), `gcp.query_logs` (`read_only`), `gcp.list_error_groups` (`read_only`) |
| Risk bands | All `read_only`; no policy, channel or sink write exists |
| Env | `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_SERVICE_ACCOUNT_KEY_JSON` or `GCP_SERVICE_ACCOUNT_KEY_PATH`, `GCP_ALERT_POLICY_ALLOWLIST`, `GCP_LOG_NAME_ALLOWLIST`, `GCP_WEBHOOK_TOKEN`, `WEBHOOK_SIGNING_SECRET` |
| Audit | One row per read tool with org, task, project, template name, item count, duration and outcome; never the access token, full filter or raw log payload |

Sandbox implications: tools run in the worker, not in the sandbox; the sandbox has no Google credential and keeps egress deny. The model supplies a logical template name and an allowlisted service key, never a project ID, filter string or time range. Results are redacted and truncated before the prompt.

Tests (fakes only): channel token mismatch rejected; `state: closed` creates nothing; a forged payload without a valid channel credential is refused; the reader enforces 6 calls, 3 metric queries, 50 entries and 256 KiB; a 429 or 403 degrades to `truncated: true`; no token or log body appears in an error; cross-project access returns `NOT_FOUND`.

## 7. Operator setup checklist

1. Choose one GCP project and metrics scope. Create a dedicated service account, or a WIF pool bound to the worker identity.
2. Grant the three viewer roles (or the narrower custom role after audit). Do not grant `roles/owner`, `roles/editor`, or `roles/logging.admin`.
3. Create a webhook notification channel with token auth (or basic auth). Record the token only in the bridge's server-side secret store.
4. Create at most five production alert policies; add the channel; set a `severity` label convention. Keep `closed` incidents out of the task path.
5. Set explicit log bucket retention (30 days default; longer is billed) and restrict the allowlist to the services that own code.
6. Confirm offline gates with no Google credential, then send one test notification; verify one task, one dedupe no-op and no echo.
7. Add the credential last. This page does not authorize a live call.

```dotenv
GCP_PROJECT_ID=
GCP_SERVICE_ACCOUNT_EMAIL=
GCP_SERVICE_ACCOUNT_KEY_JSON=
GCP_SERVICE_ACCOUNT_KEY_PATH=
GCP_ALERT_POLICY_ALLOWLIST=
GCP_LOG_NAME_ALLOWLIST=
GCP_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

Names only; values are server-side and never committed, logged or placed in a fixture.

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] Bridge verifier: wrong/missing channel token rejected; 32+ character secret floor; project and policy allowlist enforced.
- [ ] Normalizer: `open` only; severity label clamped to critical/high; fingerprint stable for the same resource and policy.
- [ ] Reader fakes: 6-call, 3-query, 50-entry and 256 KiB caps; `429`, 403 and timeout set `truncated`; one page only.
- [ ] Redaction seeds for `AIza`, service-account JSON fragments, bearer tokens, emails, IPv4 and `textPayload`.
- [ ] Intake: replay in the 30-minute window creates nothing; third active incident is throttled; foreign project is `NOT_FOUND`.
- [ ] `bun run validate` twice with providers disabled.

Live (separate explicit authorization; one bounded read, no retries):

- [ ] One `timeSeries.list` call for one allowlisted metric, 60 points, one resource; record the number of time series returned against the 1M monthly allowance.
- [ ] One `entries:list` call, `pageSize: 10`, severity>=ERROR, one allowlisted log; confirm no raw payload reaches the prompt.
- [ ] Stop at the first cap; report measured usage; no retry after success.

## 9. Risks and what must never enter model context

- The webhook is unsigned and authenticated only at channel setup. A leaked token is a task-creation capability; rotate it like any webhook secret.
- Error Reporting and Logging payloads can contain stack traces, request bodies, emails, IPs and OAuth tokens. Aggregate and project scalars; never ship a whole entry.
- `roles/logging.viewer` can read every non-private log in the project. The filter allowlist is code, not a prompt instruction.
- The 1M-read allowance is per billing account; several projects and dashboards share it. Heavy metric reads are the likely overage.
- Never in context: service-account private key, access token, WIF token file, full `jsonPayload`, `textPayload`, audit logs, resource labels containing customer IDs, policy documentation with embedded URLs that carry tokens.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features) |
| S2 | [Google Cloud Observability pricing](https://cloud.google.com/products/observability/pricing) |
| S3 | [Cloud Logging quotas and limits](https://docs.cloud.google.com/logging/quotas) |
| S4 | [Create and manage notification channels](https://docs.cloud.google.com/monitoring/support/notification-options) |
| S5 | [Create and manage notification channels by API](https://docs.cloud.google.com/monitoring/alerts/using-channels-api) |
| S6 | [projects.timeSeries.list](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list) |
| S7 | [entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list) |
| S8 | [projects.events.list (Error Reporting)](https://docs.cloud.google.com/error-reporting/reference/rest/v1beta1/projects.events/list) |
