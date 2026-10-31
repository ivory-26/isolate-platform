# Grafana connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Code | none — no connector code exists in this repository |
| Free tier verified | 2026-10-31 |
| Auth model | Service-account Bearer token; Viewer plus fixed read roles |
| Inbound trigger | Grafana Alerting webhook, HMAC-SHA256 (native signature available) |
| Read context | `POST /api/ds/query`; alert-rule, annotation and data-source reads |
| Writes | None in scope (silences, annotations, alert-rule changes are a later wave) |

Nothing below is implemented. `INCIDENT_SOURCES` already contains `grafana`, but no adapter, verifier or reader exists.

## 1. Role in the agent

Grafana is a query front end over the org's existing Prometheus/Loki/Tempo data, plus an alerting engine. The webhook says which rule fired and for which labels; the query API answers "how bad, since when, and what do the logs say". The trigger is the primary value; context is second and must stay summarised, never raw series or raw log lines. Use Grafana when it is the only allowed ingress; query Prometheus/Loki directly when network and credentials already exist (see `prometheus.md` and `loki-tempo.md`).

| Incident kind | Source event | Severity input | Task-creating |
|---|---|---|---|
| `alert_firing` | `status: firing` | `labels.severity` | yes, if the production rule below passes |
| `alert_resolved` | `status: resolved` | same label | no; closes an existing task only |
| `alert_nodata` | `status: firing` with `alertname` starting `DatasourceNoData` | `warning` | no |

Severity mapping (proposed): `critical` → `critical` only when `environment`/`env` is `production`; `warning`/`error` → `high` only in production; `info` → `low`; absent → `medium`; `low`/`info` never create a task. The label is source-declared, so it is evidence that a rule fired, not proof of impact.

Fingerprint (proposed, ≤128 chars): `grafana:<ruleUID>:<first16Hex(sha256(alertname|service|env))>`. Take `ruleUID` from the provisioning API or the `generatorURL` path, not from `groupKey` (it changes with grouping) and not from `alerts[].fingerprint` alone (it changes when any label changes). The 16-hex alert fingerprint from the payload may be appended when it is stable for the rule.

Evidence added: one bounded metric window (≤20 points, ≤5 series), one bounded log tail (200 lines / 2,000 chars), the alert rule expression and for-duration, annotations (`summary`, `description`, `runbook_url`), and display-only links to the dashboard, panel and silence.

Grafana OnCall OSS is not a candidate: it entered read-only maintenance on 2025-03-11, was archived on 2026-03-24, and is replaced by Grafana Cloud IRM [G11]. Only Cloud IRM is supported today; no IRM API is in scope. Grafana SLO exists as a Cloud app with an API, but its documented setup requires an Editor service account, so it is out of scope until a read-only role is proven [G10]. Dashboards are read for links only; the legacy `/api/dashboards/*` API is being replaced by `/apis/dashboard.grafana.app/*`, and the connector does not depend on either [G13].

## 2. Free tier and quotas

| Item | Grafana Cloud Free | Grafana OSS self-hosted |
|---|---|---|
| Price | $0, "always free", no credit card [G1][G2] | No licence fee (AGPLv3) [G14] |
| Metrics | 10,000 active series [G1] | Your storage; no vendor quota |
| Logs | 50 GB ingested per month [G1] | Your storage |
| Traces | 50 GB ingested per month [G1] | Your storage |
| Profiles | 50 GB ingested per month [G1] | Not part of this connector |
| Users | 3 users, including IRM and AI users [G1] | Unlimited local users |
| Retention | 14 days for metrics, logs, traces, profiles and k6 [G1] | Set by Prometheus/Loki/Tempo, not Grafana |
| Hard limits | Free stacks are hard-limited at the plan default; 50,000 annotations and 1,000 dashboards per stack [G3] | None from Grafana |
| Overage | No paid overage on Free; the stack is hard-limited at the plan default (exact reject/queue behavior not documented) [G3] | Infrastructure cost only |
| API rate limits | No numeric per-endpoint limit published — **UNVERIFIED** | None documented in OSS |
| Trial / expiry | None; the tier does not expire [G2] | Not applicable |

Consequences: a 14-day window is the maximum queryable history on Free, and a flapping rule can exhaust 50 GB of logs quickly. Query only the incident window (15–60 minutes) and never backfill. The 50,000-annotation cap matters if the connector later writes annotations.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Bearer <service-account-token>` [G9] |
| Identity | One service account per tenant/stack; basic auth only for on-prem and not used here [G9] |
| Query permission | `datasources:query`, carried by fixed role `fixed:datasources:reader`; the data-source HTTP page also uses the name `datasources:read` for the same capability — **exact action string UNVERIFIED** [G5][G8] |
| Discovery | `datasources:read` for `GET /api/datasources`; resolve UIDs at setup, not per task [G4] |
| Alert rules | `alert.rules:read`, fixed role `fixed:alerting.rules:reader` [G8] |
| Annotations | `annotations:read`, fixed role `fixed:annotations:reader` [G8] |
| Suggested basic role | Viewer, which can read and query data sources [G8] |
| Token lifetime | Service-account tokens support an expiry; the default was not extracted — **UNVERIFIED**; set 90 days [G9] |
| Rotation | Create a second token on the same service account, deploy it, verify, then delete the first |

Least privilege warning: the Viewer role can query **any** data source in the organization, including ones unrelated to the incident. If data-source-level permissions are unavailable in the deployed edition, use a dedicated stack or organization for the connector; do not rely on dashboard permissions to constrain the API. **UNVERIFIED** whether data-source permissions are available in Grafana OSS.

Never use an Admin token or a personal user token. Writes (silence, annotation, alert-rule change) need a separate identity and approval, and are not part of this connector.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/<segment>` on the Isolate host, reached through the generic receiver or a dedicated adapter |
| Signature header | Default `X-Grafana-Alerting-Signature`; the header name is configurable [G4] |
| Algorithm | HMAC-SHA256, hex-encoded [G4] |
| Signed string | `<timestamp>:<rawBody>` when a timestamp header is configured; body only otherwise [G4] |
| Timestamp | Header name is operator-supplied with no default; without it there is no replay protection [G4] |
| Replay window | Enforce ±300 s on the configured timestamp header; reject a delivery without it |
| Dedupe key | `grafana:<ruleUID>:<stable-label-hash>`; never `groupKey`, `orgId`, or a timestamp |
| Body cap | 64 KiB (platform default); a large alert group exceeds it |
| Retries | Not documented on the notifier page — **UNVERIFIED** [G4] |

Payload (Alertmanager-compatible, `version: "1"`): `receiver`, `status`, `orgId`, `alerts[]`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`, `version`, `groupKey`, `truncatedAlerts`, `state`, `title`, `message` [G4]. Each alert carries `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `generatorURL`, `fingerprint`, `silenceURL`, `dashboardURL`, `panelURL`, `values` [G4].

**Bridge requirement.** The current receiver selects GitHub mode only when `x-github-event` is present and otherwise requires `X-Isolate-Signature` over `${timestamp}.${body}` with a strict `IncidentSignal` body (`apps/web/src/server/incident-intake.server.ts`). Grafana's signed string can be aligned with the generic scheme by naming its timestamp and signature headers accordingly, but the header value format (raw hex versus a `sha256=` prefix) was not extracted — **UNVERIFIED** — and its body is an alert group, not an `IncidentSignal`; the strict schema rejects it with `400`. Therefore a small bridge must (a) receive the Grafana delivery, (b) verify the Grafana HMAC over the raw bytes, (c) normalise to `IncidentSignal`, and (d) re-sign with `WEBHOOK_SIGNING_SECRET`. A native adapter must extend mode detection before it can verify Grafana deliveries directly; the enum value `grafana` does not make the transport accept them.

Set the contact point's notification policy to send one alert group per delivery and keep `max_alerts`-equivalent grouping small. A resolved notification must not create a task.

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Metric window | `POST /api/ds/query` | Body: `from`, `to`, `queries[]` with `datasource.uid`, `expr`/`query`, `maxDataPoints`, `intervalMs`, `format` | [G5] |
| Log tail | `POST /api/ds/query` | Same body; Loki datasource UID; `limit` in the expression; `format: "table"` or `"time_series"`; response summarised, never stored raw | [G5] |
| Alert rule | `GET /api/v1/provisioning/alert-rules/{uid}` | Rule title, condition, `for`, labels, annotations, data source UIDs | [G6] |
| Rule list (setup only) | `GET /api/v1/provisioning/alert-rules` | Resolve UID to title once; not called per incident | [G6] |
| Annotations | `GET /api/annotations?from=&to=&tags=&limit=` | `from`/`to` epoch ms; `limit` max 100; deployment markers | [G7] |
| Data sources (setup only) | `GET /api/datasources` | UID and type allowlist; never read credentials | [G5] |
| Dashboard link | Display only | `dashboardURL`, `panelURL` from the payload; do not fetch the dashboard JSON | [G4] |

Fixed call order: verify and normalise → read the firing rule (one call) → one metric query bounded to `startsAt − 15 min` through `now` → optionally one log query for the same window and service → annotations for the window (one call, `limit=20`) → assemble. At most **4** Grafana calls per bundle; no model-authored query, datasource UID or time range.

Pagination: not applicable to `/api/ds/query`; annotation reads are capped by `limit` (max 100) and the rule list is read once at setup. No endpoint is paged per incident.

Caps: 100 items / 4,000 chars per excerpt / 256 KiB total (shared contract, `packages/shared/src/types/incident.ts`). Within that: 1 metric item ≤5 series and ≤20 points rendered as a ≤1,500-char summary; 1 log item ≤200 lines and ≤2,000 chars; 1 rule item; ≤10 annotation items. The prompt renderer currently enforces the same 100 / 4,000 / 256 KiB caps (`apps/worker/src/task-execution-handler.ts`); a bundle over them is marked `(truncated)`.

Never fetch: the full dashboard JSON, full rule history, all label values, all log lines for a matcher, `/api/ds/query` with an unbounded range, or any URL supplied by the payload (`generatorURL` is display-only and often points at an internal host).

## 6. Framework fit

Proposed module: `packages/integrations/src/grafana/`.

Source enum: `grafana` already exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`), so no contract change is required for this connector; `ContextItem.source` uses the same enum.

| Function | Purpose |
|---|---|
| `verifyGrafanaWebhook(rawBody, headers, secret)` | Constant-time HMAC-SHA256 over `<timestamp>:<body>`, mandatory timestamp, ±300 s, 64 KiB cap, fixed error codes |
| `normalizeGrafanaIncident(payload, {ruleUid})` | Strict payload subset → `IncidentSignal`; severity and fingerprint rules; rejects unknown fields |
| `fetchGrafanaContext(deps, input)` | Fixed 4-call plan, redaction before truncation, `truncated` on any omitted evidence |

Environment variables (names only):

| Variable | Purpose |
|---|---|
| `GRAFANA_BASE_URL` | Stack URL, https, no userinfo |
| `GRAFANA_TOKEN` | Service-account token |
| `GRAFANA_ORG_ID` | Numeric org id for `X-Grafana-Org-Id` when the stack has several orgs |
| `GRAFANA_WEBHOOK_SECRET` | Grafana HMAC secret (bridge verifier) |
| `GRAFANA_WEBHOOK_TIMESTAMP_HEADER` | Header name configured on the contact point |
| `GRAFANA_DATASOURCE_UID_METRICS` | Prometheus datasource UID |
| `GRAFANA_DATASOURCE_UID_LOGS` | Loki datasource UID |

Proposed agent tools:

| Tool | Risk band | Behavior |
|---|---|---|
| `grafana.query_metrics` | `read_only` | One templated PromQL expression, bounded range and points |
| `grafana.query_logs` | `read_only` | One templated LogQL expression, tail-limited, redacted |
| `grafana.get_alert_rule` | `read_only` | Rule metadata for a UID from the signal |
| `grafana.create_silence` | `sensitive` | Not in scope; separate identity, approval, audit |
| `grafana.annotate` | `scoped_write` | Not in scope; audited, payload SHA bound |

Adding any tool requires extending the `ToolName` union, `SANDBOX_TOOL_RISKS`, `createSandboxToolImplementations` and the registry; a risk entry alone is not enough. Under `createRiskTablePolicy`, `read_only` and `scoped_write` proceed audited, `sensitive` returns `APPROVAL_REQUIRED`, `destructive` is denied.

Sandbox implications: these tools execute in the worker, server-side. Sandbox egress stays deny; the Grafana token never enters the sandbox environment, a tool argument, the prompt or a log. Tool results are bounded and redacted before return, and every write appends `audit_events` with `action = tool.execute`, `details.tool`, `details.risk`, `details.outcome` and a bounded failure code.

Tests (fakes only): valid/invalid/stale/no-timestamp signatures; oversized body; rule and alert normalisation; fingerprint stability under label churn; query template cannot be influenced by payload text; redaction seeds in labels, annotations and log lines; `429` and timeout mapping; tenant isolation; `truncated` when a series or call is dropped.

## 7. Operator setup checklist

1. Choose Cloud or self-hosted and record the stack URL and region.
2. Create a Viewer service account; assign `fixed:datasources:reader`, `fixed:alerting.rules:reader`, `fixed:annotations:reader`; mint one token with a 90-day expiry.
3. Resolve the Prometheus and Loki datasource UIDs; store them in configuration, not in prompts.
4. Add a webhook contact point with the Isolate bridge URL, signature header `X-Grafana-Alerting-Signature`, a random secret of at least 32 characters, and a timestamp header.
5. Route only production rules at `critical`/`warning` to that contact point; route resolved notifications to the same bridge for task closure, not creation.
6. If bypassing the bridge, extend intake mode detection and the strict body schema first; do not widen the generic schema to accept alert groups.
7. Offline gates twice with providers disabled, then one bounded live delivery and one bounded query.
8. Record the rotation date; never place a token or secret in this repository, a ticket or a prompt.

```dotenv
GRAFANA_BASE_URL=
GRAFANA_TOKEN=
GRAFANA_ORG_ID=
GRAFANA_WEBHOOK_SECRET=
GRAFANA_WEBHOOK_TIMESTAMP_HEADER=
GRAFANA_DATASOURCE_UID_METRICS=
GRAFANA_DATASOURCE_UID_LOGS=
```

## 8. Acceptance checklist

Offline first (no network):

- [ ] Valid signature over `timestamp:body` accepted; tampered body, wrong secret, missing timestamp and 301 s skew rejected with fixed errors.
- [ ] 65 KiB body is `413`; no secret or payload text in any error.
- [ ] `firing` + production + `critical` produces one signal; `resolved`, `info` and non-production `warning` create nothing.
- [ ] Fingerprint is identical for a redelivery and changes only for a different rule/service/environment.
- [ ] Reader makes at most 4 calls, caps series/points/lines, redacts before truncation and sets `truncated`.
- [ ] `429` and timeout fail closed with no partial secret-bearing output.

Live (one bounded call, explicit authorization, no retries):

- [ ] One `POST /api/ds/query` returns a bounded series for a disposable metric window; assert ≤5 series and ≤20 points.
- [ ] One signed test alert creates exactly one task; a replay is deduped; assert one `incident_signals` row when the SQL-backed store is used.
- [ ] No token, header value or raw log line appears in the prompt, audit row or response. Free tier has no metered spend to record.

## 9. Risks / never in model context

Risks: Viewer can query every data source in the org; alert labels often contain customer ids; a flapping label set creates many fingerprints; the 64 KiB cap can drop a large alert group; Grafana Cloud Free retains only 14 days; OnCall OSS is archived, so any design that assumed it is invalid.

Never in model context: the service-account token, webhook secret, `Authorization` header or cookies; raw Prometheus series, full label sets, raw Loki lines or full log windows; dashboard JSON; full alert-rule history; `generatorURL` query strings that embed credentials or internal hostnames; silence comments and free-form annotations without redaction; user emails or ids from labels.

## 10. Sources

All accessed 2026-10-31.

| ID | Source | URL |
|---|---|---|
| G1 | Grafana pricing (Free plan inclusions) | https://grafana.com/pricing/ |
| G2 | What's included in Grafana Cloud Free | https://grafana.com/products/cloud/free-tier/ |
| G3 | Grafana Cloud usage limits | https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/usage-limits/ |
| G4 | Webhook notifier for Alerting (HMAC, payload, options) | https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/ |
| G5 | Data source HTTP API (`/api/ds/query`) | https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/ |
| G6 | Alerting provisioning HTTP API | https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/alerting_provisioning/ |
| G7 | Annotations HTTP API | https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/annotations/ |
| G8 | RBAC fixed and basic role definitions | https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/rbac-fixed-basic-role-definitions/ |
| G9 | Service accounts (Bearer token, optional expiry) | https://grafana.com/docs/grafana/latest/administration/service-accounts/ |
| G10 | Grafana SLO HTTP API | https://grafana.com/docs/plugins/grafana-slo-app/latest/set-up/api/ |
| G11 | Grafana OnCall OSS maintenance mode and archive | https://grafana.com/blog/grafana-oncall-maintenance-mode/ |
| G13 | Dashboard HTTP API (legacy replacement notice) | https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/dashboard/ |
| G14 | Grafana OSS licence (AGPLv3) | https://raw.githubusercontent.com/grafana/grafana/main/LICENSE |
