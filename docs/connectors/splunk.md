# Splunk connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Free tier verified | 2026-10-31 (partial — see §10) |
| Auth | Search API bearer/session key; HEC token for ingest only [S6][S7] |
| Inbound | Alert webhook action; **no HMAC** — generic signed bridge or re-fetch [S4] |
| Read | Search API jobs and results over allowlisted indexes |
| Writes | None in scope (HEC ingest, alert edits are out of scope) |

Design reference: [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.5 pattern. Splunk is not in the survey. Nothing below is implemented.

## 1. Role in the agent

Splunk is the enterprise search tier: it answers "what do the indexed events say around the incident" with SPL over allowlisted indexes. It is also the most expensive and most locked-down option here.

The trigger is the primary value; the reader is aggregate-first (`stats count by ...`) and bounded to one job. It must not be used as a general search console, must not run model-authored SPL, and must never return raw events beyond a tiny allowlisted sample. HEC is an **ingest** path and is never used by the reader.

## 2. Free tier and quotas

| Item | Verified value | Notes |
|---|---|---|
| Splunk Free license | **500 MB/day**, does not expire [S2] | Indexing stops/warns above the daily volume |
| Splunk Free alerting | **Alerting and scheduled searches are reportedly unavailable** on the Free license [S1] | **UNVERIFIED** against a fetchable primary page (Splunk docs returned 403); a Free instance therefore cannot emit the alert webhook this connector needs |
| Splunk Free auth | No user/role management; single-user mode | **UNVERIFIED**; not suitable for a service integration |
| Splunk Enterprise trial | **60 days** [S4] | Full trial license, then reverts to Free unless licensed |
| Splunk Cloud trial | **14 days** [S3] | No credit card stated; after trial the stack is decommissioned or converted |
| Cloud ingest | Plan-based; no free-forever Cloud tier | Exact trial ingest allowance **UNVERIFIED** |
| Search limits | Plan/cluster dependent; no universal request/minute number — **UNVERIFIED** | One job per bundle, `max_count` and time range bounded |
| Retention | Index retention policy (`frozenTimePeriodInSecs`), not a global default | Set per index; the connector states the window it queried |
| Trial / credits | 14/60-day trials; no credit-funded model | Not a platform credit provider |

The important contradiction: **500 MB/day free does not include alerting**, so a Free license cannot trigger a task. The trigger path requires an Enterprise trial or a paid Cloud/Enterprise license. Treat Free as read-only at best, and verify REST authentication on that instance before relying on it.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Search API | `Authorization: Bearer <JWT>` or `Authorization: Splunk <session key>` [S6] |
| HEC | `Authorization: Splunk <HEC token>` on `POST https://<host>:8088/services/collector/event` [S5] — ingest only |
| Reader identity | Dedicated user with a role granting `search` and read access to named indexes; no `admin`, no `edit_*` capabilities |
| HEC token | Separate token, separate use; never the reader credential |
| Lifetime | Tokens/session keys are revocable; JWT expiry is deployment-defined — set one |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second reader token/user, deploy, verify, revoke the first; rotate HEC separately |

Do not use an admin account or a global HEC token. Index names are validated against an allowlist (`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$`); the payload cannot add an index or a search command.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Endpoint | `POST https://<host>/api/webhooks/splunk` |
| Signature header | **None** [S4] |
| Authentication | Webhook action URL only; no documented custom headers or HMAC [S4] |
| Payload | Fixed JSON: `sid`, `search_name`, `app`, `owner`, `results_link`, `result` [S4] |
| Signed timestamp | No; `result._time` is data only |
| Replay control | Reject results older than 15 minutes; dedupe by `search_name` + result key + state; `sid` is traceability only |
| Dedupe key | `splunk:<search-name>:<index>:<result-key>:<state>`; `sid` is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | Not documented on the webhook action page — **UNVERIFIED** |
| Response | `202` before model work; no payload echo |

Splunk's webhook action cannot sign the body and does not document custom headers. A shared secret in the URL is a credential in a URL and is therefore unacceptable. Use the **generic signed bridge**: a small internal relay receives the Splunk webhook, verifies source network/allowlist, and re-signs the normalized signal with `X-Isolate-Signature` before the platform receiver. Treat the body as a hint and re-fetch the search result through the Search API before creating a task.

`results_link` is often `http://`, points at the Splunk web, and may carry a session-bearing query string. Validate it as display-only: https only, no userinfo, ≤ 512 characters, or drop it.

## 5. Read-only context

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| Run a bounded search | `POST /services/search/jobs` | Form body: a `search` command ending in a `stats` aggregation, plus `output_mode=json`, `exec_mode=oneshot`, `earliest_time`/`latest_time` | [S7] |
| Create an async job | `POST /services/search/jobs` | Returns `sid`; then poll `GET /services/search/jobs/{sid}` | [S7] |
| Fetch results | `GET /services/search/jobs/{sid}/results` | `output_mode=json`, `count` ≤ 100, `offset` 0 only | [S7] |
| Job status | `GET /services/search/jobs/{sid}` | `isDone`, `dispatchState`, `doneProgress` | [S7] |
| Alert search text | Webhook payload `search_name` only | Do not fetch the saved search definition (may embed credentials) | [S4] |

Fixed plan: one `oneshot` search (1) with `| stats count by status, error_kind` and a ≤ 60-minute window; at most one follow-up result fetch if `oneshot` is unavailable. Total **≤ 2 calls**, 10-second HTTP timeout, job timeout ≤ 20 seconds, `count` ≤ 100. SPL is a template with the index, service and window substituted after validation; the model cannot add a command.

Caps: at most **8 items** from this source, **4,000 characters** per excerpt, **256 KiB** total. Results are ≤ 20 grouped rows; raw `_raw` events are excluded by the `stats` template. `truncated: true` when the job times out, the index is not allowlisted or retention excludes the window.

## 6. Framework fit

- Module: `packages/integrations/src/splunk/` (`auth.ts`, `webhook.ts`, `incidents.ts`, `search.ts`, `context.ts`, tests).
- Source enum: `splunk` is not in `INCIDENT_SOURCES`; extend it in a **contract commit before** the adapter.
- Proposed functions: `verifySplunkDelivery` (bridge signature or shared header + freshness + strict payload), `normalizeSplunkIncident` (severity from a configured `search_name` mapping), `fetchSplunkIncidentContext` (fixed SPL plan).
- Agent tools: **none**. Worker injects context; no model-authored SPL. A future query tool is `read_only` and audited; saved-search or HEC changes are `sensitive` and out of scope.
- Env names: `SPLUNK_API_URL`, `SPLUNK_API_TOKEN`, `SPLUNK_INDEX`, `SPLUNK_BRIDGE_SECRET`.
- Sandbox: server-side reader; sandbox egress denied; token never in prompt/tool result/error/audit; bounded redacted aggregates; `tool.execute` only if a tool is added.
- Tests: fake HTTP; unsigned direct delivery rejected; bridge signature verified; stale result rejected; SPL template immutable; index allowlist; `429`/timeout mapping; tenant isolation by index prefix.

## 7. Operator setup checklist

1. Confirm the license: **Free cannot alert**. Use an Enterprise trial or paid Cloud/Enterprise for the trigger; Free is read-only at best.
2. Choose the search host and index; record `SPLUNK_API_URL` and `SPLUNK_INDEX`.
3. Create a dedicated reader user/role with `search` on that index only; issue a JWT or session key.
4. Store it server-side; never in the repository or a fixture.
5. Deploy the signing bridge; configure the alert action URL to the bridge and `SPLUNK_BRIDGE_SECRET` on both sides.
6. Attach the action only to the in-scope saved searches; map `search_name` to severity in server config.
7. Confirm index retention covers the read window; record the policy.
8. Add keys **last**, after offline gates pass.

```dotenv
SPLUNK_API_URL=
SPLUNK_API_TOKEN=
SPLUNK_INDEX=
SPLUNK_BRIDGE_SECRET=
```

## 8. Acceptance checklist

Offline (`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`):

- [ ] `verifySplunkDelivery`: bridge signature accepted; direct unsigned delivery rejected; stale result rejected; oversize body `413`.
- [ ] `normalizeSplunkIncident`: `search_name`→severity mapping; fingerprint stable; unknown payload fields rejected.
- [ ] `fetchSplunkIncidentContext`: one `stats` search; no `_raw`; ≤ 20 rows; job timeout enforced; `truncated` on timeout/retention.
- [ ] `results_link` validation: https only, ≤ 512 chars, no userinfo; otherwise dropped.
- [ ] Tenant isolation: index prefix from another organization refused before the request.
- [ ] `biome check`, `tsc --noEmit`, `bun test` twice, providers disabled.

Live (explicit authorization, one bounded call, no retries):

- [ ] One `oneshot` `stats` search for a named index over ≤ 15 minutes; record rows, bytes and job duration.
- [ ] Provider spend is `$0`; Splunk is not credit-funded.
- [ ] Do not modify a saved search or alert action.

## 9. Risks / never in model context

- Search token/session key, HEC token, bridge secret.
- Raw `_raw` events, `result` maps, `results_link` query strings that may carry a session.
- PII in indexed fields: email, IP, user id, hostnames, URL query strings.
- Saved-search definitions and alert action configuration (may embed credentials).
- Index names and sourcetypes outside the allowlist.
- Provider text is untrusted; a search result cannot change task limits, ownership or tools.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [About Splunk Free](https://help.splunk.com/en/data-management/splunk-enterprise-admin-manual/10.4/configure-splunk-licenses/about-splunk-free) |
| S2 | [Types of Splunk Enterprise licenses](https://help.splunk.com/en/data-management/splunk-enterprise-admin-manual/9.2/configure-splunk-licenses/types-of-splunk-enterprise-licenses) |
| S3 | [Splunk Cloud Platform free trial](https://www.splunk.com/en_us/download/splunk-cloud.html) |
| S4 | [Use a webhook alert action](https://help.splunk.com/en/splunk-enterprise/alert-and-respond/alerting-manual/9.4/configure-alert-actions/use-a-webhook-alert-action) |
| S5 | [Format events for HTTP Event Collector](https://help.splunk.com/?resourceId=SplunkCloud_Data_FormateventsforHTTPEventCollector) |
| S6 | [Splunk REST API authentication](https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTauthentication) |
| S7 | [Search API](https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTsearch) |

Verification notes: Splunk's documentation host returned **403** to automated fetches; the 500 MB/day and trial durations are from official search-index excerpts, and the "Free cannot alert/schedule" limitation is corroborated by Splunk community documentation but is marked **UNVERIFIED** against a fetchable primary page. Webhook payload field names are from official excerpts. No HMAC, custom headers or retry policy is documented for the webhook action.
