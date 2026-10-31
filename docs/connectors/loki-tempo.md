# Loki and Tempo connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Code | none — no connector code exists in this repository |
| Free tier verified | 2026-10-31 |
| Auth model | No native auth; reverse proxy or Grafana Cloud access-policy Bearer token |
| Inbound trigger | None native; Grafana/Alertmanager alert via the generic bridge |
| Read context | Loki `query_range`; Tempo trace-by-ID and TraceQL search |
| Writes | None in scope |

Nothing below is implemented. Loki and Tempo are free OSS when self-hosted; Grafana Cloud Free covers a small volume with 14-day retention.

## 1. Role in the agent

Loki and Tempo are **context sources, not triggers**. They answer "what did the service log around the failure" and "where did the request spend its time". A log stream has no incident identity of its own: a detector (Grafana rule, Loki ruler, Alertmanager) must produce the signal, and the connector then fetches a bounded tail for that service and window. Tempo is read by trace id from an alert annotation, dashboard link or log line; it is never used to browse all traces.

| Incident kind | Produced by | Severity | Fingerprint |
|---|---|---|---|
| `log_error_burst` | Grafana/Loki ruler alert via bridge | alert label `severity` | `loki:<service>:<level>:<patternHash>` |
| `trace_latency` | Grafana/Alertmanager rule with a trace id | alert label `severity` | `tempo:<service>:<operation>:<statusClass>` |

Severity mapping follows the detector: `critical`/`page` → `critical` only in production; `warning`/`error` → `high` in production; `info` → `low`; absent → `medium`. Because the alert is the authority, the connector must not invent severity from log level alone. `patternHash` is the first 16 hex of SHA-256 over a normalised message template (numbers, UUIDs, IPs and durations replaced with placeholders), so a repeating error maps to one fingerprint while a different error maps to another. A raw trace id must never be a fingerprint: every request has a unique id, so it would create a task per request.

Evidence added: one log excerpt (last 200 lines, 2,000 chars, redacted), selected structured metadata (`service_name`, `level`, `trace_id`), one trace summary (service, operation, duration, status, error type, ≤20 spans), and links to Grafana Explore or the trace UI. Raw log bodies and full span attributes never enter the bundle.

## 2. Free tier and quotas

| Item | Self-hosted OSS | Grafana Cloud Free |
|---|---|---|
| Loki licence / price | AGPLv3, no fee [L11] | $0 "always free" [L7] |
| Tempo licence / price | AGPLv3, no fee [L12] | $0 "always free" [L7] |
| Logs ingest | Your storage; no vendor quota | 50 GB per month [L7] |
| Traces ingest | Your storage; no vendor quota | 50 GB per month [L7] |
| Metrics (shared stack) | Not part of this connector | 10,000 active series [L7] |
| Users | Unlimited local | 3 users, including IRM/AI [L7] |
| Retention | Loki: **disabled by default**, logs live forever unless the compactor deletes them [L2]; Tempo: compactor `block-retention`, default not stated — **UNVERIFIED** [L6] | 14 days for logs and traces [L7] |
| Overage | Infrastructure cost only | Hard-limited at the plan default; no paid overage on Free [L7] |
| Rate limits | `limits_config` per tenant (query length, series, entries) | Per-tenant Cloud limits; numeric values not published — **UNVERIFIED** |
| Trial / expiry | None | None; the tier does not expire [L7] |

Operational consequence: self-hosted Loki is not a retention-controlled store until the compactor is enabled. Set `compactor.retention_enabled: true` and a `limits_config.retention_period`; per-stream `retention_stream` has a 24-hour minimum [L2]. The connector must not assume that an old log still exists: it queries a narrow window and reports the window it actually covered.

Loki's query limits are configuration values, including `max_entries_limit_per_query`, `max_query_series` and `max_query_length` [L8]. Their defaults are not printed on the pages read — **UNVERIFIED**. The connector clamps its own `limit` and never relies on the server default.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Native auth | None in OSS. `X-Scope-OrgID` selects a tenant; it is **not** authentication and must never be accepted from a caller [L1] |
| Edge | Reverse proxy terminates mTLS, Basic or Bearer, allowlists `/loki/api/v1/*` or `/api/*`, and injects `X-Scope-OrgID` from server config |
| Cloud token | Grafana Cloud access-policy token with `logs:read` and `traces:read` (and `metrics:read` only if metrics are queried) [L10] |
| Header | `Authorization: Bearer <token>`; Cloud data-source URLs are per-stack |
| Token lifetime | Access-policy tokens support an expiry; set 90 days and rotate [L10] |
| Rotation | Create the new token/policy, deploy, run one query, delete the old token. Never overlap two active secrets in the bridge |
| Scopes | Read only. No push, no delete, no ruler write, no OTLP ingestion |

Do not grant `logs:write` or `traces:write`: the connector never ingests. On self-hosted Loki, a single tenant is the safest deployment; multi-tenant mode adds an `X-Scope-OrgID` spoofing risk if the proxy forwards a caller-supplied header.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | None native. `POST /api/webhooks/loki-tempo` via the bridge, when a detector fires |
| Signature header | **No HMAC in Loki or Tempo**; the bridge verifies the upstream (Grafana HMAC, Alertmanager proxy auth) and signs `X-Isolate-Signature` |
| Bridge algorithm | HMAC-SHA256 over `${timestamp}.${body}`, hex, constant-time compare |
| Timestamp | Bridge-generated `X-Isolate-Timestamp`, ±300 s |
| Dedupe key | `loki:<service>:<level>:<patternHash>` or the detector's alert fingerprint; never a trace id |
| Body cap | 64 KiB; one signal per delivery, never one per log line |
| Retries | Inherited from Grafana/Alertmanager; not documented for Loki itself — **UNVERIFIED** |

Loki's ruler can send Alertmanager-compatible notifications to Alertmanager, and Grafana Alerting can query Loki directly [L1]. Either path ends at the same bridge: verify the upstream, normalise to `IncidentSignal`, re-sign for the generic receiver. A resolved notification updates state and does not create a task. There is no native Loki or Tempo webhook to extend; a dedicated adapter would only replace the bridge's normaliser, not add a signature.

## 5. Read-only context

| Need | Endpoint | Parameters / notes | Source |
|---|---|---|---|
| Log range | `GET/POST /loki/api/v1/query_range` | `query`, `start`, `end`, `limit` (default 100), `direction=backward`, `step`, `interval`; response `streams[].values[[ts,line]]` | [L1] |
| Log instant | `GET/POST /loki/api/v1/query` | Point-in-time query; not used for the tail | [L1] |
| Labels (setup) | `GET /loki/api/v1/labels` | Resolve the allowlisted stream labels once | [L1] |
| Series (setup) | `GET /loki/api/v1/series` | Bounded `match[]`; never enumerate the estate | [L1] |
| Trace by id | `GET /api/v2/traces/{traceID}?start=&end=` | Current API; V1 is deprecated | [L4] |
| Trace search | `GET /api/search?q=<TraceQL>&start=&end=&limit=` | One bounded query; result used only to find a trace id | [L4] |
| Search tags | `GET /api/v2/search/tags` | Setup/debug only | [L4] |
| OTLP ingest | Loki `/otlp/v1/logs`; Tempo `4317`/`4318` | Ingestion endpoints, **not used by this connector** | [L3][L5] |

Fixed call order: resolve the service selector and time window from the signal → one `query_range` with `limit=50`, `direction=backward` → if a trace id is present in the structured metadata or annotation, one trace-by-id call → assemble. At most **2** Loki/Tempo calls per bundle. No model-authored LogQL, TraceQL, stream selector or time range.

Pagination: not applicable. `limit` (default 100) and `direction=backward` define the tail; the server-side per-query entries cap is configuration and its default was not extracted — **UNVERIFIED** [L8]. Never paginate a log query to obtain "the rest".

Caps: 100 items / 4,000 chars per excerpt / 256 KiB total. Within that: 1 log item with the **last 200 lines and at most 2,000 chars**, first error line preserved; 1 trace item with ≤20 spans and ≤2,000 chars of selected attributes; `truncated` when lines, spans or calls are dropped. Redact before truncation so a secret split at the cut point cannot survive. The prompt renderer applies the same 100 / 4,000 / 256 KiB caps (`apps/worker/src/task-execution-handler.ts`).

Never fetch: the whole log stream, `/loki/api/v1/tail` (streaming and unbounded), all labels or label values, every trace for a service, full trace search results, span attributes outside the allowlist, or any URL supplied by a log line. Never enable the OTLP receiver to pull data into Isolate; OTLP is for the customer's collectors.

## 6. Framework fit

Proposed module: `packages/integrations/src/loki-tempo/` (one package, two readers), or `loki/` and `tempo/` if the teams differ.

Source enum: neither `loki` nor `tempo` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`), and `ContextItem.source` reuses that enum. Add both in a shared-contract commit before the adapter; until then the bridge sends `source: "generic"`. If the data is queried through Grafana only, `source: "grafana"` already exists, but the item kind should still say `log_excerpt` or `trace`.

| Function | Purpose |
|---|---|
| `verifyLokiWebhook(rawBody, headers, secret)` | Bridge verifier for the detector delivery; no native Loki signature exists |
| `normalizeLokiIncident(payload, {service})` | Strict detector payload → `IncidentSignal`; pattern fingerprint, no trace ids |
| `fetchLokiContext(deps, input)` | One bounded `query_range`, allowlisted labels, tail rendering, redaction |
| `fetchTempoContext(deps, input)` | One trace by id, span allowlist, summary rendering, redaction |

Environment variables (names only):

| Variable | Purpose |
|---|---|
| `LOKI_BASE_URL` | Loki gateway or Cloud logs URL, https |
| `LOKI_TOKEN` | Bearer token (Cloud access policy or proxy) |
| `LOKI_TENANT_ID` | Value injected as `X-Scope-OrgID`; empty for single-tenant |
| `LOKI_WEBHOOK_SECRET` | Bridge HMAC secret |
| `TEMPO_BASE_URL` | Tempo query frontend or Cloud traces URL, https |
| `TEMPO_TOKEN` | Bearer token |
| `TEMPO_TENANT_ID` | Value injected as `X-Scope-OrgID`; empty for single-tenant |

Proposed agent tools:

| Tool | Risk band | Behavior |
|---|---|---|
| `loki.query_range` | `read_only` | One templated LogQL query, `limit ≤ 50`, backward, one stream selector |
| `loki.labels` | `read_only` | Allowlisted label names for the configured tenant |
| `tempo.get_trace` | `read_only` | One trace by id, span allowlist, ≤20 spans |
| `tempo.search` | `read_only` | One TraceQL query returning ≤10 trace summaries |
| `loki.push` / `tempo.push` | not proposed | Ingestion is out of scope; deny at the proxy |

Tools run in the worker, server-side. Sandbox egress stays deny; the token and `X-Scope-OrgID` value never enter the sandbox environment, a tool argument or a prompt. Results are bounded and redacted before returning; every call is audited with `action = tool.execute`, `details.tool`, `details.risk` and `details.outcome`. Extending tools requires the `ToolName` union, `SANDBOX_TOOL_RISKS`, the implementation map and the registry.

Tests (fakes only): `limit` clamp and `direction=backward`; window validation; label/stream allowlist; 200-line/2,000-char tail with first error line; redaction seeds in log lines, trace attributes and span events; span cap; 429/504 mapping; tenant header never taken from input; strict response parsing with unknown fields dropped.

## 7. Operator setup checklist

1. Decide self-hosted or Cloud; record the Loki and Tempo URLs and the tenant id.
2. Put both behind a reverse proxy; allowlist only the read paths; block `/loki/api/v1/push`, `/loki/api/v1/tail`, `/otlp/*` and Tempo ingestion from the connector's credential.
3. Create a read-only credential: Cloud access policy with `logs:read` and `traces:read`, or a proxy Bearer; set a 90-day expiry.
4. Inject `X-Scope-OrgID` server-side; never forward a client-supplied value.
5. Configure retention explicitly: Loki compactor retention on; Tempo `block-retention` sized to the incident window you need.
6. Point detector alerts (Grafana rule, Loki ruler, Alertmanager) at the bridge, not at the generic receiver directly.
7. Offline gates twice with providers disabled; then one bounded Loki query and one trace fetch.
8. Record the rotation date; never place a token or tenant id in this repository or a prompt.

```dotenv
LOKI_BASE_URL=
LOKI_TOKEN=
LOKI_TENANT_ID=
LOKI_WEBHOOK_SECRET=
TEMPO_BASE_URL=
TEMPO_TOKEN=
TEMPO_TENANT_ID=
```

## 8. Acceptance checklist

Offline first:

- [ ] A valid bridge HMAC is accepted; tampering, missing timestamp, 301 s skew and 65 KiB are rejected.
- [ ] A 250-line fixture yields 200 lines / 2,000 chars with the first error line preserved and `truncated: true`.
- [ ] A log line containing a token or email is redacted before truncation; the secret does not appear in the hash input explanation.
- [ ] A 30-span trace is reduced to 20; disallowed attributes are absent.
- [ ] Pattern fingerprint is stable across numbers, UUIDs and durations; a trace id never becomes a fingerprint.
- [ ] `429` and `504` map to bounded errors; no token or tenant id in the message.

Live (one bounded call, no retries):

- [ ] One `query_range` with `limit=10` for a disposable stream returns at most 10 lines; assert only a 2,000-char excerpt reaches the prompt.
- [ ] One trace-by-id fetch returns a summary, not the raw JSON; assert ≤20 spans.
- [ ] One bridge-signed detector delivery creates one task and a replay is deduped. Grafana Cloud Free has no metered spend to record.

## 9. Risks / never in model context

Risks: logs are the highest-PII, highest-volume source; Loki retention is off by default, so storage grows without bound; `X-Scope-OrgID` is not authentication; trace ids are unique per request and must not drive fingerprints; Cloud Free retains only 14 days; repeated identical log lines can flood a query and the bundle; Tempo span attributes can contain credentials and customer data.

Never in model context: tokens, `X-Scope-OrgID`, proxy credentials; full log bodies or streams; `tail` output; all label values; full trace JSON, span events, `http.request.header.*`, `db.statement`, `net.peer.ip`, `enduser.*`; query strings that embed credentials; any OTLP payload.

## 10. Sources

All accessed 2026-10-31.

| ID | Source | URL |
|---|---|---|
| L1 | Loki HTTP API (query, query_range, labels, series) | https://grafana.com/docs/loki/latest/reference/loki-http-api/ |
| L2 | Loki log retention (compactor, per-stream minimum) | https://grafana.com/docs/loki/latest/operations/storage/retention/ |
| L3 | Loki OTLP ingestion (`/otlp`, structured metadata) | https://grafana.com/docs/loki/latest/send-data/otel/ |
| L4 | Tempo HTTP API (trace by id, TraceQL search, tags) | https://grafana.com/docs/tempo/latest/api_docs/ |
| L5 | Tempo configuration (OTLP gRPC 4317 / HTTP 4318) | https://grafana.com/docs/tempo/latest/configuration/ |
| L6 | Tempo compaction and retention | https://grafana.com/docs/tempo/latest/reference-tempo-architecture/components/compaction/ |
| L7 | Grafana Cloud pricing and Free tier (50 GB logs/traces, 14 days) | https://grafana.com/pricing/ |
| L8 | Loki configuration reference (`limits_config`) | https://grafana.com/docs/loki/latest/configure/ |
| L10 | Grafana Cloud access policies (`logs:read`, `traces:read`) | https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-policies/ |
| L11 | Loki licence (AGPLv3) | https://raw.githubusercontent.com/grafana/loki/main/LICENSE |
| L12 | Tempo licence (AGPLv3) | https://raw.githubusercontent.com/grafana/tempo/main/LICENSE |
