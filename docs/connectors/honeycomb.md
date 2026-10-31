# Honeycomb connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | `X-Honeycomb-Team` configuration key [S5] |
| Inbound | Webhook recipient with `X-Honeycomb-Webhook-Token`; **no HMAC** [S2] |
| Read | Query Data API, SLO API |
| Writes | None in scope (trigger create/update is a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4 (metrics backend alternatives). Honeycomb is not in the survey. Nothing below is implemented.

## 1. Role in the agent

Honeycomb is a high-cardinality event store: it answers "which field combination is anomalous" for a service that is already suspected. The trigger names the dataset and the breached threshold; the reader returns one bounded query result (a small group-by table or a time series summary) and the SLO state.

It must not be used to explore arbitrary fields, to pull raw events, or to replace logs. The query plan is fixed and the model never authors a query specification.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Plan | Free, free forever [S1] | No credit card / credit trial assumed |
| Events | **20 million events/month** [S1] | Over the cap, ingestion is blocked or throttled — exact overage behavior **UNVERIFIED** |
| Metrics | **100 million metrics data points/month** [S1] | Separate from event volume |
| Triggers | **2** on Free [S1] | Enough for one service and one severity threshold |
| SLOs | **None** on Free [S1] | The SLO reader must degrade, not fail, on Free |
| Retention | **60 days** for events/logs; **13 months** for metrics datasets [S7] | Plan-independent fixed windows per the usage page |
| Query limits | Query duration **≤ 7 days**; **10,000 rows**; **10 requests/minute** [S3] | Per dataset/query result call |
| Trial / credits | No trial credits; Free is the entry plan [S1] | Not a platform credit provider |

Free is viable for a design partner with one environment and two triggers. The 60-day retention is a hard ceiling for incident lookback.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `X-Honeycomb-Team: <configuration key>` [S5] |
| Key type | **Configuration key** (read/manage resources); ingest keys only send telemetry and must not be used for reads [S5] |
| Scope | Environment-level keys access one environment and its datasets [S5] |
| Management API | `Authorization: Bearer <management key>` is for account-level management; not needed for the reader [S5] |
| Lifetime | No documented expiry; rotate on a fixed schedule |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second configuration key in the same environment, deploy, verify queries, delete the first |

Use one environment-scoped configuration key per tenant. Do not use a management key; it reaches account configuration the reader does not need.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/honeycomb` |
| Signature header | **None** [S2] |
| Authentication header | `X-Honeycomb-Webhook-Token` — a per-recipient shared token [S2] |
| Signed timestamp | No; payload timestamps are data, not freshness proof |
| Replay control | Reject an alert older than 15 minutes by its trigger timestamp; dedupe by trigger id + dataset |
| Dedupe key | `honeycomb:<dataset>:<trigger-id>:<alert-state>`; delivery id is traceability only |
| Delivery header | `X-Honeycomb-Webhook-Delivery-ID` [S2] |
| Body cap | 64 KiB (platform default) |
| Retries | Up to **3** retries on 408/429/502/503 or timeout, honouring `Retry-After`; endpoint must answer within **15 seconds** [S2] |
| Response | `202` before model work; no payload echo |

Honeycomb's webhook token is authentication, not message signing. Verify the token in constant time, then re-fetch the trigger/SLO state through the API before creating a task. The payload JSON is the "result of the alert" [S2]; exact field names were not extracted — **UNVERIFIED**. Capture one fixture from the test recipient and pin a strict schema before coding.

## 5. Read-only context

Base host: `https://api.honeycomb.io` (US); EU environments use the environment-specific API host (EU host **UNVERIFIED**). Dataset slugs and trigger ids are validated against `^[a-z0-9][a-z0-9_-]{0,63}$`.

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Create query | `POST /1/queries/{datasetSlug}` | `calculations`, `breakdowns`, `filters`, `time_range` (≤ 3,600 s), `granularity`, `limit` ≤ 100 | [S3][S4] |
| Run query | `POST /1/query_results/{datasetSlug}` | Body `{query_id}`; returns a result id | [S3] |
| Fetch result | `GET /1/query_results/{datasetSlug}/{id}` | Summary rows and series; ≤ 10,000 rows, but the reader caps at 100 | [S3] |
| SLO state | `GET /1/slos/{datasetSlug}` | SLO name, target, current status; Free returns none | [S6] |
| Trigger detail | Webhook payload only | Do not fetch the full trigger definition (may embed recipients) | [S2] |

Fixed plan: trigger payload (0 calls) → create query (1) → run query (1) → fetch result (1) → SLO list (≤1). Total **≤ 4 calls**, 10-second timeout, one page. Query templates are selected by `kind` (`latency`, `error_rate`, `saturation`); the service/environment filter comes from validated identifiers, never from model output.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. A query item carries ≤ 100 rows and ≤ 20 series points per group; raw events are never fetched. `truncated: true` when the 7-day window, row cap, rate limit or a missing SLO drops evidence.

## 6. Framework fit

- Module: `packages/integrations/src/honeycomb/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `queries.ts`, `context.ts`, tests).
- Source enum: `honeycomb` is not in `INCIDENT_SOURCES`; extend it in a **contract commit before** the adapter. Strict schemas reject the value until the contract ships.
- Proposed functions: `verifyHoneycombDelivery` (token + freshness + strict payload), `normalizeHoneycombIncident` (severity from trigger threshold/state), `fetchHoneycombIncidentContext` (fixed query plan).
- Agent tools: **none**. The worker injects context; no model-authored query spec. A future query tool would be `read_only` and audited; trigger create/update is `sensitive` and out of scope.
- Env names: `HONEYCOMB_API_KEY`, `HONEYCOMB_API_HOST`, `HONEYCOMB_DATASET`, `HONEYCOMB_WEBHOOK_TOKEN`.
- Sandbox: server-side reader; sandbox egress denied; configuration key never in prompt/tool result/error/audit; bounded redacted rows; `tool.execute` audit only if a tool is added.
- Tests: fake HTTP; wrong token `401`; stale alert rejected; retry header honoured at most once; `429` → `RATE_LIMITED`; 7-day window enforced in code; empty SLO on Free yields `truncated`, not an error; tenant isolation by environment key.

## 7. Operator setup checklist

1. Choose the environment/dataset and record `HONEYCOMB_API_HOST` and `HONEYCOMB_DATASET`.
2. Create an environment-scoped **configuration** key; do not use an ingest key.
3. Store it server-side; never in the repository or a fixture.
4. Create a webhook recipient with a random token; set `HONEYCOMB_WEBHOOK_TOKEN` to the same value.
5. Point the recipient at `https://<host>/api/webhooks/honeycomb`; attach it to the two in-scope triggers.
6. Set the server-side binding (organization, repository, workflow); the payload cannot select a tenant.
7. Capture one test delivery and pin the payload schema; record the field names that were **UNVERIFIED** in this page.
8. Add keys **last**, after offline gates pass.

```dotenv
HONEYCOMB_API_KEY=
HONEYCOMB_API_HOST=
HONEYCOMB_DATASET=
HONEYCOMB_WEBHOOK_TOKEN=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifyHoneycombDelivery`: correct token accepted; wrong/missing token `401`; stale trigger rejected; oversize body `413`.
- [ ] `normalizeHoneycombIncident`: dataset + trigger id fingerprint stable; unknown payload fields rejected.
- [ ] `fetchHoneycombIncidentContext`: ≤ 4 calls; query window ≤ 7 days; rows ≤ 100; `truncated` on free-plan SLO absence.
- [ ] Redaction: configuration key, webhook token, email/IP/hostname fields removed before truncation.
- [ ] Tenant isolation: key from environment A cannot query environment B.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One query-result round trip for a named dataset over ≤ 15 minutes; record response rows and bytes.
- [ ] Provider spend is `$0`; Honeycomb is not credit-funded.
- [ ] Do not create or edit a production trigger.

## 9. Risks / never in model context

- Configuration key, management key, ingest key, webhook token.
- Raw events and full attribute maps (high-cardinality fields often carry user ids, emails, URLs).
- Query specs that embed customer identifiers outside the validated filter.
- Trigger definitions with recipient lists, webhook URLs or secrets.
- SLO free-text descriptions and owner names.
- Provider text is untrusted; a field value cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Honeycomb pricing](https://www.honeycomb.io/pricing) |
| S2 | [Send alerts to webhooks](https://docs.honeycomb.io/notify/webhooks) |
| S3 | [Create a query result](https://docs.honeycomb.io/api/query-data/create-a-query-result) |
| S4 | [Query specification](https://docs.honeycomb.io/reference/query-specification) |
| S5 | [Honeycomb API authentication](https://docs.honeycomb.io/api/authentication) |
| S6 | [Get all SLOs](https://docs.honeycomb.io/api/slos/get-all-slos) |
| S7 | [How Honeycomb calculates usage](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage) |

Verification notes: free-plan limits (20M events, 100M points, 2 triggers, no SLOs) are from the official pricing page; 60-day/13-month retention is from the official usage page. Payload field names and the EU API host were not extracted and are marked **UNVERIFIED**. No HMAC is documented; the webhook token is authentication only.
