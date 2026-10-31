# Prometheus connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Code | none — no connector code exists in this repository |
| Free tier verified | 2026-10-31 |
| Auth model | No native user auth; basic auth/TLS at the server or a reverse proxy; Bearer token upstream |
| Inbound trigger | Alertmanager `webhook_configs` (unsigned) through the generic bridge |
| Read context | PromQL `/api/v1/query` and `/api/v1/query_range`; rules and active alerts |
| Writes | None in scope; Alertmanager silences would be `sensitive` |

Nothing below is implemented. Prometheus and Alertmanager are free OSS, self-hosted only; there is no vendor account to create.

## 1. Role in the agent

Prometheus answers "what changed, how bad, and since when" for a service that already has metrics. Alertmanager turns a rule into a firing notification; Prometheus's query API turns the alert into a bounded numeric summary. The trigger is useful, but the context is the primary value: an alert name alone does not localise a defect, while a 20-point window around `startsAt` shows whether the change is a spike, a plateau or a step.

| Incident kind | Source event | Severity input | Task-creating |
|---|---|---|---|
| `alert_firing` | Alertmanager `status: firing` | `labels.severity` | yes, when the production rule passes |
| `alert_resolved` | `status: resolved` | same label | no; closes an existing task only |
| grouped delivery | one webhook with several alerts | highest severity in the group | one `alert_firing` signal per alert, not per group |

Severity mapping (proposed): `critical` or `page` → `critical` only when `env`/`environment` is `production`; `warning` or `error` → `high` only in production; `info` → `low`; absent → `medium`. `low`/`info` never create a task. The label is source-declared; the production label is the gate, not the severity string alone.

Fingerprint (proposed, ≤128 chars): `prometheus:<alertname>:<service>:<env>:<first16Hex(sha256(sorted stable labels))>`. Stable labels are `alertname`, `service`, `env`, `cluster`, `namespace`, `severity`. Exclude `pod`, `instance`, `container`, `endpoint`, `le`, `quantile` and any label that changes per replica; otherwise one incident becomes dozens of tasks. Alertmanager's own `alerts[].fingerprint` is a documented field but its derivation was not extracted — **UNVERIFIED**; use it only as an extra component, never as the sole key. Never use `groupKey` (it changes with grouping) or a delivery timestamp.

Evidence added: one instant value at `startsAt` (or the last 15 minutes), one range summary (≤20 points, ≤5 series), the firing rule expression and `for` duration, the alert's `annotations.summary`/`description`/`runbook_url`, and the active-alert state. `generatorURL` and `externalURL` are display-only and may point at internal hosts.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| Licence / price | Apache 2.0; no licence fee, no SaaS tier from the project | [P8] |
| Hosting | Self-hosted only; infrastructure cost is yours | [P8] |
| Metrics quota | None from Prometheus; disk and cardinality are the limit | [P4] |
| Retention (time) | 15 days by default (`--storage.tsdb.retention.time`) | [P4] |
| Retention (size) | Disabled by default (`0`); set a size cap | [P4] |
| Query timeout | 2 minutes (`--query.timeout`) | [P3] |
| Query samples | 50,000,000 per query (`--query.max-samples`) | [P3] |
| Query concurrency | 20 (`--query.max-concurrency`) | [P3] |
| Rate limits | No per-tenant rate limit in OSS; the reverse proxy or a gateway must add one | [P7] |
| Trial / expiry | None; OSS has no expiry | [P8] |
| Alertmanager | Apache 2.0, free; no delivery quota documented | [P1] |

There is no overage billing and no free-tier series count: the connector must impose its own budget (calls, series, points) because exceeding `query.max-samples` returns an error and a heavy query can exhaust the server. The 15-day retention means an incident older than that has no metrics evidence; do not silently treat missing data as healthy.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Native auth | Prometheus supports basic authentication and TLS via `--web.config.file`; it has no user directory or role model [P6] |
| Recommended edge | Reverse proxy or gateway terminates mTLS/Basic/Bearer, allowlists paths, and forwards only to the read API [P7] |
| Read header | `Authorization: Bearer <proxy-issued-token>` at the proxy; Prometheus itself sees a trusted upstream request |
| Alertmanager outbound | `http_config` supports `basic_auth`, `authorization`, `oauth2`, `bearer_token_file`, `tls_config` and `proxy_url` [P1] |
| Token lifetime | Proxy credential; set 90 days and rotate on a schedule. Prometheus has no token to expire |
| Rotation | Add the new proxy credential, deploy the bridge, verify one query, remove the old credential |
| Scopes | No scope system. Enforce read-only paths at the proxy |

Least privilege is path-based. Allow only `/api/v1/query`, `/api/v1/query_range`, `/api/v1/alerts`, `/api/v1/rules`, `/api/v1/labels`, `/api/v1/label/*` and `/api/v1/series`. Deny `/-/quit`, `/-/reload`, `/api/v1/admin/*` (including `delete_series`), `/api/v1/read` if remote read is not needed, the remote-write receiver, and `/graph` unless a human uses it. A read token placed in front of the admin API is a delete credential.

Alertmanager's webhook has no signature. Authenticate the sender at the proxy (mTLS or Basic), and never accept a webhook from the public internet without the bridge.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/prometheus` on the Isolate host, via the bridge |
| Signature header | **No HMAC in Alertmanager** [P1]; the bridge verifies proxy Basic/mTLS and signs `X-Isolate-Signature` |
| Bridge algorithm | HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, constant-time compare |
| Timestamp | Bridge-generated `X-Isolate-Timestamp`, ±300 s |
| Dedupe key | `prometheus:<alertname>:<service>:<env>:<stable-label-hash>` |
| Body cap | 64 KiB; set `max_alerts: 10` so one group cannot exceed it |
| Retries | Alertmanager retries notification delivery; the exact policy was not extracted — **UNVERIFIED** [P1] |
| Grouping | `group_by`, `group_interval` and `repeat_interval` cause repeat deliveries; fingerprint dedupe absorbs them |

Payload (`version: "4"`): `version`, `groupKey`, `truncatedAlerts`, `status`, `receiver`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`, `notification_reason`, `alerts[]` [P1]. Each alert: `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `generatorURL`, `fingerprint` [P1]. `send_resolved` defaults to `true`; `max_alerts` defaults to `0`, meaning no limit [P1].

Bridge flow: proxy-authenticated Alertmanager → verify the source → parse the strict `version: "4"` subset → map each alert to `IncidentSignal` with `source: "prometheus"` (only after the enum is extended; use `generic` until then) → re-sign as the generic body → `202` before any model work. A resolved alert is a state update, not a new task. One webhook with N alerts yields at most N signals and is deduped per fingerprint.

## 5. Read-only context

| Need | Endpoint | Parameters / notes | Source |
|---|---|---|---|
| Instant value | `GET/POST /api/v1/query` | `query`, `time`, `timeout`; one expression | [P2] |
| Range window | `GET/POST /api/v1/query_range` | `query`, `start`, `end`, `step`, `timeout`; step chosen for ≤20 points | [P2] |
| Firing alerts | `GET /api/v1/alerts` | Active alerts with labels, annotations, state, value | [P2] |
| Rule definition | `GET /api/v1/rules?type=alert` | Rule name, expression, `for`, labels; filter to the rule in the signal | [P2] |
| Label names | `GET /api/v1/labels` | Setup only; never dump all values into a bundle | [P2] |
| Series | `GET /api/v1/series` | `match[]`, `start`, `end`; high cardinality, avoid in bundles | [P2] |
| Remote read | `POST /api/v1/read` | Snappy/protobuf, not a stable API; **not used** | [P5] |

Fixed call order: normalize the alert → one instant query at `startsAt` or `now − 5 min` → optionally one range query covering `startsAt − 10 min` to `now` with a step producing ≤20 points → one `/api/v1/rules` read to capture the expression and `for`. At most **3** Prometheus calls per bundle; no model-authored PromQL, no label selector constructed from payload text beyond the allowlisted `service`/`env`.

Pagination: not applicable to PromQL. `/api/v1/series` has a limit parameter whose semantics were not extracted — **UNVERIFIED**; bound its time range instead and read one page.

Caps: 100 items / 4,000 chars per excerpt / 256 KiB total. Within that: 1 metric item with ≤5 series and ≤20 points rendered as a ≤1,500-char summary (metric name, selected labels, min/max/last, direction); 1 rule item ≤4,000 chars; ≤5 related alerts. Mark `truncated` when a series, call or point is dropped.

Never fetch: all series for a broad selector, `{__name__=~".+"}`, full label values, raw samples beyond the window, remote-read blocks, `/api/v1/admin/*`, `/-/quit`, `/-/reload`, or the full rule file. Response codes: `400` bad parameter, `422` invalid expression, `503` timeout/cancel [P2].

## 6. Framework fit

Proposed module: `packages/integrations/src/prometheus/`.

Source enum: `prometheus` is **not** in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`), and `ContextItem.source` reuses that enum. Add `prometheus` in a shared-contract commit before the adapter; until then the bridge must send `source: "generic"`, which loses provenance.

| Function | Purpose |
|---|---|
| `verifyPrometheusWebhook(rawBody, headers, secret)` | Bridge verifier only: HMAC over `${timestamp}.${body}`, ±300 s, 64 KiB, fixed errors. Not an Alertmanager signature |
| `normalizePrometheusIncident(payload, {cluster})` | Strict `version: "4"` subset → one `IncidentSignal` per firing alert; production gate, severity map, stable fingerprint |
| `fetchPrometheusContext(deps, input)` | Fixed 3-call plan, step calculation, summary rendering, redaction before truncation |

Environment variables (names only):

| Variable | Purpose |
|---|---|
| `PROMETHEUS_BASE_URL` | Read API origin, https, no userinfo or query |
| `PROMETHEUS_TOKEN` | Bearer credential presented to the proxy |
| `PROMETHEUS_ALERTMANAGER_URL` | Alertmanager origin for rule/silence metadata, if used |
| `PROMETHEUS_WEBHOOK_SECRET` | Bridge HMAC secret |
| `PROMETHEUS_CLUSTER_ID` | Cluster label added to the fingerprint and context |
| `PROMETHEUS_ORG_ID` | Not applicable to OSS; reserved if a multi-tenant gateway is used |

Proposed agent tools:

| Tool | Risk band | Behavior |
|---|---|---|
| `prometheus.query` | `read_only` | One templated instant PromQL query |
| `prometheus.query_range` | `read_only` | One templated range query, bounded step and points |
| `prometheus.list_alerts` | `read_only` | Active alerts filtered to the signal's service |
| `prometheus.get_rule` | `read_only` | Rule expression and `for` for the alert name |
| `prometheus.silence` | `sensitive` | Not in scope; separate credential, approval, audit |

Tools execute server-side in the worker. Sandbox egress stays deny; the proxy token never enters the sandbox environment, a tool argument, a prompt or a log. Results are summarised, bounded and redacted before returning; every tool call is audited with `action = tool.execute`, `details.tool`, `details.risk` and `details.outcome`. Extending the tool surface requires the `ToolName` union, `SANDBOX_TOOL_RISKS`, the implementation map and the registry; `createRiskTablePolicy` denies `destructive` outright and returns `APPROVAL_REQUIRED` for `sensitive`.

Tests (fakes only): payload version and unknown-field rejection; one signal per alert; resolved does not create; fingerprint stable under pod churn; production gate; query template not influenced by annotations; `400`/`422`/`503` mapping; redaction seeds in labels and annotations; tenant isolation; no secret in errors.

## 7. Operator setup checklist

1. Put Prometheus behind a reverse proxy with TLS; allowlist the read paths in §3 and deny the admin and lifecycle paths.
2. Create a read-only proxy credential; store it server-side and set a 90-day rotation date.
3. Configure Alertmanager `webhook_configs` with the bridge URL, `send_resolved: true`, `max_alerts: 10` and `http_config` mTLS or Basic auth.
4. Set `group_by` to stable labels only (`alertname`, `service`, `env`, `cluster`); avoid `pod` and `instance` grouping.
5. Decide the label convention: `service`, `env`, `severity`, `runbook_url`; document it and reject alerts without `service`.
6. Run the bridge in the same trust zone as the receiver; it must verify before parsing and sign before forwarding.
7. Offline gates twice with providers disabled; then one bounded live query and one test alert.
8. Never expose Alertmanager or Prometheus directly to the public internet; never store the proxy credential in this repository.

```dotenv
PROMETHEUS_BASE_URL=
PROMETHEUS_TOKEN=
PROMETHEUS_ALERTMANAGER_URL=
PROMETHEUS_WEBHOOK_SECRET=
PROMETHEUS_CLUSTER_ID=
```

## 8. Acceptance checklist

Offline first:

- [ ] Bridge verifier accepts a valid HMAC, rejects tampering, missing timestamp, 301 s skew and a 65 KiB body.
- [ ] A `version: "4"` fixture with 3 firing alerts yields 3 signals; a resolved fixture yields none.
- [ ] Fingerprint is identical across a repeat delivery and different across services; pod churn does not change it.
- [ ] Production gate: `critical` outside production does not create a task.
- [ ] Reader caps series/points, renders a summary rather than raw samples, redacts before truncation and sets `truncated`.
- [ ] `422` and `503` map to bounded errors; no expression or token appears in the message.

Live (one bounded call, no retries):

- [ ] One instant query for a disposable metric returns one vector; assert the response is summarised to ≤1,500 chars and no raw samples reach the prompt.
- [ ] One bridge-signed Alertmanager delivery creates exactly one task; a replay returns `202 {deduped:true}`.
- [ ] Assert the audit/prompt contains no proxy credential and no full label set. OSS has no metered spend.

## 9. Risks / never in model context

Risks: an unbounded PromQL query can OOM Prometheus or hit `query.max-samples`; high-cardinality labels (customer id, URL, pod) leak PII and explode the bundle; Alertmanager has no signature, so an exposed webhook is spoofable; grouping and repeat intervals create storms; 15-day retention silently truncates history; remote read is explicitly not a stable API.

Never in model context: `Authorization` headers, proxy credentials, Alertmanager `http_config` secrets; raw time series or full label sets; `__name__` inventories; all active alerts for the whole estate; rule files; `generatorURL` query strings with credentials or internal hostnames; any admin endpoint response.

## 10. Sources

All accessed 2026-10-31.

| ID | Source | URL |
|---|---|---|
| P1 | Alertmanager configuration (`webhook_config`, payload) | https://prometheus.io/docs/alerting/latest/configuration/ |
| P2 | Prometheus HTTP API (query, query_range, alerts, rules, errors) | https://prometheus.io/docs/prometheus/latest/querying/api/ |
| P3 | Prometheus command-line flags (timeout, samples, concurrency) | https://prometheus.io/docs/prometheus/latest/command-line/prometheus/ |
| P4 | Prometheus storage (retention defaults and flags) | https://prometheus.io/docs/prometheus/latest/storage/ |
| P5 | Remote read API (protobuf/snappy, stability caveat) | https://prometheus.io/docs/prometheus/latest/querying/remote_read_api/ |
| P6 | HTTPS and authentication (`--web.config.file`) | https://prometheus.io/docs/prometheus/latest/configuration/https/ |
| P7 | Prometheus security model (reverse proxy guidance) | https://prometheus.io/docs/operating/security/ |
| P8 | Prometheus licence (Apache 2.0) | https://raw.githubusercontent.com/prometheus/prometheus/main/LICENSE |
