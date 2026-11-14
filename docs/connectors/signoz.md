# SigNoz connector

| Field | Value |
|---|---|
| Status | **Adapter implemented (relay-bound read context and tools; fake-tested). No native intake adapter** |
| Free tier verified | 2026-10-31 |
| Auth | `SIGNOZ-API-KEY` header [S3] |
| Inbound | **No native intake adapter.** The supported trigger is the generic signed bridge carrying a full `IncidentSignal` with `source: "signoz"` |
| Read | Query Range API v5 (PromQL), alert-rule detail and rule list |
| Writes | None in scope (channel/rule changes are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4 (open-source metrics backend). SigNoz is not in the survey. The adapter, read context and relay tools exist in `packages/integrations/src/signoz/` and `apps/device-daemon/src/vendors/signoz.ts`. There is no SigNoz intake mode in `apps/web`, so a notification channel cannot create a task directly; it must be re-signed onto the generic bridge. No live SigNoz acceptance run has been recorded.

## 1. Role in the agent

SigNoz is the OpenTelemetry-native option: one self-hosted or Cloud backend for metrics, logs and traces. It answers "which service changed, and how bad" for a service that is already suspected, using the PromQL expression of the alert rule that fired.

The trigger is the primary value. The reader is metrics-only in this adapter: one bounded PromQL window built from the rule's own expression, plus the rule metadata. It never fetches log bodies, span attributes, trace payloads or ClickHouse SQL, and the context plan never accepts a model-authored query. The optional `signoz.query_range` tool does accept a caller-supplied expression, but only a bounded read-only one (see §5). SigNoz documents no HMAC and no signed timestamp for a webhook channel [S2]; Basic auth or a shared token header is sender authentication, not a body signature, so a delivery must arrive through the generic signed bridge, which verifies its own HMAC over the exact bytes and then passes a strict `IncidentSignal`.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Community Edition | **Free forever, self-hosted, no data caps** [S1] | MIT Expat for most content; EE parts have separate terms [S6] |
| Cloud free tier | **None** [S1] | Cloud is paid; a **30-day free trial** exists on the Teams plan [S1] |
| Cloud entry price | **$49/month including $49 usage** [S1] | Logs/traces from $0.30/GB ingested; metrics from $0.10/million samples |
| Cloud retention | **15 days** logs/traces; **1 month** metrics [S1] | Plan-based, not configurable per tenant on Teams |
| Self-host retention | Configurable via ClickHouse TTL | Defaults vary by install; set an explicit TTL before onboarding — **UNVERIFIED** |
| Query limits | No published request/minute number — **UNVERIFIED** | Bound by `start`/`end`, `stepInterval`, row limit and a per-bundle call cap |
| Trial / credits | 30-day trial, no credit card stated [S1] | Not a platform credit provider |
| Ingest cap | Community: infrastructure-bound; Cloud: metered | The reader never ingests; it only queries |

"Free" therefore means self-hosted only. A Cloud deployment is a 30-day trial and then paid; the page must not imply a free-forever Cloud tier.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `SIGNOZ-API-KEY: <key>` [S3] |
| Key type | API key created in Settings > API Keys; exact workspace/org scope model **UNVERIFIED** |
| Access model | SigNoz API keys carry a role (viewer/editor/admin); exact role strings and per-endpoint scopes **UNVERIFIED** |
| Least privilege | Create a dedicated read-only key for the connector; no editor/admin key |
| Self-host | Authentication may be disabled by default; enable it and require the key, or restrict the API to the worker network |
| Lifetime | No documented expiry; rotate on a fixed schedule |
| Storage | The key is stored in the relay's encrypted local store under the paired credential; the server holds only `credential_ref` metadata |
| Rotation | Pair the connector again with a second read-only key, verify a read, then delete the first key; keep one active key per instance |

Do not reuse a key that can create alert rules or notification channels. The instance URL is a required selector and is validated as an https origin with no userinfo, query or fragment.

## 4. Inbound trigger

**There is no native SigNoz intake adapter.** The intake mode union in `apps/web/src/server/incident-intake.server.ts` contains `generic`, `github`, `sentry`, `grafana` and `pagerduty` only. A SigNoz notification is therefore re-signed onto the generic bridge.

| Property | Value |
|---|---|
| Supported path | `POST https://<host>/api/webhooks/<any-path>`, generic mode |
| Authentication | HMAC-SHA256 over `<timestamp>.<raw body>` using `WEBHOOK_SIGNING_SECRET`; timestamp within 300 s, secret at least 32 characters |
| Headers | `x-isolate-timestamp` (Unix seconds) and `x-isolate-signature: sha256=<64 hex>` |
| Body | A strict `IncidentSignal`; unknown fields rejected; 64 KiB cap; `source` must be `signoz` |
| Fingerprint | Device parser needs `signoz:<ruleId>`; the repo normalizer emits `signoz:<ruleId>:<first16hex(sha256(ruleId\|alertName\|service\|state\|stable labels))>` (an invalid rule id becomes `anon-<16hex>`) |
| Fingerprint bounds | Whole value <= 128 characters; each `:`-separated segment 1-64 characters; charset `[A-Za-z0-9._:@/-]`. Over 128 characters the builder truncates the rule id to 64 characters |
| States | `firing` creates a task; `resolved` is a lifecycle update and creates nothing |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes; the delivery id is traceability only |
| Response | `202 {taskId, jobId, deduped}` after task submission; no model work and no provider fetch in the request |

The repo normalizer (`normalizeSignozIncident`) selects only firing alerts; when several fire, the highest severity wins with a deterministic tie-break by rule id, alert fingerprint, alert name and stable label text. Severity comes from the `severity` or `priority` label (`critical`/`fatal` to `critical`, `error`/`high` to `high`, `warning`/`warn`/`medium` to `medium`, `low` to `low`, `info`/`debug` to `info`, absent or unrecognized to `medium`). Volatile labels such as pod, instance, container, node, host, user id and trace id are excluded from the fingerprint, so workload churn does not open a second task. `verifySignozDelivery` verifies the sender credential (Basic auth or a configured token header, compared in constant time, minimum 16 characters), parses the strict payload, requires at least one firing alert and a `startsAt`, and refuses an alert more than 5 minutes in the future or older than 15 minutes. A bridge that reuses these rules inherits them; the platform receiver itself never inspects a SigNoz payload. Basic auth or a token header on the channel is authentication, not a signature: verify it at the bridge's own edge, map the delivery to a signal, and sign the exact bytes forwarded.

Task provenance and evidence need one extra step. A bridge delivery records `incident_source`/`incident_fingerprint` on the task only when an enabled subscription for the connector id (`signoz`) matches the delivery; that path calls `createTaskForSignal` with provenance. If no subscription matches, the legacy generic path creates the task without a fingerprint, so the worker loads no SigNoz evidence. See [connector-onboarding.md](../connector-onboarding.md) §4.1.

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Alert rule | `GET /api/v2/rules/{id}`, falling back to `/api/v1/rules/{id}` on `404` | Name, type, state, evaluation window (`evaluation.spec` in the newer shape), frequency, description, a bounded label subset and summary/description/runbook annotations; the expression is used only when `ruleType` contains `promql` | [S4] |
| Metric query | `POST /api/v5/query_range` | One PromQL query named `A`; `start`/`end` in epoch milliseconds; `stepInterval` 30-300 s chosen so a series never exceeds 20 points | [S3] |
| Rule list | `GET /api/v3/rules?limit=n`, falling back to `/api/v1/rules` on `404` | Id, name, type and state only; never expressions or channel destinations | [S4] |

Fixed plan on the device path: rule detail (1) when the fingerprint names a rule id, then one `query_range` (1) only when that rule is explicitly a PromQL rule and its expression passes the bounded-PromQL check. Total **2 provider calls** (hard cap 2), 10-second timeout each (clamped to 30 s), window 15-60 minutes (default 30, starting 15 minutes before `startsAt`). No log aggregate and no trace summary are implemented: the response schema keeps time series only, and scalar/table payloads are dropped. A builder or threshold rule without PromQL skips the query and reports `truncated` rather than inventing one.

The context query is the rule's own expression; the model cannot author it. The optional `signoz.query_range` tool accepts a caller-supplied PromQL string, bounded to 500 printable-ASCII characters, with newlines, `;`, `#`, comments, backticks, `$` and `{{ }}` rejected before any request.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **1,500 characters** of metric summary, **5 series**, **20 points** per series, **256 KiB** per response and per bundle. Redaction runs before truncation. `truncated: true` when a call is skipped, denied or malformed, a series or point cap is hit, or the rule is not a PromQL rule.

### 5.1 Evidence loading

The worker never holds the SigNoz key. For a task carrying a `signoz:` fingerprint it resolves an active device and an `active` credential, requires a stored signal row for `(organization, signoz, fingerprint)`, and enqueues exactly one `signoz.context.fetch` device call with `{incidentFingerprint, service, kind}` and a bounded TTL. The device parses `signoz:<ruleId>`, requires a non-empty service, and passes the rule id so the rule lookup and its PromQL window can run. Any failure - no device, offline relay, missing signal row, timeout, malformed or mismatched bundle - returns `null`: the task continues without SigNoz evidence and is never failed by context loading.

## 6. Framework fit

- Module: `packages/integrations/src/signoz/` (`webhook.ts`, `normalize.ts`, `context.ts`, `tools.ts`, `redact.ts`, `schemas.ts`, tests); device handlers in `apps/device-daemon/src/vendors/signoz.ts`.
- Source enum: `signoz` exists in `INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`).
- Implemented functions: `verifySignozWebhook` / `verifySignozDelivery` (sender credential only - Basic auth or a configured token header, constant-time over SHA-256 digests, minimum 16 characters; reports `authenticated: "basic" | "token"`, never a verified-body claim), `normalizeSignozIncident` (firing alerts only; severity from the `severity`/`priority` label; rule/alert-name/service/state/stable-label fingerprint), `fetchSignozContext` (fixed plan above). The module also exposes `signozDedupeKey` (`signoz:<ruleId>:<alertFingerprint>:<state>`) for a caller that dedupes before normalizing; the generic bridge dedupes on `(organization, source, fingerprint)`.
- Device tools: `signoz.query_range`, `signoz.get_rule`, `signoz.list_rules`, plus `signoz.context.fetch` for incident context. The context call is worker-enqueued; the three read tools are available to the model only when the registry finds an `active` credential and the tool is enabled.
- Pairing fields: secret `apiKey`; required selector `baseUrl` (the SigNoz instance origin). There is no endpoint selector. The pairing page stores them in the relay's encrypted local store; the server stores metadata only.
- Sandbox: all reads execute on the user's device; sandbox egress stays denied; the API key never enters a prompt, tool result, error or audit detail; bounded redacted summaries only.
- Tests: fake HTTP only; a wrong or short Basic credential or token header is rejected in constant time; stale and future alerts rejected; `401` and transport failures map to `INTEGRATION_UNAVAILABLE`; `429` maps to `RATE_LIMITED`; `403`/`404`/`5xx` drop an optional resource and set `truncated`; the body cap is enforced before parsing; tenant isolation by key and instance.

## 7. Operator setup checklist

1. Choose self-hosted Community Edition or SigNoz Cloud; record the instance origin as the `baseUrl` selector.
2. Create a read-only API key; verify its role cannot edit rules or channels.
3. Pair the `signoz` connector on the relay with the `apiKey` secret and the `baseUrl` selector. The values stay in the relay's encrypted local store; never put them in the repository, a prompt or a fixture.
4. Create a Webhook notification channel with Basic auth or a shared token header; the bridge verifies that credential in constant time.
5. Configure the bridge sender to map the delivery to a strict `IncidentSignal` with `source: "signoz"` and the fingerprint shape in §4, and sign it with `WEBHOOK_SIGNING_SECRET`.
6. Point the sender at `https://<host>/api/webhooks/<any-path>`; attach only the in-scope rules and set the deployment binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow). The payload never selects a tenant.
7. Create an enabled subscription for the `signoz` connector if the task should carry provenance and load evidence (§4).
8. Confirm retention: Cloud Teams is 15 days for logs/traces; a self-host TTL must cover the read window.
9. Add keys **last**, after offline gates pass.

```dotenv
WEBHOOK_SIGNING_SECRET=
# Relay-local example only: the daemon reads the env var name configured in
# `vendors.signoz.secretEnv.apiKey`, so a deployment may name it differently.
SIGNOZ_API_KEY=
```

## 8. Acceptance checklist

Offline (providers disabled: `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [x] `verifySignozWebhook`: a wrong or short Basic credential or token header is rejected; comparisons are constant-time over SHA-256 digests; an oversize body is refused; an unconfigured credential fails closed.
- [x] `verifySignozDelivery`: strict payload; a delivery with no firing alert, no `startsAt`, a `startsAt` more than 5 minutes in the future or older than 15 minutes is refused.
- [x] `normalizeSignozIncident`: firing alerts only; highest severity wins deterministically; severity mapping from the label; rule/alert-name/service/state/label fingerprint stable; volatile labels excluded; unknown payload fields rejected.
- [x] `fetchSignozContext`: rule lookup then one `query_range` only for an explicit PromQL rule; 5 series / 20 points; 1,500-char summary; no log bodies or trace payloads; `truncated` on a skipped or malformed call.
- [x] Redaction: API key, Basic password, token header, emails, IPs and pod/host identifiers removed before truncation.
- [x] Relay context: `signoz.context.fetch` parses `signoz:<ruleId>` and requires a service; a malformed fingerprint fails validation without a provider call.
- [ ] Scoped `biome check`, project `tsc --noEmit`, scoped `bun test` twice.

Live: **runs 2026-11-13/14.** The 2026-11-13 run sent `signoz:e2e-rule-0001`, a rule id that does not exist in the workspace, and the relay returned an empty bundle; the run spent its turns re-listing rules and died on the job budget. The 2026-11-14 rerun used the real rule `01a1da78-8f3d-705e-9dae-9211e3840e5b` (`Isolate E2E error spike`, service `checkout`) on a SigNoz Cloud instance at `frank-shad.in2.signoz.cloud`. The first attempt showed why the earlier runs were empty: **the adapter read the v1 rule API, which answers `404` for rules created in the current console**, so a workspace that does hold a firing rule still produced `items: []`. Reading `GET /api/v2/rules/{id}` and `GET /api/v3/rules` (with a v1 fallback only on `404`) returned the real rule and the 1-rule list (4-5 s per device call), and the task context then carried an `alert_rule` item. Full run log, task ids and spend: [`live-verification.md`](live-verification.md).

## 9. Risks / never in model context

- API key, Basic password, token header, bridge `WEBHOOK_SIGNING_SECRET`.
- Raw log bodies, span attributes, trace payloads, exception stacks.
- High-cardinality labels: user id, email, IP, pod name, URL query strings.
- Alert rule definitions and channel destinations (may embed webhook URLs/secrets).
- Self-host ClickHouse credentials and DSNs.
- Provider text is untrusted; labels cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [SigNoz pricing](https://signoz.io/pricing/) |
| S2 | [Configure webhook channel](https://signoz.io/docs/alerts-management/notification-channel/webhook/) |
| S3 | [Metrics query range API](https://signoz.io/docs/metrics-management/query-range-api/) |
| S4 | [SigNoz API reference](https://signoz.io/api-reference/) |
| S5 | [Logs API overview](https://signoz.io/docs/logs-management/logs-api/overview/) | |
| S6 | [SigNoz repository license](https://github.com/SigNoz/signoz/blob/main/LICENSE) |

Verification notes: the pricing page states Community Edition is free with no data caps and that Cloud has **no free tier** (30-day trial, then $49/month). That contradicts the common "SigNoz Cloud free tier" assumption and is recorded here deliberately. Exact API-key roles, log-query paths and retry behavior are **UNVERIFIED**; the v5 query_range body fields are from the official metrics API page.
