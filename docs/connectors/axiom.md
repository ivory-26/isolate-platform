# Axiom connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | `Authorization: Bearer <API token>` [S3][S5] |
| Inbound | Custom webhook notifier; **no HMAC** — optional headers plus re-fetch [S4] |
| Read | APL query API, datasets API |
| Writes | None in scope (monitor/notifier changes are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §5.4. Axiom is not in the survey. Nothing below is implemented.

## 1. Role in the agent

Axiom is a log/event store with APL (Axiom Processing Language), a Kusto-like query language. It answers "which event pattern changed and how often" for a service that is already suspected, and it is useful when the org centralises application logs there.

The trigger is the primary value; the reader returns bounded APL aggregates (counts by status, route or error kind), never raw rows. The model never authors APL.

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
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second query-only token, deploy, verify, delete the first |

Do not use an organization-wide admin token. The dataset name is validated `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and must match the configured allowlist; a token scoped to a dataset is the second layer.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/axiom` |
| Signature header | **None documented** [S4] |
| Authentication | URL plus optional custom headers in the notifier [S4] |
| Payload template | Go template with fields such as `.Action` and `.Value` [S4] |
| Signed timestamp | No; monitor timestamps are data only |
| Replay control | Reject alerts older than 15 minutes; dedupe by monitor id + group + state |
| Dedupe key | `axiom:<monitor-id>:<group-key>:<state>`; delivery id is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | Not documented on the notifier page — **UNVERIFIED** |
| Response | `202` before model work; no payload echo |

A custom header is a shared secret, not a signature. Verify it, then re-fetch the monitor/alert state through the API before creating a task. Pin the notifier's Go template so the JSON shape is stable; reject unknown fields. For a signed trigger, route the notifier through the generic signed bridge (README §3).

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| APL query | `POST /v1/query/_apl?format=tabular` | Body `{apl, startTime, endTime}`; bounded `summarize`/`where` query | [S3] |
| Dataset query | `POST /v1/datasets/{dataset}/query` | Dataset-scoped variant; exact body **UNVERIFIED** | [S3] |
| Datasets | `GET /v1/datasets` | Names and ids only; validate against the allowlist | [S6] |
| Monitor state | Monitor API | Exact read path **UNVERIFIED**; use the webhook payload plus one query | [S4] |

Fixed plan: dataset validation (1) → APL aggregate (1) → optional second aggregate (0–1). Total **≤ 3 calls**, 10-second timeout, window ≤ 60 minutes, result ≤ 100 rows. APL templates are keyed by incident kind and select only `service`, `environment`, `status`, `error.kind` and a count/summary; no `project` of raw fields.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. A query item is a small table or ≤ 20 time buckets; raw log lines and full event maps are never returned. `truncated: true` when the window, row cap, query-compute budget or a failed query drops evidence.

## 6. Framework fit

- Module: `packages/integrations/src/axiom/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `apl.ts`, `context.ts`, tests).
- Source enum: `axiom` is not in `INCIDENT_SOURCES`; extend it in a **contract commit before** the adapter.
- Proposed functions: `verifyAxiomDelivery` (shared header + freshness + strict payload), `normalizeAxiomIncident` (severity from monitor action/state), `fetchAxiomIncidentContext` (fixed APL plan).
- Agent tools: **none**. Worker injects context; no model-authored APL. A future query tool is `read_only` and audited; monitor/notifier edits are `sensitive` and out of scope.
- Env names: `AXIOM_API_TOKEN`, `AXIOM_API_URL`, `AXIOM_DATASET`, `AXIOM_WEBHOOK_HEADER`, `AXIOM_WEBHOOK_SECRET`.
- Sandbox: server-side reader; sandbox egress denied; token never in prompt/tool result/error/audit; bounded redacted tables; `tool.execute` only if a tool is added.
- Tests: fake HTTP; wrong header `401`; stale alert rejected; `429`/timeout mapping; APL template cannot be influenced by payload text; dataset allowlist enforced; token from org A cannot query org B.

## 7. Operator setup checklist

1. Choose the dataset and region/API host; record `AXIOM_API_URL` and `AXIOM_DATASET`.
2. Create an Advanced token limited to query on that dataset; verify it cannot ingest or manage.
3. Store it server-side; never in the repository or a fixture.
4. Create a custom webhook notifier with a random header (`AXIOM_WEBHOOK_HEADER`, `AXIOM_WEBHOOK_SECRET`) and a pinned Go template.
5. Point it at `https://<host>/api/webhooks/axiom`; attach only the in-scope monitors.
6. Set the server-side binding (organization, repository, workflow); the payload cannot select a tenant.
7. Confirm the free plan's 30-day retention and 10 GB-hour query budget are sufficient; otherwise reduce the window or upgrade.
8. Add keys **last**, after offline gates pass.

```dotenv
AXIOM_API_TOKEN=
AXIOM_API_URL=
AXIOM_DATASET=
AXIOM_WEBHOOK_HEADER=
AXIOM_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifyAxiomDelivery`: valid header accepted; wrong/missing `401`; stale alert rejected; oversize body `413`.
- [ ] `normalizeAxiomIncident`: monitor id + group fingerprint stable; unknown payload fields rejected.
- [ ] `fetchAxiomIncidentContext`: ≤ 3 calls; APL has no `project *`; rows ≤ 100; `truncated` on query budget/retention.
- [ ] Redaction: token, webhook secret, emails, IPs and URL query strings removed before truncation.
- [ ] Dataset allowlist rejects an unknown dataset before any request.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One APL aggregate for a named dataset over ≤ 15 minutes; record rows, bytes and query-compute estimate.
- [ ] Provider spend is `$0`; Axiom is not credit-funded.
- [ ] Do not edit a production monitor or notifier.

## 9. Risks / never in model context

- API token, webhook shared secret, ingest token.
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
