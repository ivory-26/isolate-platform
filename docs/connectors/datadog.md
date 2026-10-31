# Datadog connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | `DD-API-KEY` + scoped `DD-APPLICATION-KEY` [S2] |
| Inbound | Datadog webhook; **no HMAC** — shared header plus API re-fetch [S4] |
| Read | Incidents v2, monitors v1, metrics v2 query, logs search v2, events v2 |
| Writes | None in scope (mute, annotate, incident edits are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.4. Nothing below is implemented.

## 1. Role in the agent

Datadog answers "what changed and how bad is it" after a trigger has identified a service: incident severity and state, the monitor that fired, a bounded metric window, an aggregate of log status codes, and recent events. It is not a code-location source; pair it with GitHub or an error tracker.

The trigger is the primary value; the reader is secondary and must stay aggregate-first. A Datadog webhook is **unauthenticated at the body level**, so it is a hint that causes a canonical API re-fetch. It must never be used to fetch raw log bodies, to page through history, or to mutate monitors.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Plan | Free (free forever, not a trial) | Up to **5 hosts**, **1-day metric retention**, core collection and visualization [S1] |
| Custom metrics | No numeric allowance stated on the Free card — **UNVERIFIED** | Do not design around a free custom-metric budget; query only existing metrics |
| Log ingestion | No free log allowance stated — **UNVERIFIED** | Log Management is priced separately; assume logs are absent on Free until the account proves otherwise [S1] |
| Log retention | Determined by the customer's plan | Set per index; exact day counts are contract-dependent — **UNVERIFIED** |
| Metric retention | 15 months on paid plans; 1 day on Free [S1][S10] | The reader must state the window it queried |
| Incidents / monitors | Retained for the account lifetime [S10] | Metadata, not evidence of the underlying metric |
| Rate limits | Header-driven; fixed **250,000 events/min** for the events API [S9] | Per-endpoint metrics/logs numbers are not published — **UNVERIFIED** |
| Trial / credits | No credit-funded trial in this design | Datadog is not a platform credit provider |

Free tier is suitable for a design partner with one small service. Production use needs a paid plan for logs and 15-month metrics.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Headers | `DD-API-KEY: <api key>` and `DD-APPLICATION-KEY: <application key>` [S2] |
| API key | Organization-wide; used to submit data. Never use it as the only credential for reads |
| Application key | Grants programmatic access; can be **scoped** to explicit permissions [S2] |
| Scope stability | A scoped application key keeps its scopes even if the owner's role changes; review the key independently [S3] |
| Lifetime | No built-in expiry; rotate on a fixed schedule [S2] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)`; both values are secrets |
| Rotation | Create a second scoped application key, deploy it, verify reads, then revoke the first; API keys rotate the same way |

Minimal application-key permissions:

| Scope | Needed for | Source |
|---|---|---|
| `metrics_read` | Timeseries query | [S3] |
| `logs_read_data` | Log search; also requires `logs_read_index_data` (companion permission) | [S3] |
| `incident_read` | Incidents | [S3] |
| `monitors_read` | Monitor state | [S3] |
| `events_read` | Event stream | [S3] |
| `dashboards_read` | Optional; only if a dashboard definition is evidence | [S3] |

Do not grant `metrics_write`, `logs_write`, `incident_write`, `monitors_write` or `org_app_keys_write` to this connector. A dedicated scoped application key per tenant and environment; never a personal full-access key.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/datadog` (platform route; one binding per deployment) |
| Signature header | **None documented** [S4] |
| Authentication | HTTP Basic (URL-embedded), OAuth 2.0 bearer, or configured custom headers [S4] |
| Signed timestamp | No; no freshness window can be derived from a signature |
| Replay control | Source-stable fingerprint + canonical re-fetch; reject an event older than 15 minutes using the payload timestamp |
| Dedupe key | `datadog:<monitor-or-incident-id>:<alert-transition>:<bucket>`; the delivery id is traceability only |
| Body cap | 64 KiB (platform default); the payload is a configured JSON template, not a fixed envelope |
| Retries | 15-second timeout; up to **5** retries on 5xx or internal error [S4] |
| Response | `202` before any model work; no payload echo |

Because there is no HMAC, a custom header proves only that the sender knows a shared string; it does not prove body integrity. Treat the delivery as a **hint**: verify the shared header against a server-side value, then re-fetch the monitor/incident by id before creating a task. A forged payload can at most cause a read of real state. Do not put the shared secret in the webhook URL; Datadog supports custom headers, so send it there.

The payload template is operator-configurable. Require a pinned template exposing `id`, `title`, `priority`, `alert_type`, `alert_transition`, `date_happened`, `tags`, `url` and `org`; reject deliveries that do not match the strict schema. Never accept a free-form `body` field as evidence.

## 5. Read-only context

Base host: `https://api.<site>` — `datadoghq.com` (US1), `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com` [S5]. The site is configuration, never payload-derived.

| Need | Endpoint | Params / fields | Source |
|---|---|---|---|
| Incident metadata | `GET /api/v2/incidents/{incident_id}` | `title`, `severity`, `state`, `created`, `modified`, `customer_impact_scope` | [S7] |
| Incident list fallback | `GET /api/v2/incidents` | `page[size]`, `page[offset]`, `filter[query]`; one page only | [S7] |
| Monitor state | `GET /api/v1/monitor/{monitor_id}` | `name`, `type`, `overall_state`, `modified`, `tags`; never the full `message` | [S8] |
| Monitors for a service | `GET /api/v1/monitor` | `monitor_tags`, `group_states`; one page, `page_size` ≤ 50 | [S8] |
| Metrics window | `POST /api/v2/query/timeseries` | `data.attributes.from`/`to`, 1–3 `queries` with `data_source: "metrics"`; no formulas | [S5] |
| Log aggregate | `POST /api/v2/logs/events/search` | `filter.query` with `*` + group-by, `filter.from`/`to`, `page.limit` ≤ 100; **no message body** | [S6] |
| Recent events | `GET /api/v2/events` | `filter[query]`, `filter[from]`, `filter[to]`, `page[limit]` ≤ 50 | [S11] |

Fixed call plan: incident (1) → monitor (1) → metrics (≤2, 15–60 minute window) → log aggregate (≤1) → events (≤1). Total **≤ 6 calls**, 10-second timeout each, one page each, no pagination loop. The model cannot author a query; metric and log queries are templates with the service, environment and window substituted after identifier validation.

Caps: at most **12 items** from this source, **4,000 characters** per excerpt, **256 KiB** total bundle. A metric item carries at most 20 points and 1,500 characters; a log item is a count table (status class, error kind), never a raw line. Set `truncated: true` when a call is skipped, denied, rate-limited or capped.

## 6. Framework fit

- Module: `packages/integrations/src/datadog/` with `auth.ts`, `webhook.ts`, `incidents.ts`, `context.ts`, `redact.ts`, tests.
- Source enum: `datadog` **already exists** in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`); no contract change is required for the adapter. If a new context kind is needed, it is a free string ≤ 64 chars, so no enum change either.
- Proposed functions: `verifyDatadogDelivery` (shared header + freshness + strict template schema), `normalizeDatadogIncident` (severity from `priority`, service from `service` tag), `fetchDatadogIncidentContext` (fixed plan above).
- Agent tools: **none in the first wave**. Context is injected server-side by the worker like the GitHub reader. If a query tool is ever exposed, it is `read_only` under `createRiskTablePolicy` and audited as `tool.execute`; mute/annotate/edit is `sensitive` and out of scope.
- Env names: `DATADOG_API_KEY`, `DATADOG_APP_KEY`, `DATADOG_SITE`, `DATADOG_WEBHOOK_HEADER`, `DATADOG_WEBHOOK_SECRET`.
- Sandbox: reader runs in the worker, not the sandbox; sandbox egress stays denied; no Datadog credential in a prompt, tool result, error or audit detail; bounded redacted excerpts only; `tool.execute` audit only if a tool is added. Read calls are not audited per request today.
- Tests: fake fetch only; forged/unsigned payload causes re-fetch, not task creation from payload alone; header mismatch `401`; stale timestamp rejected; `429` maps to `RATE_LIMITED`; timeout; log attribute allowlist; tenant isolation (foreign incident id → `NOT_FOUND`).

## 7. Operator setup checklist

1. Choose the Datadog site and record it in `DATADOG_SITE`; the API host derives from it.
2. Create a dedicated application key with only the scopes in §3; create or reuse an API key that is not shared with ingest agents.
3. Store both in the server secret store; never in the repository, a prompt or a fixture.
4. Create a webhook integration with the pinned JSON template, a custom header (`DATADOG_WEBHOOK_HEADER`) and a random value (`DATADOG_WEBHOOK_SECRET`); do not use URL-embedded Basic auth.
5. Point the webhook at `https://<host>/api/webhooks/datadog`; subscribe only to the monitors/incidents in scope.
6. Set the server-side binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow); the Datadog payload never selects a tenant.
7. Confirm logs are on the plan before enabling the log aggregate; if not, disable that call and mark the bundle `truncated`.
8. Add keys **last**, after offline gates pass.

```dotenv
DATADOG_API_KEY=
DATADOG_APP_KEY=
DATADOG_SITE=
DATADOG_WEBHOOK_HEADER=
DATADOG_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline (required before merge, providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifyDatadogDelivery`: valid header accepted; wrong/missing header `401`; stale event rejected; oversize body `413`; no secret in errors.
- [ ] `normalizeDatadogIncident`: priority→severity mapping; fingerprint stable across redelivery; unknown template fields rejected.
- [ ] `fetchDatadogIncidentContext`: ≤ 6 calls; log item contains no message body; metric points ≤ 20; `truncated` on any skip; `429`/timeout mapping.
- [ ] Redaction seeds: API key, application key, `Authorization`, email and IPv4 in a log attribute are removed before truncation.
- [ ] Tenant isolation: incident id from another organization returns `NOT_FOUND`.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live (only with explicit authorization, one bounded call, no retries):

- [ ] One `GET /api/v2/incidents/{id}` for a named test incident, or one metric query for a named service; record request count and result size.
- [ ] Datadog is not credit-funded; record `$0` provider spend and the measured latency/bytes.
- [ ] No webhook replay test against production monitors.

## 9. Risks / never in model context

- API key, application key, webhook shared secret, `Authorization` header, cookies.
- Raw log `message` bodies, request bodies, query strings, customer identifiers, emails, IPs, user ids.
- Full `customer_impact` free text, incident notes, responder names.
- Full monitor definitions, including notification webhook URLs and embedded secrets.
- Dashboard/query text that embeds internal hostnames or tokens.
- Provider text is untrusted; a log line cannot change the task, its limits, ownership or tool permissions.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Datadog pricing](https://www.datadoghq.com/pricing/) |
| S2 | [API and Application keys](https://docs.datadoghq.com/account_management/api-app-keys/) |
| S3 | [RBAC permissions](https://docs.datadoghq.com/account_management/rbac/permissions/) |
| S4 | [Webhooks integration](https://docs.datadoghq.com/integrations/webhooks/) |
| S5 | [Metrics API](https://docs.datadoghq.com/api/latest/metrics/) |
| S6 | [Logs API](https://docs.datadoghq.com/api/latest/logs/) |
| S7 | [Incidents API](https://docs.datadoghq.com/api/latest/incidents/) |
| S8 | [Monitors API](https://docs.datadoghq.com/api/latest/monitors/) |
| S9 | [API rate limits](https://docs.datadoghq.com/api/latest/rate-limits/) |
| S10 | [Data retention periods](https://docs.datadoghq.com/data_security/data_retention_periods/) |
| S11 | [Events API](https://docs.datadoghq.com/api/latest/events/) |

Verification notes: free-tier host/retention facts are from the official pricing page; the absence of free log ingestion is **UNVERIFIED** (the page does not state a log allowance). No HMAC is documented on the webhooks page — that is an absence of documentation, not a positive security guarantee. Numeric rate limits for metrics query and logs search were not published on the rate-limit page.
