# SigNoz connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | `SIGNOZ-API-KEY` header [S3] |
| Inbound | Webhook notification channel; **no HMAC** — shared header/basic auth plus re-fetch [S2] |
| Read | Query Range API v5 (PromQL / ClickHouse), logs and traces APIs |
| Writes | None in scope (channel/rule changes are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4 (open-source metrics backend). SigNoz is not in the survey. Nothing below is implemented.

## 1. Role in the agent

SigNoz is the OpenTelemetry-native option: one self-hosted or Cloud backend for metrics, logs and traces. It answers "which service, operation or pod changed, and how bad" using PromQL or ClickHouse SQL over a bounded window.

The trigger is the primary value. The reader is aggregate-first: one metric query plus, at most, one log count table. It must not be used to dump traces, fetch raw log bodies or run model-authored SQL.

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
| Key type | API key created in Settings → API Keys; exact workspace/org scope model **UNVERIFIED** |
| Access model | SigNoz API keys carry a role (viewer/editor/admin); exact role strings and per-endpoint scopes **UNVERIFIED** |
| Least privilege | Create a dedicated read-only key for the connector; no editor/admin key |
| Self-host | Authentication may be disabled by default; enable it and require the key, or restrict the API to the worker network |
| Lifetime | No documented expiry; rotate on a fixed schedule |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second read-only key, deploy, verify, delete the first |

Do not reuse a key that can create alert rules or notification channels.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/signoz` |
| Signature header | **None documented** [S2] |
| Authentication | Webhook URL plus optional Basic auth in the channel [S2] |
| Signed timestamp | No; payload `startsAt`/`endsAt` are data only |
| Replay control | Reject alerts older than 15 minutes; dedupe by rule id + alert fingerprint + state |
| Dedupe key | `signoz:<rule-id>:<fingerprint>:<state>`; delivery id is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | Not documented on the channel page — **UNVERIFIED**; reconcile by querying the rule/alert state |
| Response | `202` before model work; no payload echo |

The webhook payload contains `alerts`, `status` and `fingerprint` fields [S2]. Basic auth is authentication of the sender, not a body signature; verify it in constant time and re-fetch the alert/rule state before creating a task. For a signed trigger, route the channel through the generic signed bridge (README §3).

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Metric query | `POST /api/v5/query_range` | `start`, `end`, `stepInterval`, `compositeQuery`; PromQL or ClickHouse builder query | [S3] |
| Log aggregate | Same endpoint with a logs query | Count by `severity_text`/`service.name`; **no body** | [S3][S5] |
| Trace summary | Same endpoint with a traces query | Count/latency by `service.name` and `operation`; no span attributes dump | [S3] |
| Logs API | Logs query endpoint | Exact path/version **UNVERIFIED**; use query_range v5 where possible | [S5] |
| Alert/rule state | Query the rule or alert list | Exact path **UNVERIFIED**; confirm against `/api/v5` reference | [S4] |

Fixed plan: metric query (1) → optional log aggregate (1) → optional trace summary (0–1). Total **≤ 3 calls**, 10-second timeout, window ≤ 60 minutes, `stepInterval` chosen so the series has ≤ 60 points. Time fields are epoch milliseconds; the model cannot author PromQL or SQL — templates are keyed by incident kind.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. A metric item carries ≤ 20 points or ≤ 20 grouped rows; log items are counts only. `truncated: true` when the window, row cap, retention or a failed query drops evidence.

## 6. Framework fit

- Module: `packages/integrations/src/signoz/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `queries.ts`, `context.ts`, tests).
- Source enum: `signoz` is not in `INCIDENT_SOURCES`; extend it in a **contract commit before** the adapter.
- Proposed functions: `verifySignozDelivery` (Basic/shared header + freshness + strict payload), `normalizeSignozIncident` (severity from alert labels/state), `fetchSignozIncidentContext` (fixed query plan).
- Agent tools: **none**. Worker injects context; no model-authored query. A future query tool is `read_only` and audited; channel/rule changes are `sensitive` and out of scope.
- Env names: `SIGNOZ_API_KEY`, `SIGNOZ_API_URL`, `SIGNOZ_WEBHOOK_USER`, `SIGNOZ_WEBHOOK_PASSWORD`.
- Sandbox: server-side reader; sandbox egress denied; API key never in prompt/tool result/error/audit; bounded redacted rows; `tool.execute` only if a tool is added.
- Tests: fake HTTP; wrong Basic credential `401`; stale alert rejected; `429`/timeout mapping; query window and row caps enforced; self-host auth-disabled mode fails closed unless explicitly configured; tenant isolation by API key/workspace.

## 7. Operator setup checklist

1. Choose self-hosted Community Edition or SigNoz Cloud; record `SIGNOZ_API_URL`.
2. Create a read-only API key; verify its role cannot edit rules or channels.
3. Store the key server-side; never in the repository or a fixture.
4. Create a Webhook notification channel with Basic auth; set `SIGNOZ_WEBHOOK_USER` and `SIGNOZ_WEBHOOK_PASSWORD`.
5. Point it at `https://<host>/api/webhooks/signoz`; attach only the in-scope rules.
6. Set the server-side binding (organization, repository, workflow); the payload cannot select a tenant.
7. Confirm retention: Cloud Teams is 15 days for logs/traces; self-host TTL must cover the read window.
8. Add keys **last**, after offline gates pass.

```dotenv
SIGNOZ_API_KEY=
SIGNOZ_API_URL=
SIGNOZ_WEBHOOK_USER=
SIGNOZ_WEBHOOK_PASSWORD=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifySignozDelivery`: correct Basic credential accepted; wrong/missing `401`; stale alert rejected; oversize body `413`.
- [ ] `normalizeSignozIncident`: fingerprint stable; unknown payload fields rejected; severity mapping documented.
- [ ] `fetchSignozIncidentContext`: ≤ 3 calls; window ≤ 60 min; ≤ 20 rows/points; no log body; `truncated` on retention gap.
- [ ] Redaction: API key, Basic password, emails/IPs/service account names removed before truncation.
- [ ] Tenant isolation: key from workspace A cannot query workspace B.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One `query_range` metric query for a named service over ≤ 15 minutes; record rows, bytes and latency.
- [ ] Provider spend is `$0` for self-host; Cloud trial usage is recorded if a Cloud workspace is used.
- [ ] Do not edit a production alert rule.

## 9. Risks / never in model context

- API key, Basic password, webhook URL if it embeds credentials.
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
| S5 | [Logs API overview](https://signoz.io/docs/logs-management/logs-api/overview/) |
| S6 | [SigNoz repository license](https://github.com/SigNoz/signoz/blob/main/LICENSE) |

Verification notes: the pricing page states Community Edition is free with no data caps and that Cloud has **no free tier** (30-day trial, then $49/month). That contradicts the common "SigNoz Cloud free tier" assumption and is recorded here deliberately. Exact API-key roles, log-query paths and retry behavior are **UNVERIFIED**; the v5 query_range body fields are from the official metrics API page.
