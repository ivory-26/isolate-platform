# Axiom connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Free tier verified | 2026-10-31 |
| Auth | `Authorization: Bearer <API token>` [S3][S5] |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "axiom"` |
| Read | APL query API, datasets API, registry-backed monitor lookup |
| Writes | None in scope (monitor/notifier changes are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4. The adapter, read context and relay tools exist in `packages/integrations/src/axiom/` and `apps/device-daemon/src/vendors/axiom.ts`. There is no Axiom intake mode in `apps/web`, so a notifier delivery cannot create a task directly; it must be re-signed onto the generic bridge. No live Axiom acceptance run has been recorded.

## 1. Role in the agent

Axiom is a log/event store with APL (Axiom Processing Language), a Kusto-like query language. It answers "which event pattern changed and how often" for a service that is already suspected, and it is useful when the org centralises application logs there.

The trigger is the primary value; the reader returns bounded APL aggregates (counts by status, route or error kind), never raw rows. The context plan never accepts model-authored APL; the optional `axiom.query_apl` tool does, under a strict read-only pipeline guard. Axiom documents no HMAC [S4], so a delivery must arrive through the generic signed bridge, which verifies its own HMAC over the exact bytes and then passes a strict `IncidentSignal`.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Plan | **Personal, free forever** [S2] | No credit card / credit trial assumed |
| Data loading | **500 GB/month** [S2] | Over the cap, loading is blocked until the next cycle — exact behavior **UNVERIFIED** |
| Storage | **25 GB** [S2] | Stored volume, separate from monthly loading |
| Retention | **30 days** [S2] | Paid plans allow custom retention |
| Datasets | **3** [S2] | One dataset per service/environment is the practical limit |
| Users | **1** [S2] | A service token is the only reader identity |
| Query compute | **10 GB-hours/month** [S2] | Heavy APL scans can exhaust this; bound the window |
| Trial / credits | Free Personal is not a trial; no credits assumed [S1] | Not a platform credit provider |

Free is adequate for one small service. Three datasets and 30 days mean the connector must not assume a multi-service catalog or long lookback.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Bearer <token>` [S3][S5] |
| Token types | **Basic** tokens ingest to specific datasets; **Advanced** tokens perform custom actions [S5] |
| Reader token | An Advanced token restricted to query/read on the in-scope datasets; exact permission strings **UNVERIFIED** |
| Ingest token | Must not be used for reads; it cannot query |
| Lifetime | No documented expiry; rotate on a fixed schedule |
| Storage | The token is stored in the relay's encrypted local store under the paired credential; the server holds only `credential_ref` metadata |
| Rotation | Pair the connector again with a second query-only token, verify, then delete the first |

Do not use an organization-wide admin token. The dataset name is validated `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and must match the configured allowlist; a token scoped to a dataset is the second layer.

## 4. Inbound trigger

**There is no native Axiom intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. An Axiom delivery is therefore re-signed onto the generic bridge.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `axiom` |
| Fingerprint | Device parser needs `axiom:<monitorId>`; the repo normalizer emits `axiom:<monitorId up to 48 chars>:<first24hex(sha256(monitor\|dataset\|group\|state))>` |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated segment 1-64 characters; charset `[A-Za-z0-9._:@/-]` |
| Actions | `triggered`, `trigger`, `firing`, `alert`, `alerting` create a task; `resolved`, `resolve`, `recovered`, `recovery`, `ok` and `normal` actions or states create nothing |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the delivery id is traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

The repo normalizer (`normalizeAxiomIncident`) rejects an alert whose unsigned timestamp is older than 15 minutes, derives severity from the payload severity field (default `high`), and hashes monitor, dataset, group and state. A bridge that reuses it inherits those rules; the platform receiver itself never inspects an Axiom payload. A notifier's optional shared header is authentication, not a signature: verify it at the bridge's own edge, map the delivery to a signal, and sign the exact bytes forwarded.

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`axiom`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no Axiom evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Datasets | `GET /v1/datasets` | Names and ids only; the configured dataset must be in the local allowlist before any request | [S6] |
| APL query | `POST /v1/query/_apl?format=tabular` | Body `{apl, startTime, endTime}`; one templated aggregate over 5-60 minutes, at most 20 rows | [S3] |
| Monitor state | Trusted monitor registry | No HTTP call: the monitor read path is **UNVERIFIED**, so `axiom.get_monitor` resolves a configured descriptor only | [S4] |

Fixed plan on the device path: dataset list (1) then one APL aggregate (1). A monitor item is added from the trusted registry (0 calls) when the fingerprint names a configured monitor. The hard cap is **3 provider calls**, 10-second timeout each, window 5-60 minutes (default 30). The context APL template is fixed: `['dataset'] | where service == "…" | summarize count = count() by service, environment, status, error_kind = tostring(['error.kind']) | order by count desc | limit 20`; the service value is escaped before it enters the literal.

The optional `axiom.query_apl` tool accepts model-authored APL but only a single read-only pipeline against the configured dataset: the first token is one dataset (matching the allowlist), every stage starts with an allowlisted operator, every called function is allowlisted, and `*`, `//`, null bytes, mutation keywords and cross-dataset statements are rejected before any request.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **2,000 characters** per summary, **20 APL rows**, **256 KiB** per response and per bundle. Raw log lines and full event maps are never returned. `truncated: true` when a source is capped, a call is denied or malformed, or the query returns no usable table.

### 5.1 Evidence loading

The worker never holds the Axiom token. For a task carrying an `axiom:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, axiom, fingerprint)`, and enqueues exactly one `axiom.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses `axiom:<monitorId>`, requires a non-empty service, and passes the monitor id so a registry descriptor can be attached. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without Axiom evidence and is never failed by context loading.

## 6. Framework fit

- Module: `packages/integrations/src/axiom/` (`webhook.ts`, `normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, tests); device handlers in `apps/device-daemon/src/vendors/axiom.ts`.
- Source enum: `axiom` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`).
- Implemented functions: `verifyAxiomWebhook` (optional shared header compared in constant time; never claims a signature), `normalizeAxiomIncident` (triggered actions only, severity from the payload with `high` default, monitor/dataset/group/state fingerprint), `fetchAxiomIncidentContext` (fixed plan above).
- Device tools: `axiom.query_apl`, `axiom.get_monitor`, `axiom.list_datasets`, plus `axiom.context.fetch` for incident context. The context call is worker-enqueued; the three read tools are available to the model only when the registry finds an `active` credential and the tool is enabled. `get_monitor` reads the configured monitor registry and makes no HTTP call.
- Pairing fields: secret `token`; required selectors `baseUrl` and `dataset`; optional allowlist `allowedDatasets` (configuration only; the paired dataset is always added to it). The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all reads execute on the user's device; sandbox egress stays denied; the token never enters a prompt, tool result, error or audit detail; bounded redacted tables only.
- Tests: fake HTTP only; a wrong configured shared header is rejected and a missing one fails; stale alert rejected; `401` and transport failures map to `INTEGRATION_UNAVAILABLE`; `429` maps to `RATE_LIMITED`; the context APL template cannot be influenced by payload text; the dataset allowlist is enforced before any request; token from one tenant cannot query another.

## 7. Operator setup checklist

1. Choose the dataset and region/API host; these are the `dataset` and `baseUrl` selectors.
2. Create an Advanced token limited to query on that dataset; verify it cannot ingest or manage.
3. Pair the `axiom` connector on the relay with the `token` secret and the `baseUrl` and `dataset` selectors. The values stay in the relay's encrypted local store; never put them in the repository, a prompt or a fixture.
4. Create a custom webhook notifier with an optional random header and a pinned Go template.
5. Configure the bridge sender to verify that header, map the delivery to a strict `IncidentSignal` with `source: "axiom"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
6. Point the sender at `https://<host>/api/webhooks/<any-path>`; attach only the in-scope monitors and set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow). The payload never selects a tenant.
7. Create an enabled subscription for the `axiom` connector if the task should carry provenance and load evidence (§4).
8. Confirm the free plan's 30-day retention and 10 GB-hour query budget are sufficient; otherwise reduce the window or upgrade.
9. Add keys **last**, after offline gates pass.

```dotenv
WEBHOOK_SIGNING_SECRET=
# Relay-local example only: the daemon reads the env var name configured in
# `vendors.axiom.secretEnv.token`, so a deployment may name it differently.
AXIOM_TOKEN=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] `verifyAxiomWebhook`: an oversize body is refused; a configured header must match in constant time; a partial configuration fails closed; an unconfigured header reports `unsigned`, never `signed`.
- [x] `normalizeAxiomIncident`: only triggered actions create a signal; stale timestamp rejected; monitor/dataset/group/state fingerprint stable; unknown payload fields rejected.
- [x] `fetchAxiomIncidentContext`: 2 HTTP calls (dataset list, APL aggregate); at most 20 rows; no raw log lines; `truncated` on a dropped table.
- [x] Redaction: token, shared header secret, emails, IPs and URL query strings removed before truncation.
- [x] Dataset allowlist rejects an unknown dataset before any request; the APL guard rejects `*`, `//`, mutation keywords and a second dataset.
- [x] Relay context: `axiom.context.fetch` parses `axiom:<monitorId>` and requires a service; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **not run.** No Axiom acceptance has been recorded. When authorized, use one APL aggregate for a named dataset over at most 15 minutes, record the measured rows and bytes, and do not edit a production monitor or notifier.

## 9. Risks / never in model context

- API token, notifier shared header secret, ingest token, bridge `WEBHOOK_SIGNING_SECRET`.
- Raw log lines, event maps, `project`-ed fields, request bodies and headers.
- PII in log attributes: email, IP, user id, session id, URL query strings.
- Monitor and notifier definitions (recipient URLs, headers, secrets).
- APL text that embeds customer identifiers outside the validated filter.
- Provider text is untrusted; a log field cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Axiom pricing](https://axiom.co/pricing) |
| S2 | [Axiom limits](https://axiom.co/docs/reference/limits) |
| S3 | [Axiom query API](https://axiom.co/docs/restapi/query) |
| S4 | [Custom webhook notifier](https://axiom.co/docs/monitor-data/custom-webhook-notifier) |
| S5 | [Axiom tokens](https://axiom.co/docs/reference/tokens) |
| S6 | [Get datasets](https://axiom.co/docs/restapi/endpoints/getDatasets) |

Verification notes: free Personal limits (500 GB/month loading, 25 GB storage, 30-day retention, 3 datasets, 1 user, 10 GB-hours) are from the official limits page. Token permission strings, dataset-query body and retry behavior are **UNVERIFIED**. No HMAC is documented; the notifier supports optional headers, which are authentication only.
