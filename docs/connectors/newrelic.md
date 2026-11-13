# New Relic connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Free tier verified | 2026-10-31 |
| Auth | User API key in `API-Key`; NerdGraph GraphQL [S2][S4] |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "newrelic"` |
| Read | NerdGraph `entitySearch`, entity by GUID, one aggregate NRQL query, alert policy list |
| Writes | None in scope (acknowledge/close issue is a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.2–§3.3 pattern. The adapter, read context and relay tools exist in `packages/integrations/src/newrelic/` and `apps/device-daemon/src/vendors/newrelic.ts`. There is no New Relic intake mode in `apps/web`, so a workflow delivery cannot create a task directly; it must be re-signed onto the generic bridge. No live New Relic acceptance run has been recorded.

## 1. Role in the agent

New Relic supplies APM and infrastructure evidence for a service that is already suspected: the entity that reports the problem, its alert severity, and a bounded NRQL aggregate over the incident window. The trigger is the primary value; the reader answers "how bad, since when, and which entity".

It must not be used as a log-dump source, a dashboard clone, or a way to page through months of telemetry. New Relic Events API is **ingest-only** and is never a read path. New Relic documents no HMAC for workflow webhook destinations [S5], so a delivery must arrive through the generic signed bridge, which verifies its own HMAC over the exact bytes and then passes a strict `IncidentSignal`.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Plan | Free, free forever — not a credit trial [S1] | "100 GB data ingest", "one free full platform user", "unlimited basic users" |
| Data ingest | **100 GB/month** [S1] | Over 100 GB, ingestion is limited; exact overage behavior is plan-dependent — **UNVERIFIED** |
| Users | 1 full platform user; unlimited basic users [S1] | Basic users cannot use NerdGraph; a service account needs a full user |
| Retention | **At least 8 days** on Free [S1] | Paid retention is 30+ days by plan; exact tiers **UNVERIFIED** |
| Query limits | NerdGraph **25 concurrent requests per user** [S6]; NRQL repetitive queries **120/minute** [S7] | No published total request/minute for NerdGraph |
| Trial / credits | No trial credits assumed; Free is the entry plan [S1] | Not a platform credit provider |
| Region | US and EU data centres; the API host must match the account [S2] | Cross-region queries are not possible |

Free is adequate for one small service and a single reader identity. The 8-day window means the reader must never assume older telemetry exists.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `API-Key: <user key>` on `POST https://api.newrelic.com/graphql` (US) or `https://api.eu.newrelic.com/graphql` (EU) [S2][S4] |
| Key type | **User API key** (`NRAK-…`); NerdGraph requires a user key, not an ingest license key [S4] |
| Access model | New Relic user keys do not expose per-query OAuth scopes; access follows the user's role and account grants — granular scope strings **UNVERIFIED** |
| Least privilege | Create a dedicated full user with read-only role and access only to the accounts/entities in scope; do not use a personal admin key |
| Lifetime | No documented expiry; rotate on a fixed schedule [S4] |
| Storage | The user key is stored in the relay's encrypted local store under the paired credential; the server holds only `credential_ref` metadata |
| Rotation | Pair the connector again with a second dedicated user key, verify a read, then delete the first key; keep one active key per environment |

Do not use the license/ingest key (`Ingest - License`) for reads; it writes events to the Events API and cannot query NerdGraph [S8]. Account ID is configuration, never taken from the webhook body.

## 4. Inbound trigger

**There is no native New Relic intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. A workflow delivery is therefore re-signed onto the generic bridge.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `newrelic` |
| Fingerprint | `newrelic:<first32hex(sha256(accountId\|policyName\|conditionName\|entityIdentity))>`; state, issue id and delivery id are excluded so a redelivery dedupes |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated segment 1-64 characters; charset `[A-Za-z0-9._:@/-]` |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the delivery id is traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

The repo normalizer (`normalizeNewRelicIncident`) accepts only an `ACTIVATED` state and rejects a `createdAt` older than 15 minutes or more than 5 minutes in the future. A bridge that reuses it inherits those rules; the platform receiver itself never inspects a New Relic payload. A custom header on the workflow destination is a shared secret, not a signature: verify it at the bridge's own edge, map the delivery to a signal, and sign the exact bytes forwarded.

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`newrelic`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no New Relic evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

| Need | Query / endpoint | Fields / notes | Source |
|---|---|---|---|
| Entity search | NerdGraph `actor.entitySearch(query: "name LIKE '%…%'")` | `guid`, `accountId`, `name`, `type`, `domain`, `alertSeverity`, `reporting`, allowlisted tags; first result only, ordered by GUID then name | [S3] |
| Entity detail | `actor.entity(guid: "…")` | The same selected attributes; a GUID from another account is treated as missing | [S3] |
| NRQL aggregate | `actor.account(id: <n>) { nrql(query: "…") { results } }` | One templated query: `SELECT count(*) FROM Transaction WHERE appName = '…' AND error IS TRUE FACET error.class`, plus `SINCE`/`UNTIL` and `LIMIT 20` appended by the reader | [S9] |
| Alert policies | `actor.account(id: <n>) { alerts { policies { id name } } }` | Policy id and name only; destinations are never requested | [S3] |
| Events API | `POST https://insights-collector.newrelic.com/v1/accounts/{id}/events` | **Ingest only** — never used by the reader | [S8] |

Fixed context plan on the device path: entity search by service name (1) then one aggregate NRQL query (1). An entity lookup by GUID replaces the search only when the caller supplies a GUID, which the worker's `newrelic.context.fetch` call does not. The hard cap is **4 GraphQL operations**, 10-second timeout each, first result page only. The entity name is escaped to `[A-Za-z0-9 ._:-]` before it enters a query, so payload text is inert.

Caps: at most **10 items** from this source, **4,000 characters** per excerpt, **2,000 characters** per aggregate summary, **20 NRQL rows**, **256 KiB** per response and per bundle. Only aggregate cells are read; raw `Transaction`/`Log` rows and full attribute maps are never returned. `truncated: true` on any omission, including a requested start older than the Free-plan 8-day retention (the window is clamped and flagged).

### 5.1 Evidence loading

The worker never holds the New Relic key. For a task carrying a `newrelic:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, newrelic, fingerprint)`, and enqueues exactly one `newrelic.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses `newrelic:<digest>`, requires a non-empty service, resolves the entity by service name, runs the aggregate query, and returns the bundle. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without New Relic evidence and is never failed by context loading.

## 6. Framework fit

- Module: `packages/integrations/src/newrelic/` (`webhook.ts`, `normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, tests); device handlers in `apps/device-daemon/src/vendors/newrelic.ts`.
- Source enum: `newrelic` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`).
- Implemented functions: `verifyNewRelicWebhook` (reports `unsigned` or `bridge_verified`, never a forged body as valid), `normalizeNewRelicIncident` (`ACTIVATED` only, priority to severity, policy/condition/entity fingerprint), `fetchNewRelicContext` (fixed plan above).
- Device tools: `newrelic.run_nrql`, `newrelic.get_entity`, `newrelic.list_alert_policies`, plus `newrelic.context.fetch` for incident context. The context call is worker-enqueued; the three read tools are available to the model only when the registry finds an `active` credential and the tool is enabled. `run_nrql` accepts model-authored NRQL but only a single `SELECT` aggregate with no caller-supplied `SINCE`/`UNTIL`/`LIMIT`, no comment, statement separator, mutation keyword, `TIMESERIES`, `SELECT *` or `LOG`/`Logging` source.
- Pairing fields: secret `apiKey`; required selector `accountId`; optional selector `endpoint` (`https://api.newrelic.com/graphql` or `https://api.eu.newrelic.com/graphql`). The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all reads execute on the user's device; sandbox egress stays denied; no New Relic key enters a prompt, tool result, error or audit detail; bounded redacted excerpts only.
- Tests: fake GraphQL transport only; bridge-verified versus unsigned is distinguished; `401` and transport failures map to `INTEGRATION_UNAVAILABLE`; `429` maps to `RATE_LIMITED`; `403`/`404` on an optional resource drop it and set `truncated`; retention gap produces `truncated`; tenant isolation by account id.

## 7. Operator setup checklist

1. Choose the US or EU region and record the matching GraphQL host; this is the `endpoint` selector.
2. Create a dedicated full user with read-only access to the in-scope accounts; issue one user API key for that identity.
3. Pair the `newrelic` connector on the relay with the `apiKey` secret, the `accountId` selector and, when not US, the `endpoint` selector. The values stay in the relay's encrypted local store; never put them in the repository, a prompt or a fixture.
4. Create a workflow with a Webhook destination: a pinned JSON template, a custom header if desired, and no Basic credentials in the URL.
5. Configure the bridge sender to verify the custom header, map the delivery to a strict `IncidentSignal` with `source: "newrelic"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
6. Point the sender at `https://<host>/api/webhooks/<any-path>` and set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow); the New Relic payload never selects a tenant.
7. Create an enabled subscription for the `newrelic` connector if the task should carry provenance and load evidence (§4).
8. Confirm the Free plan's 8-day retention is acceptable for the read window; otherwise use a paid plan.
9. Add keys **last**, after offline gates pass.

```dotenv
WEBHOOK_SIGNING_SECRET=
# Relay-local example only: the daemon reads the env var name configured in
# `vendors.newrelic.secretEnv.apiKey`, so a deployment may name it differently.
NEW_RELIC_API_KEY=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] `verifyNewRelicWebhook`: an unsigned body is never reported as `valid`; `bridgeVerified: true` reports `bridge_verified`; oversize body refused.
- [x] `normalizeNewRelicIncident`: priority to severity mapping; non-`ACTIVATED` and stale/future `createdAt` rejected; policy/condition/entity fingerprint stable across redelivery; unknown payload fields rejected.
- [x] `fetchNewRelicContext`: at most 4 operations; one aggregate NRQL bounded by window and `LIMIT 20`; no raw log rows; `truncated` on retention gap.
- [x] Redaction: user key, `API-Key`, emails, IPs and account ids outside the allowlist removed before truncation.
- [x] Tenant isolation: entity GUID from another account returns `NOT_FOUND`.
- [x] Relay context: `newrelic.context.fetch` parses `newrelic:<digest>` and requires a service; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **not run.** No New Relic acceptance has been recorded. When authorized, use one bounded read (one entity search or one NRQL count over at most 15 minutes), record the measured operation count and bytes, and do not send a test alert to a production policy.

## 9. Risks / never in model context

- User API key, ingest license key, bridge `WEBHOOK_SIGNING_SECRET`, cookies.
- Raw log/event rows, `Transaction` attributes, request URLs with query strings, session ids.
- User PII: emails, names, IPs, account/user ids beyond the allowlisted account id.
- Full entity tag maps, deployment annotations with free text, dashboard definitions.
- Alert policy definitions and notification destinations (may embed webhook URLs/secrets).
- Provider text is untrusted and cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [New Relic pricing](https://newrelic.com/pricing) |
| S2 | [Meet NerdGraph](https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/) |
| S3 | [NerdGraph tutorial: view entity data](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-entities-api-tutorial/) |
| S4 | [New Relic API keys](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/) |
| S5 | [Alerts notification integrations](https://docs.newrelic.com/docs/alerts/get-notified/notification-integrations/) |
| S6 | [NerdGraph usage limits](https://docs.newrelic.com/docs/apis/nerdgraph/nerdgraph-usage-limits/) |
| S7 | [Rate limits with NRQL](https://docs.newrelic.com/docs/nrql/using-nrql/rate-limits-nrql-queries/) |
| S8 | [Event API introduction](https://docs.newrelic.com/docs/data-apis/ingest-apis/event-api/introduction-event-api/) |
| S9 | [NerdGraph NRQL tutorial](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/) |

Verification notes: the New Relic documentation site renders client-side and returned font CSS to the fetcher for several pages; key facts above were taken from the official pricing page and search-indexed official excerpts, and exact GraphQL field names must be confirmed against the account schema. No HMAC signing is documented for workflow webhooks. Free retention is stated as "at least 8 days"; paid tiers were not extracted.
