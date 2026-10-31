# UptimeRobot connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** (no module, verifier, reader or tool exists) |
| Free tier verified | 2026-10-31 (UptimeRobot pricing and webhook/API documentation) |
| Auth | UptimeRobot API key (server-side); inbound uses an unsigned webhook plus a bridge secret |
| Inbound | Webhook alert contact (unsigned, no retries) → bridge → our HMAC webhook |
| Read | API v2 `getMonitors` for monitor state, uptime ratios and response times |
| Writes | None in scope (no monitor create/edit/delete, no alert-contact mutation) |

This page follows [`_template.md`](_template.md) and [`README.md`](README.md). Everything below is design; no UptimeRobot code exists in this repository.

## 1. Role in the agent

UptimeRobot is a synthetic uptime monitor. It answers "which external check is down, since when, and what does its recent response-time and uptime history look like". The trigger is the primary value; the read API adds a small, bounded status view. It is not an incident-management system, has no code location, and must not be used as a generic HTTP prober.

The connector is a good fit for services whose symptom is external reachability rather than an internal error. It should not create tasks for SSL-expiry warnings or recoveries; those are notifications, not code incidents.

## 2. Free tier and quotas

| Item | Value | Notes |
|---|---|---|
| Monitors | **50** | Free plan, no credit card [S1] |
| Check interval | **5 minutes** | Detection lag is up to 5 minutes; a faster interval is a paid feature [S1] |
| API access | Included on the free plan | The API itself is not an add-on [S1] |
| API rate limit | **10 requests/minute** on Free | Pro: monitor count × 2 requests/minute, capped at 5,000 [S3] |
| Webhook alert contacts | Available; POST to an operator URL | Payload is customizable with variables [S2] |
| Status pages | Basic status pages included | Exact page/seat counts were not extracted — **UNVERIFIED** [S1] |
| Retention | Monitor logs and response-time history retention is plan-dependent; the free value was not extracted — **UNVERIFIED** | Do not assume long history; request only 1/7/30-day ratios |
| Trial / credits | No trial is required for the free plan; paid plans are a direct upgrade | The free plan is recurring, not a credit [S1] |
| Overage | Exceeding 50 monitors or the 5-minute floor requires a paid plan | No per-check overage on Free |

Cost control: one `getMonitors` call per bundle and one monitor per call. Ten requests per minute is low enough that a retry loop would exhaust it; the reader makes no retries.

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Credential | API key, sent as `api_key` in the POST body of API v2 calls [S4] |
| Key scope | Use a dedicated key for this connector. Whether a read-only key type exists was not confirmed — **UNVERIFIED**; if only the main key is available, treat it as write-capable and never expose it to a tool |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Generate a new key, deploy, verify one read, then revoke the old key; one active key |
| Inbound secret | A separate 32+ character bridge secret (path or static header); never the API key |

The API key can create and edit monitors if it is the main key. The reader must therefore be a server-side function with a fixed `getMonitors` call, not a generic "call UptimeRobot" tool, and the key must never enter the sandbox, a prompt, a URL or an error message.

## 4. Inbound trigger

UptimeRobot webhooks are unsigned and are not retried.

| Property | Value |
|---|---|
| Method / content | HTTP POST; JSON or form-encoded [S2] |
| Payload | Customizable template. Known fields include `monitorID`, `monitorURL`, `alertType` (1 down, 2 up, 3 SSL expiry), `alertTypeFriendlyName`, `monitorFriendlyName`, `alertDetails`, `alertDuration`, `customFields`, `dashboardUrl`, `monitorTags`; the full set is version-dependent — **UNVERIFIED** [S2] |
| Signature | **None.** No HMAC, certificate or signed timestamp is offered [S2] |
| Custom headers | Supported (for example a static `Authorization` header), but a static header is a shared secret, not a signature and not replay-protected [S2] |
| Retries | **None.** "If the request fails... it is not retried" [S2] |
| Bridge requirement | High-entropy path plus optional static header; then **re-fetch the monitor** with `getMonitors` before task creation; then sign with our generic HMAC |
| Receiver | `POST /api/webhooks/uptimerobot` with `X-Isolate-Timestamp` and `X-Isolate-Signature` over `${timestamp}.${body}` |
| Body cap | 64 KiB at the bridge and receiver |
| Trigger filter | Only `alertType == 1` (down) creates a task. `2` (up) and `3` (SSL expiry) are ignored |
| Dedupe | Fingerprint `uptimerobot:<monitorID>:down`, 30-minute bucket; the payload has no delivery ID |
| Severity | `high` for an allowlisted production monitor; `medium` otherwise and dropped before submission. UptimeRobot has no severity field |

Because there are no retries, a bridge outage loses the alert. Mitigate with a small reconciliation poll (for example every 5 minutes, one `getMonitors` call) that compares monitor status against recent tasks; this poll is operator tooling, not part of the inbound path. Do not auto-create tasks from every poll: the 30-minute fingerprint and the platform's two-task cap still apply.

## 5. Read-only context

| Need | Endpoint | Parameters and bounds | Source |
|---|---|---|---|
| Monitor state | `POST https://api.uptimerobot.com/v2/getMonitors` | `api_key`, `format=json`, `monitors=<id>`, `custom_uptime_ratios=1-7-30`, `response_times=1`, `response_times_average=60`; body form-encoded | [S4] |
| Monitor inventory | Same endpoint | Used only by operator tooling with `limit`/`offset`; not part of a bundle | [S4] |
| Alert history | Not fetched | Logs and events are not needed to fix code; retention is plan-dependent | — |

`getMonitors` returns monitor objects with `id`, `friendly_name`, `url`, `type`, `status`, `create_datetime`, `custom_uptime_ratio`, `average_response_time`, and response-time series when requested. Field and parameter names follow the API v2 reference; the exact parameter set was not re-extracted in this pass — **UNVERIFIED**. Pagination uses `offset`/`limit`; exact defaults and maximum were not extracted — **UNVERIFIED**. The reader requests one monitor and one page.

Caps: at most 2 provider calls per bundle; 100 items (shared contract); 1 monitor; 30 uptime ratios (1/7/30 days); 60 response-time points; one context item of at most 1,500 characters; 4,000 characters per item and 256 KiB total remain the shared limits. Never request `logs=1`, `alert_contacts=1`, `psp=1`, or `ssl_expiry` details; monitor names and URLs can contain customer identifiers, and the logs payload is free text.

## 6. Framework fit

| Item | Design |
|---|---|
| Module | `packages/integrations/src/uptimerobot/` (design only) |
| Source enum | Add `uptimerobot` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a **contract commit before any adapter** |
| Transport | `verifyUptimeRobotBridgeSecret` and `normalizeUptimeRobotAlert` in the operator bridge; `signGenericDelivery` for our HMAC |
| Reader | `fetchUptimeRobotIncidentContext(deps, input)` with injected fetch and clock |
| Tools | `uptimerobot.get_monitor` (`read_only`) only; no list-all tool |
| Risk bands | `read_only`; the API key may be write-capable, so the tool surface must not expose create/edit/delete |
| Env | `UPTIMEROBOT_API_KEY`, `UPTIMEROBOT_MONITOR_ALLOWLIST`, `UPTIMEROBOT_WEBHOOK_TOKEN`, `WEBHOOK_SIGNING_SECRET` |
| Audit | One row per read with org, task, monitor ID, item count, duration and outcome; never the API key or the full monitor object |

Sandbox implications: the reader runs in the worker, not in the sandbox; egress deny stays on and no API key reaches the sandbox. The model supplies no monitor ID; trusted code maps the incident fingerprint to the allowlisted monitor. Results are redacted and truncated before the prompt.

Tests (fakes only): wrong bridge secret rejected; `alertType 2`/`3` create nothing; missing monitor in the allowlist is `NOT_FOUND`; the reader enforces 2 calls and 60 points; a 429 (10/min) degrades to `truncated: true` with no retry; no API key in an error; cross-org monitor read is `NOT_FOUND`.

## 7. Operator setup checklist

1. Create a dedicated API key for this connector. If a read-only key type is available in the account, use it; otherwise record that the key is write-capable.
2. Add a webhook alert contact with a high-entropy URL path and an optional static `Authorization` header. Set the payload to the smallest useful template (monitor ID, name, URL, alert type, duration).
3. Attach the contact only to the monitors in `UPTIMEROBOT_MONITOR_ALLOWLIST`, and confirm the Free plan's 5-minute interval is acceptable.
4. Deploy the bridge with the 64 KiB cap, secret check, re-fetch, HMAC signing and 5-minute reconciliation poll.
5. Confirm offline gates with no UptimeRobot key, then fire one test down alert (or pause/unpause a test monitor) and verify one task and one dedupe no-op.
6. Add the key last. This page does not authorize a live call.

```dotenv
UPTIMEROBOT_API_KEY=
UPTIMEROBOT_MONITOR_ALLOWLIST=
UPTIMEROBOT_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

Names only; values are server-side and never committed, logged or placed in a fixture.

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] Bridge: missing/wrong secret rejected with no echo; oversized body `413`; replay within 30 minutes creates nothing.
- [ ] Normalizer: only `alertType 1`; severity high only for allowlisted production monitors; fingerprint is stable across duplicate webhooks.
- [ ] Reader fakes: 2-call and 60-point caps; 429 and timeout set `truncated`; no `logs=1` request is constructed.
- [ ] Redaction seeds for monitor URLs with query tokens, emails, IPv4 and API keys.
- [ ] Intake: monitor outside the allowlist is `NOT_FOUND`; third active incident is throttled.
- [ ] `bun run validate` twice with providers disabled.

Live (separate explicit authorization; one bounded read, no retries):

- [ ] One `getMonitors` call for one allowlisted monitor with `custom_uptime_ratios=1-7-30` and 60 response-time points; record the request count against 10/min.
- [ ] One signed test delivery through the bridge; verify exactly one task and no second task on replay.
- [ ] Stop at the first cap; no retry after success; no spend to record beyond the free plan.

## 9. Risks and what must never enter model context

- The webhook is unsigned and unretried; anyone with the URL can forge a down alert, and a transient bridge failure silently loses one. The static header is a weak shared secret, not replay protection.
- Monitor names and URLs are operator-authored and can contain customer names, internal hostnames or tokens in the query string. Redact URLs to origin plus path, drop query strings.
- The main API key can create, edit and delete monitors. Treat it as a write credential even though this connector only reads.
- Five-minute checks produce slow detection; do not present a recovery or an SSL warning as a code incident.
- Never in context: API key, bridge secret, full monitor object, alert-contact emails, logs, response headers, query strings with tokens, customer identifiers.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [UptimeRobot plans and pricing](https://uptimerobot.com/pricing/) |
| S2 | [UptimeRobot webhook integration](https://help.uptimerobot.com/en/articles/14498593-webhook-integration) |
| S3 | [UptimeRobot API documentation (legacy, rate limits)](https://uptimerobot.com/api/legacy/) |
| S4 | [UptimeRobot API v2](https://uptimerobot.com/api/) |
