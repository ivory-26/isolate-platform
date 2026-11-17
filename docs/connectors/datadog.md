# Datadog connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Free tier verified | 2026-10-31 |
| Auth | `DD-API-KEY` + scoped `DD-APPLICATION-KEY` [S2] |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "datadog"` |
| Read | Monitor v1, metrics v2 query, logs search v2 (incident v2 only when an incident id is supplied) |
| Writes | None in scope (mute, annotate, incident edits are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.4. The adapter, read context and relay tools exist in `packages/integrations/src/datadog/` and `apps/device-daemon/src/vendors/datadog.ts`. There is no Datadog intake mode in `apps/web`, so a delivery cannot create a task directly; it must be re-signed onto the generic bridge. Historical trigger-to-PR runs and the successful 2026-11-17 monitor read are recorded in [`live-verification.md`](live-verification.md).

**Current live proof (2026-11-17):** a dedicated read-scoped key is paired on
US1 through **Verification relay**. Exactly one `datadog.get_monitor` call for
`344995520` succeeded in 7.95 s (one request, no retries), returning the real
monitor's metadata and state **No Data**. This proves `monitors_read`; it does
not prove metric/log/incident reads. The acceptance used `task_id: null` and
the existing relay queue, with zero new model/sandbox usage rows.

## 1. Role in the agent

Datadog answers "what changed and how bad is it" after a trigger has identified a service: incident severity and state, the monitor that fired, a bounded metric window, an aggregate of log status codes, and recent events. It is not a code-location source; pair it with GitHub or an error tracker.

The trigger is the primary value; the reader is secondary and must stay aggregate-first. Datadog does not sign webhook bodies [S4], so a Datadog delivery must arrive through the generic signed bridge, which verifies its own HMAC and then passes a strict `IncidentSignal`. The reader then fetches monitor state through the Datadog API. It must never be used to fetch raw log bodies, to page through history, or to mutate monitors.

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
| Storage | Both values are stored in the relay's encrypted local store under the paired credential; the server holds only `credential_ref` metadata |
| Rotation | Pair the connector again with a second scoped application key, verify a read, then revoke the first; API keys rotate the same way |

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

**There is no native Datadog intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. A Datadog delivery is therefore re-signed onto the generic bridge.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `datadog` |
| Fingerprint | `datadog:<monitorId>` is what the device parser requires; the repo normalizer emits `datadog:<monitorId>:<first16hex(sha256(sorted group tags))>` |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated segment 1-64 characters; charset `[A-Za-z0-9._:@/-]` |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the delivery id is traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

A custom Datadog header is still worth using at the bridge's own edge, but it is not evidence of body integrity [S4]. The bridge must verify its own credential, map the delivery to a signal and sign the exact bytes it forwards. The relay reader below then fetches monitor state by the id in the fingerprint; a forged bridge payload can at most cause a read of real state.

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`datadog`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no Datadog evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

Base host: `https://api.<site>` — `datadoghq.com` (US1), `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com` [S5]. The site is configuration, never payload-derived.

| Need | Endpoint | Params / fields | Source |
|---|---|---|---|
| Monitor state | `GET /api/v1/monitor/{monitor_id}` | `name`, `type`, `overall_state`, `modified`, `tags`; never the full `message` | [S8] |
| Metrics window | `POST /api/v2/query/timeseries` | two templated queries (`cpu`, `errors`) in one request over a 15-60 minute window; no formulas | [S5] |
| Log aggregate | `POST /api/v2/logs/events/search` | group-by status class and error kind, at most 20 entries; **no message body** | [S6] |
| Incident metadata | `GET /api/v2/incidents/{incident_id}` | `title`, `severity`, `state`, `created`, `modified`; only when an incident id is supplied | [S7] |

Fixed plan on the device path: monitor (1) -> metrics request (1, two queries) -> log aggregate (1). An incident read (1) is added only when the caller supplies an incident id; the device context tool supplies a monitor id, not an incident id. The hard cap is **6 provider calls**, 10-second timeout each, one page each, no pagination loop or events read. The model cannot author a query; metric and log queries are templates with the validated service and a bounded window.

Caps: at most **12 items** from this source, **4,000 characters** per item, **256 KiB** per response and per bundle, **3 metric series**, **20 points** per series, **1,500 characters** of metric summary, **20 log entries** and **2,000 characters** of log aggregate. Redaction runs before truncation. Set `truncated: true` when a call is skipped, denied, rate-limited or capped.

### 5.1 Evidence loading

The worker never holds the Datadog keys. For a task carrying a `datadog:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, datadog, fingerprint)`, and enqueues exactly one `datadog.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses the fingerprint, requires a non-empty service, and calls the reader above. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without Datadog evidence and is never failed by context loading.

One preconditions note: the task must carry the fingerprint. On the current intake path that happens through the subscription-aware pipeline; see §4.

## 6. Framework fit

- Module: `packages/integrations/src/datadog/` (`webhook.ts`, `normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, tests); device handlers in `apps/device-daemon/src/vendors/datadog.ts`.
- Source enum: `datadog` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`).
- Implemented functions: `verifyDatadogDelivery` (reports `unsigned` or `bridge_verified`, never a forged body as valid), `normalizeDatadogIncident` (severity from `priority`, service from the `service` tag, monitor-id fingerprint), `fetchDatadogContext` (fixed plan above).
- Device tools: `datadog.query_metrics`, `datadog.search_logs`, `datadog.get_incident`, `datadog.get_monitor`, plus `datadog.context.fetch` for incident context. The context call is worker-enqueued; the four query tools are available to the model only when the registry finds an `active` credential and the tool is enabled.
- Pairing fields: secrets `apiKey` and `appKey`; required selector `baseUrl` (the site API origin). The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all reads execute on the user's device; sandbox egress stays denied; no Datadog credential enters a prompt, tool result, error or audit detail; redacted bounded excerpts only.
- Tests: fake fetch only; bridge-verified versus unsigned is distinguished; `401` and transport failures map to `INTEGRATION_UNAVAILABLE`; `429` maps to `RATE_LIMITED`; a monitor `403` emits a `monitor_denied` item naming the missing `monitors_read` scope, a monitor `404` emits `monitor_missing` with the id, other optional reads drop on `5xx` and set `truncated`; log message bodies and monitor `message` are never returned; tenant isolation.

## 7. Operator setup checklist

1. Choose the Datadog site; the API host derives from it and is stored as the `baseUrl` selector.
2. Create a dedicated application key with only the scopes in §3; create or reuse an API key that is not shared with ingest agents.
3. Pair the `datadog` connector on the relay with `apiKey`, `appKey` and `baseUrl`; the values stay in the relay's encrypted local store. Never put them in the repository, a prompt or a fixture.
4. Create a webhook integration with a pinned JSON template and a custom header; point it at your bridge, not at the platform receiver.
5. Configure the bridge sender to verify that header, map the delivery to a strict `IncidentSignal` with `source: "datadog"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
6. Point the sender at `https://<host>/api/webhooks/<any-path>` and set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow); the Datadog payload never selects a tenant.
7. Create an enabled subscription for the `datadog` connector if the task should carry provenance and load evidence (§4).
8. Confirm logs are on the plan before enabling the log aggregate; if not, the reader reports `truncated`.
9. Add keys **last**, after offline gates pass.

```dotenv
WEBHOOK_SIGNING_SECRET=
# Relay-local examples only: the daemon reads the env var names configured in
# `vendors.datadog.secretEnv`, so a deployment may name them differently.
DD_API_KEY=
DD_APP_KEY=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] `verifyDatadogDelivery`: an unsigned body is never reported as `valid`; `bridgeVerified: true` reports `bridge_verified`; oversize body refused.
- [x] `normalizeDatadogIncident`: priority to severity mapping; monitor-id fingerprint stable across redelivery; unknown template fields rejected.
- [x] `fetchDatadogContext`: monitor, two templated metric queries and one log aggregate; log item contains no message body; 3 series / 20 points cap; `truncated` on any skip; `401`/`429`/timeout mapping.
- [x] Redaction seeds: API key, application key, `Authorization`, email and IPv4 in a log attribute are removed before truncation.
- [x] Relay context: `datadog.context.fetch` parses `datadog:<monitorId>` and requires a service; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **runs 2026-11-13 and 2026-11-14/15.** The 2026-11-13 run sent `datadog:344490966`, a synthetic id that matches no monitor; both context calls completed with an empty bundle (`items: []`, `truncated: true`) and the task stopped at its push approval. The account's real monitor is `344995520` — "Isolate E2E CPU load", `avg(last_5m):avg:system.load.1{*} > 90`, state `NO DATA`, created 2026-11-14T21:49Z, **no `service` tag** — so run 11 (`97f9e8a7`, 2026-11-15) delivered `datadog:344995520` with `service: checkout`. Both context calls again completed without error and again returned **zero items with `truncated: true`**: the monitor read was dropped as an optional item, so the bundle could not distinguish a missing monitor, a `403` from an Application key without `monitors_read`, and a monitor that has never reported. The run still committed `8f681ac` and opened PR #11. **That ambiguity is now closed offline:** the monitor read emits a `monitor_denied` item (naming `monitors_read`) on `403` and a `monitor_missing` item (with the id) on `404`, so the next live run states which of the three happened instead of returning silence. No monitor was replayed or edited. Measured spend: 363,524/24,177 (2026-11-13), 197,560/19,674 (run 11). Full run log: [`live-verification.md`](live-verification.md).

## 9. Risks / never in model context

- API key, application key, bridge `WEBHOOK_SIGNING_SECRET`, `Authorization` header, cookies.
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
