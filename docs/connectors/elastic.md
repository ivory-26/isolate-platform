# Elastic connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 |
| Auth | Elasticsearch API key (`Authorization: ApiKey …`) [S4] |
| Inbound | Kibana alerting webhook connector; **no HMAC** — headers/basic auth plus re-fetch [S3] |
| Read | Elasticsearch `_search` over allowlisted indices/data streams |
| Writes | None in scope (connector/rule edits are a later wave) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.5 pattern. Elastic is not in the survey. Nothing below is implemented.

## 1. Role in the agent

Elastic is the self-hostable option: Elasticsearch holds logs/events/metrics and Kibana Alerting emits the trigger. It answers "what do the indexed events say around the incident window" with a bounded query over allowlisted indices.

The trigger is the primary value; the reader is aggregate-first. It must not become a general search proxy, must not query arbitrary indices, and must never return raw documents or `_source` maps.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Elastic Cloud trial | **14 days**, no credit card required [S1] | No dollar credit is stated for the standard trial — **UNVERIFIED** |
| Elastic Cloud after trial | Paid; **no free-forever Cloud tier** [S2] | The deployment is restricted until a subscription is added |
| Self-hosted Basic | **Free forever** under the Basic subscription [S2] | Core search, Kibana and alerting; confirm the webhook connector is enabled in the target deployment |
| Trial expiry | At day 14 the deployment is restricted; data handling after expiry is plan-dependent — **UNVERIFIED** | Do not treat a trial as durable storage |
| Storage / shards | Self-hosted: your hardware; Cloud: plan size | The reader never stores data; caps are per query |
| Retention | **No default**; index lifecycle management (ILM) or data-stream policies decide [S6] | The connector must state the index/window it queried |
| Rate limits | No universal request/minute number; cluster capacity and `search` thread pool apply — **UNVERIFIED** | One bounded query per bundle, no scroll |
| Trial / credits | 14-day trial; AWS Marketplace credit offers are separate eligibility programs [S1] | Not a platform credit provider |

Free-forever means **self-hosted Basic**, not Elastic Cloud. Cloud is a 14-day evaluation.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Elasticsearch header | `Authorization: ApiKey <base64(id:api_key)>` [S4] |
| Key type | Elasticsearch API key bound to a role descriptor; restrict to `read` on the allowlisted indices/data streams [S4] |
| Kibana connector auth | None, Basic, SSL certificate, or OAuth 2.0 (9.2+) [S3] |
| Connector headers | Configured headers or secret headers (9.2+); no signing secret [S3] |
| Least privilege | Dedicated API key with `read` + `view_index_metadata` on named indices only; no `manage`, `write` or cluster privileges |
| Lifetime | API keys can have an expiration; set one and rotate before it lapses [S4] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second key with the same role, deploy, verify, invalidate the first |

Never use the `elastic` superuser or a Kibana admin session for the reader. Index patterns are configuration; a payload cannot add an index.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/elastic` |
| Signature header | **None** [S3] |
| Authentication | Connector Basic auth, OAuth 2.0, or configured/secret headers [S3] |
| Signed timestamp | No; alert `@timestamp` is data only |
| Replay control | Reject alerts older than 15 minutes; dedupe by rule id + alert instance id + state |
| Dedupe key | `elastic:<rule-id>:<alert-instance-id>:<state>`; delivery id is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | Kibana action retry policy is not documented on the connector page — **UNVERIFIED** |
| Response | `202` before model work; no payload echo |

The webhook connector sends a JSON body rendered from a Mustache template (`{{rule.name}}`, `{{alert.id}}`, `{{context.*}}`) [S3]. Pin the template, reject unknown fields, and re-fetch the rule/alert state through Kibana or Elasticsearch before creating a task. Headers are authentication, not a signature; for a signed trigger, route through the generic signed bridge (README §3).

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Event aggregate | `POST /{index}/_search` | `size: 0`, `query` (bounded range), `aggs` by status/error kind; no hits | [S5] |
| Small hit sample | `POST /{index}/_search` | `size` ≤ 10, `_source: ["@timestamp","service.name","log.level","error.type"]`; no message body | [S5] |
| Alert/rule state | Kibana alerting API | Exact read path **UNVERIFIED**; prefer the webhook payload plus one aggregate | [S7] |
| Index discovery | `GET /_cat/indices` or `GET /{index}/_mapping` | Names only; validate against the allowlist; no field-capability dump | [S5] |

Fixed plan: one aggregate (1) → optional 10-hit sample (0–1) → optional index metadata (0–1). Total **≤ 3 calls**, 10-second timeout, window ≤ 60 minutes. Queries use a `bool` filter with `range` and `term` clauses built from validated identifiers; the model cannot author DSL.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. Aggregations return ≤ 20 buckets; hits return ≤ 10 documents and ≤ 5 allowlisted fields. `truncated: true` when the window, bucket cap, index allowlist or retention drops evidence.

## 6. Framework fit

- Module: `packages/integrations/src/elastic/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `search.ts`, `context.ts`, tests).
- Source enum: `elastic` is not in `INCIDENT_SOURCES`; extend it in a **contract commit before** the adapter.
- Proposed functions: `verifyElasticDelivery` (shared header/Basic + freshness + strict payload), `normalizeElasticIncident` (severity from rule severity/state), `fetchElasticIncidentContext` (fixed search plan).
- Agent tools: **none**. Worker injects context; no model-authored DSL. A future query tool is `read_only` and audited; rule/connector edits are `sensitive` and out of scope.
- Env names: `ELASTIC_API_URL`, `ELASTIC_API_KEY`, `ELASTIC_INDEX_PATTERN`, `ELASTIC_WEBHOOK_HEADER`, `ELASTIC_WEBHOOK_SECRET`.
- Sandbox: server-side reader; sandbox egress denied; API key never in prompt/tool result/error/audit; bounded redacted aggregates; `tool.execute` only if a tool is added.
- Tests: fake HTTP; wrong header `401`; stale alert rejected; index allowlist enforced before request; `429`/timeout mapping; `size: 0` aggregate path; no `_source` leakage; tenant isolation by index prefix.

## 7. Operator setup checklist

1. Decide self-hosted Basic or Elastic Cloud trial; record `ELASTIC_API_URL` and the index/data-stream pattern.
2. Create a role with `read` + `view_index_metadata` on the allowlisted indices only; create an API key for that role with an expiry.
3. Store the key server-side; never in the repository or a fixture.
4. Create a Kibana webhook connector with a secret header (`ELASTIC_WEBHOOK_HEADER`, `ELASTIC_WEBHOOK_SECRET`) and a pinned Mustache payload.
5. Point it at `https://<host>/api/webhooks/elastic`; attach only the in-scope rules.
6. Set the server-side binding (organization, repository, workflow); the payload cannot select a tenant.
7. Confirm retention: for Cloud trial, plan for data loss at day 14; for self-host, confirm the ILM policy covers the read window.
8. Add keys **last**, after offline gates pass.

```dotenv
ELASTIC_API_URL=
ELASTIC_API_KEY=
ELASTIC_INDEX_PATTERN=
ELASTIC_WEBHOOK_HEADER=
ELASTIC_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifyElasticDelivery`: valid header/Basic accepted; wrong/missing `401`; stale alert rejected; oversize body `413`.
- [ ] `normalizeElasticIncident`: rule + instance fingerprint stable; unknown payload fields rejected.
- [ ] `fetchElasticIncidentContext`: ≤ 3 calls; aggregate `size: 0`; hits ≤ 10 with allowlisted `_source`; index allowlist enforced.
- [ ] Redaction: API key, webhook secret, emails, IPs and `message` bodies removed before truncation.
- [ ] Tenant isolation: index prefix from another organization is refused before the request.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One `_search` aggregate for a named index over ≤ 15 minutes; record hits/buckets and bytes.
- [ ] Provider spend is `$0` for self-host; Cloud trial usage is recorded if a Cloud deployment is used.
- [ ] Do not edit a production rule or connector.

## 9. Risks / never in model context

- API key, connector password, webhook secret, OAuth client secret.
- Raw `_source` documents, `message`/`log.original` bodies, stack traces, request headers.
- PII in indexed fields: email, IP, user id, session id, URL query strings.
- Full index mappings and field-capability dumps (reveal internal schema).
- Alert rule definitions, connector URLs and recipient lists.
- Provider text is untrusted; a document field cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Elastic Cloud trial](https://www.elastic.co/cloud/cloud-trial-overview) |
| S2 | [Elastic subscriptions](https://www.elastic.co/pricing) |
| S3 | [Kibana webhook connector](https://www.elastic.co/docs/reference/kibana/connectors-kibana/webhook-action-type) |
| S4 | [Elasticsearch API keys](https://www.elastic.co/docs/deploy-manage/api-keys/elasticsearch-api-keys) |
| S5 | [Elasticsearch search API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search) |
| S6 | [Index lifecycle management](https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management) |
| S7 | [Kibana alerting](https://www.elastic.co/docs/explore-analyze/alerting/alerts) |

Verification notes: the 14-day trial and "no credit card" are from the official trial page; no standard dollar credit is stated, so the widely repeated "$400 credit" is **UNVERIFIED** and not relied on. The webhook connector documents no HMAC. Elastic Cloud has no free-forever tier; self-hosted Basic is the free path. Retry policy and the Kibana alert read path were not extracted.
