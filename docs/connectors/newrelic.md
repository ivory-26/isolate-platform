# New Relic connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | User API key in `API-Key`; NerdGraph GraphQL [S2][S4] |
| Inbound | Workflow webhook destination; **no HMAC documented** — custom header plus re-fetch [S5] |
| Read | NerdGraph `entitySearch`, NRQL, entity by GUID |
| Writes | None in scope (acknowledge/close issue is a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.2–§3.3 pattern; New Relic is not in the survey. Nothing below is implemented.

## 1. Role in the agent

New Relic supplies APM and infrastructure evidence for a service that is already suspected: the entity that reports the problem, its alert severity, and a bounded NRQL aggregate over the incident window. The trigger is the primary value; the reader answers "how bad, since when, and which entity".

It must not be used as a log-dump source, a dashboard clone, or a way to page through months of telemetry. New Relic Events API is **ingest-only** and is never a read path.

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
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second dedicated user key, deploy, verify, then delete the first key; keep one active key per environment |

Do not use the license/ingest key (`Ingest - License`) for reads; it writes events to the Events API and cannot query NerdGraph [S8]. Account ID is configuration, never taken from the webhook body.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/newrelic` |
| Signature header | **None documented**; destinations support Basic auth, OAuth, or custom headers [S5] |
| Signed timestamp | No signed timestamp; payload carries `createdAt` for freshness only |
| Replay control | Reject `createdAt` older than 15 minutes; dedupe by issue id + state transition |
| Dedupe key | `newrelic:<account-id>:<issue-id>:<state>`; delivery id is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | Not documented on the retrieved notification page — **UNVERIFIED**; reconcile by querying issue state, not by assuming delivery |
| Response | `202` before any model work; no payload echo |

Default workflow payload fields include `id`, `issueUrl`, `title`, `priority`, `state`, `createdAt` and `impactedEntities` [S5]. Require a pinned payload template and a strict schema; reject unknown fields.

A custom header is a shared secret, not a signature: it proves the sender knows the value, not that the body was unmodified. Verify the header, then fetch the issue/entity state through NerdGraph before creating a task. If the platform requires a signed trigger, route the workflow webhook through the generic signed bridge (README §3) instead of accepting the body directly.

## 5. Read-only context

| Need | Query / endpoint | Fields / notes | Source |
|---|---|---|---|
| Entity search | NerdGraph `actor.entitySearch(query: "…")` | `guid`, `name`, `type`, `domain`, `alertSeverity`, `reporting`; strict query template | [S3] |
| Entity detail | `actor.entity(guid: "…")` | Selected attributes only; no tags dump | [S3] |
| NRQL aggregate | `actor.account(id: <n>) { nrql(query: "…") { results } }` | `SELECT count(*)`, percentiles or average over a ≤ 60-minute window; `SINCE`/`UNTIL` bounded | [S9] |
| Alert/issue state | NerdGraph issue/alert fields or NRQL over alert events | Exact field/event names **UNVERIFIED**; confirm against the account's schema before coding | [S3] |
| Events API | `POST https://insights-collector.newrelic.com/v1/accounts/{id}/events` | **Ingest only** — never used by the reader | [S8] |

Fixed plan: entity search by name/service (1) → NRQL aggregate (≤2) → issue state (≤1). Total **≤ 4 GraphQL operations**, 10-second timeout each, no cursor page beyond the first 100 entities. The model cannot author NRQL; queries are templates with allowlisted entity names and a bounded window.

Caps: at most **10 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. NRQL results are summarized (one row per status/error class, ≤ 20 rows); raw `Transaction`/`Log` rows and full attribute maps are never returned. `truncated: true` on any omission, including a free-plan retention gap.

## 6. Framework fit

- Module: `packages/integrations/src/newrelic/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `graphql.ts`, `context.ts`, tests).
- Source enum: `newrelic` is **not** in `INCIDENT_SOURCES` today (`github`, `sentry`, `pagerduty`, `datadog`, `grafana`, `generic`). Extend the enum in a **contract commit before** the adapter; strict schemas reject the new value until then.
- Proposed functions: `verifyNewRelicDelivery` (shared header + freshness + pinned template), `normalizeNewRelicIncident` (severity from `priority`, service from `impactedEntities`), `fetchNewRelicIncidentContext` (fixed GraphQL plan).
- Agent tools: **none**. Context is injected by the worker; no model-authored GraphQL. If a query tool is later exposed it is `read_only` and audited as `tool.execute`; acknowledge/close is `sensitive` and out of scope.
- Env names: `NEW_RELIC_USER_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_REGION`, `NEW_RELIC_WEBHOOK_HEADER`, `NEW_RELIC_WEBHOOK_SECRET`.
- Sandbox: reader is server-side in the worker; sandbox egress denied; no key in prompt/tool result/error/audit; bounded redacted excerpts; audit only for tools.
- Tests: fake GraphQL transport; forged/unsigned payload causes re-fetch; `401` and `429` mapping; 25-concurrent limit respected by serial calls; retention gap produces `truncated`; tenant isolation by account id.

## 7. Operator setup checklist

1. Choose the US or EU region and record the matching GraphQL host; set `NEW_RELIC_REGION` and `NEW_RELIC_ACCOUNT_ID`.
2. Create a dedicated full user with read-only access to the in-scope accounts; issue one user API key for that identity.
3. Store the key server-side; never in the repository or a fixture.
4. Create a workflow with a Webhook destination: custom header `NEW_RELIC_WEBHOOK_HEADER` = random `NEW_RELIC_WEBHOOK_SECRET`, pinned JSON template, no Basic credentials in the URL.
5. Point it at `https://<host>/api/webhooks/newrelic`; filter to the alert policies in scope.
6. Set the server-side binding (organization, repository, workflow); the payload cannot select a tenant.
7. Confirm the Free plan's 8-day retention is acceptable for the read window; otherwise use a paid plan.
8. Add keys **last**, after offline gates pass.

```dotenv
NEW_RELIC_USER_API_KEY=
NEW_RELIC_ACCOUNT_ID=
NEW_RELIC_REGION=
NEW_RELIC_WEBHOOK_HEADER=
NEW_RELIC_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifyNewRelicDelivery`: valid header accepted; wrong/missing header `401`; stale `createdAt` rejected; oversize body `413`.
- [ ] `normalizeNewRelicIncident`: priority→severity mapping; fingerprint stable; unknown payload fields rejected.
- [ ] `fetchNewRelicIncidentContext`: ≤ 4 operations; NRQL bounded by window; ≤ 20 rows; no raw log rows; `truncated` on retention gap.
- [ ] Redaction: user key, `API-Key`, emails, IPs and account ids outside the allowlist removed before truncation.
- [ ] Tenant isolation: entity GUID from another account returns `NOT_FOUND`.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One `entitySearch` for a named test entity, or one NRQL count over ≤ 15 minutes.
- [ ] Record the GraphQL operation count, response size and latency; provider spend is `$0` (not credit-funded).
- [ ] Do not send a test alert to a production policy.

## 9. Risks / never in model context

- User API key, ingest license key, webhook shared secret, cookies.
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
