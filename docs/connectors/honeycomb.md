# Honeycomb connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Free tier verified | 2026-10-31 |
| Auth | `X-Honeycomb-Team` configuration key [S5] |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "honeycomb"` |
| Read | Query Data API (create, run, fetch result), SLO API, trigger snapshot from the signal |
| Writes | None in scope (trigger create/update is a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4 (metrics backend alternatives). The adapter, read context and relay tools exist in `packages/integrations/src/honeycomb/` and `apps/device-daemon/src/vendors/honeycomb.ts`. There is no Honeycomb intake mode in `apps/web`, so a webhook delivery cannot create a task directly; it must be re-signed onto the generic bridge. Live runs reached PRs with no query evidence; see §8 and [`live-verification.md`](live-verification.md).

**Measured account limitation (2026-11-17):** in environment `test`, the enabled
Configuration key's **Run queries** permission is unchecked and disabled. The
Honeycomb console states “This feature is only available for enterprise plans.”
A Configuration key alone is insufficient for the Query Data API on this account.
No upgrade, trial, new key or query request was made during this inspection.

## 1. Role in the agent

Honeycomb is a high-cardinality event store: it answers "which field combination is anomalous" for a service that is already suspected. The trigger names the dataset and the breached threshold; the reader returns one bounded query result (a small group-by table or a time series summary) and the SLO state.

It must not be used to explore arbitrary fields, to pull raw events, or to replace logs. The query plan is fixed and the model never authors a query specification. Honeycomb's webhook token is authentication, not message signing [S2], so a delivery must arrive through the generic signed bridge, which verifies its own HMAC over the exact bytes and then passes a strict `IncidentSignal`.

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

The Free account can supply trigger metadata, but its API key editor does not
permit Query Data API access. Treat query evidence as unavailable until the
account has the required entitlement and a key with **Run queries** enabled.
The 60-day retention is a hard ceiling for incident lookback.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `X-Honeycomb-Team: <configuration key>` [S5] |
| Key type | **Configuration key** (read/manage resources); ingest keys only send telemetry and must not be used for reads [S5] |
| Scope | Environment-level keys access one environment and its datasets [S5] |
| Management API | `Authorization: Bearer <management key>` is for account-level management; not needed for the reader [S5] |
| Lifetime | No documented expiry; rotate on a fixed schedule |
| Storage | The configuration key is stored in the relay's encrypted local store under the paired credential; the server holds only `credential_ref` metadata |
| Rotation | Pair the connector again with a second configuration key in the same environment, verify queries, then delete the first |

Use one environment-scoped configuration key per tenant. Do not use a management key; it reaches account configuration the reader does not need.

## 4. Inbound trigger

**There is no native Honeycomb intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. A Honeycomb delivery is therefore re-signed onto the generic bridge.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `honeycomb` |
| Fingerprint | `honeycomb:<dataset>:<triggerId>:<state>`; over 128 characters it is rebuilt as `honeycomb:<34>:<34>:<16>~<12hex>` so two long prefixes cannot merge |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated identifier 1-64 characters; parser charset `[A-Za-z0-9._:@/-]`. The state also accepts the builder's exact `~<12 lowercase hex>` digest suffix; the digest is excluded from the state selector |
| States | `triggered`, `firing`, `critical`, `warning` are incidents; `ok`, `resolved` and `recovered` are lifecycle updates and do not create a task |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the delivery id is traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

The repo normalizer (`normalizeHoneycombIncident`) rejects a delivery older than 15 minutes or more than 5 minutes in the future and maps state/threshold to severity. A bridge that reuses it inherits those rules; the platform receiver itself never inspects a Honeycomb payload. Verify `X-Honeycomb-Webhook-Token` at the bridge's own edge, map the delivery to a signal, and sign the exact bytes forwarded.

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`honeycomb`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no Honeycomb evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

Base host: `https://api.honeycomb.io` (US); EU environments use the environment-specific API host (EU host **UNVERIFIED**). Dataset slugs and trigger ids are validated against `^[a-z0-9][a-z0-9_-]{0,63}$`.

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Create query | `POST /1/queries/{datasetSlug}` | One fixed template by `kind`: `calculations`, `breakdowns`, a `service.name` filter, `time_range` 60-3,600 s, `limit` 20 | [S3][S4] |
| Run query | `POST /1/query_results/{datasetSlug}` | Body `{query_id}`; returns a result id; run once, no polling | [S3] |
| Fetch result | `GET /1/query_results/{datasetSlug}/{id}` | The reader keeps the last point of each series and at most 20 rows; raw spans/events are never fetched | [S3] |
| SLO state | `GET /1/slos/{datasetSlug}` | SLO name, target, current, status; Free returns an empty list, treated as `truncated` | [S6] |
| Trigger detail | The normalized signal only | `honeycomb.get_trigger` performs no provider call; the full definition may embed recipients | [S2] |

Fixed plan on the device path: trigger snapshot rebuilt from the fingerprint (0 calls) → create query (1) → run query (1) → fetch result (1) → SLO list (1). Total **at most 4 provider calls**, 10-second timeout each, one page each, no retries. Query templates are selected by `kind` (`latency`, `error_rate`, `saturation`), defaulting to `latency`; the normalizer's `trigger_triggered` incident kind also maps to that default. The service filter comes from the validated signal, never from model output, and the window is 1-60 minutes (default 60). A refused/unavailable/rate-limited query or SLO read preserves the locally derived trigger item with `truncated: true`; it does not prove that query data was read.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **2,000 characters** per query or SLO summary, **20 query rows**, **20 SLO rows**, **256 KiB** per response and per bundle. `truncated: true` when a source is capped, a call is denied or malformed, the query is incomplete, or the SLO list is empty.

### 5.1 Evidence loading

The worker never holds the Honeycomb key. For a task carrying a `honeycomb:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, honeycomb, fingerprint)`, and enqueues exactly one `honeycomb.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses `dataset:triggerId:state`, requires a non-empty service, validates the trigger id against `^[a-z0-9][a-z0-9_-]{0,63}$` and the state against the known set, rebuilds the trigger snapshot as `{id, name: triggerId, state}`, then runs the query and SLO calls. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without Honeycomb evidence and is never failed by context loading.

## 6. Framework fit

- Module: `packages/integrations/src/honeycomb/` (`client.ts`, `webhook.ts`, `normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, tests); device handlers in `apps/device-daemon/src/vendors/honeycomb.ts`.
- Source enum: `honeycomb` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`).
- Implemented functions: `verifyHoneycombWebhookToken` (constant-time token comparison), `verifyHoneycombDelivery` (refuses a delivery unless `bridgeVerified` is true; never claims a vendor signature), `normalizeHoneycombIncident` (triggering states only, state/threshold severity, dataset/trigger/state fingerprint), `fetchHoneycombIncidentContext` (fixed plan above).
- Device tools: `honeycomb.run_query`, `honeycomb.get_trigger`, `honeycomb.list_slos`, plus `honeycomb.context.fetch` for incident context. The context call is worker-enqueued; the three read tools are available to the model only when the registry finds an `active` credential and the tool is enabled. `get_trigger` makes no provider call: it reads the snapshot captured with the incident.
- Pairing fields: secret `apiKey`; required selector `dataset`; optional selector `apiBaseUrl`. The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all reads execute on the user's device; sandbox egress stays denied; the configuration key never enters a prompt, tool result, error or audit detail; bounded redacted rows only.
- Tests: fake HTTP only; bridge authentication and freshness, strict fingerprint/digest parsing, normalized incident-kind mapping, tenant isolation, and trigger-only partial evidence on query/SLO failures. Standalone query tools retain typed `INTEGRATION_UNAVAILABLE`/`RATE_LIMITED` failures; context assembly preserves its trigger snapshot instead.
- Verification: one bounded `/1/auth` read inspects credential `type`; `configuration` verifies, explicit `ingest` returns `AUTH_FAILED`, and missing/unknown types return `PROVIDER_ERROR` without promoting the credential. Verification proves authentication and class; it does not prove enterprise query entitlement.

## 7. Operator setup checklist

1. Choose the environment/dataset; this is the `dataset` selector.
2. Create an environment-scoped **configuration** key; do not use an ingest key.
3. Pair the `honeycomb` connector on the relay with the `apiKey` secret, the `dataset` selector and, when not US, the `apiBaseUrl` selector. The values stay in the relay's encrypted local store; never put them in the repository, a prompt or a fixture.
4. Create a webhook recipient with a random token; the bridge verifies that token in constant time.
5. Configure the bridge sender to map the delivery to a strict `IncidentSignal` with `source: "honeycomb"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
6. Point the sender at `https://<host>/api/webhooks/<any-path>`; attach the recipient to the in-scope triggers and set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow). The payload never selects a tenant.
7. Create an enabled subscription for the `honeycomb` connector if the task should carry provenance and load evidence (§4).
8. Add keys **last**, after offline gates pass.

```dotenv
WEBHOOK_SIGNING_SECRET=
# Relay-local example only: the daemon reads the env var name configured in
# `vendors.honeycomb.secretEnv.apiKey`, so a deployment may name it differently.
HONEYCOMB_API_KEY=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] `verifyHoneycombDelivery`: a delivery without a bridge verdict is refused; an oversize body is refused; a valid bridge verdict plus a valid delivery id is accepted.
- [x] `verifyHoneycombWebhookToken`: a short or missing expected token fails; comparison is constant-time.
- [x] `normalizeHoneycombIncident`: triggering states only; dataset + trigger id + state fingerprint stable; stale/future alert rejected; unknown payload fields rejected.
- [x] `fetchHoneycombIncidentContext`: exactly 4 calls (query create/run/fetch plus SLO list); rows <= 20; window <= 60 minutes; `truncated` on an empty SLO list.
- [x] Redaction: configuration key, webhook token, email/IP/hostname fields removed before truncation.
- [x] Relay context: `honeycomb.context.fetch` parses `dataset:triggerId:state`, validates the trigger id and state, and requires a service; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **runs 2026-11-13 and 2026-11-14.** The 2026-11-13 run executed `honeycomb.context.fetch` twice (4.9 s and 7.4 s) and failed `INTEGRATION_UNAVAILABLE`; the workspace's `test` environment had no datasets. On 2026-11-14 dataset `checkout` was created in that environment with three events (`service: checkout`, status codes `500`, `502`, `200`), and three more deliveries were run:

- Run 8 (`3a91e5cc`, PR #9) sent the two-segment fingerprint `honeycomb:e2e-checkout-error-spike-r8`. The strict parser rejects it, so **no context call was enqueued at all** and the task ran to a PR without evidence.
- Run 9 (`b1f2fc0d`) sent `honeycomb:checkout:checkout-error-rate:triggered` with signal kind `alert`. Fingerprint, trigger id and state pass, but the daemon maps the signal kind through `HONEYCOMB_QUERY_KINDS`, which accepts only `latency`, `error_rate` and `saturation`, so the call failed `VALIDATION_FAILED` in 4 ms. That task was rejected at its push gate.
- Run 10 (`0a6bf6e8`, PR #10) sent kind `error_rate` and the same fingerprint with a fresh trigger id. The call now reaches Honeycomb and fails `INTEGRATION_UNAVAILABLE` after ~850 ms; the bundle builder maps only a `401` or a transport failure to that code, and `/1/auth` accepted the same key on 2026-11-14T15:32Z (the integration page shows Connected/verified), so the key is ingest-class rather than query-capable. The run still committed `100a2cf` and opened PR #10.

Two invariants for a bridge sender follow from this: the fingerprint must carry `dataset:triggerId:state`, and the signal kind must be a query kind, not `alert`. A Configuration key is required, but the 2026-11-17 browser inspection established an additional account-entitlement blocker: **Run queries** is disabled with the enterprise-plan message above. Re-pairing alone cannot establish query-read acceptance. The old Onboarding ingest key is confirmed **Disabled**. Measured spend: 354,585/21,116 (2026-11-13), 229,224/29,967 (run 8). Full run log: [`live-verification.md`](live-verification.md).

## 9. Risks / never in model context

- Configuration key, management key, ingest key, webhook token, bridge `WEBHOOK_SIGNING_SECRET`.
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
