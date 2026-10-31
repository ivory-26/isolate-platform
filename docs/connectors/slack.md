# Slack connector (notify-only)

| Field | Value |
|---|---|
| Status | **Design only — no connector code exists in this repository** |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.6 (P4) |
| Trigger | None: Slack is outbound only |
| Context | None: Slack is never a context source |
| Writes | One notification per incident state transition |

Nothing below is implemented.

## 1. Role in the agent

Slack is a delivery surface for a finished, cited result — never an input. The value of a notification depends on the context bundle already existing, so the message can link to evidence instead of paraphrasing logs. Building this first would encourage dumping logs into a channel, which is exactly the data-egress behavior the platform forbids.

Hard rule: Slack is not an approval channel. Approvals stay in the server-side approval flow (`ARCHITECTURE.md` §8). A button in Slack that approves a deploy would create a second authorization path outside that flow.

## 2. Auth model

| Item | Design |
|---|---|
| Token | Bot token with `xoxb-` prefix [S57] |
| Required scope | `chat:write` [S57] |
| Optional scope | `chat:write.public` for public channels the app has not joined [S57] |
| Forbidden scopes | `channels:history`, `groups:history`, `im:history`, `search:read`, and all user scopes |
| Target channel | Channel **ID** from configuration, per organization/service; never resolved from model output or free text |
| Storage | Server-only, encrypted at rest, `(organization, connector)` keyed |

## 3. Minimal scopes

| Scope | Needed for |
|---|---|
| `chat:write` | `chat.postMessage` to channels the app is a member of [S57] |
| `chat:write.public` | Optional; only if posting to public channels without joining |

No read scopes. Slack is not a context source in this design.

## 4. Inbound webhook

Not applicable for an outbound-only connector.

If a future wave adds inbound Slack interactivity, the verification scheme is: `X-Slack-Signature` with version `v0`, HMAC-SHA256 over `v0:<timestamp>:<rawBody>`, a five-minute replay window, and a constant-time comparison [S58]. That is a different feature with its own approval risk: an inbound action must still pass the platform's approval flow, not act on the Slack request alone.

## 5. Read endpoints for a ContextBundle

None. Slack contributes no context items. The only API call is outbound:

| Need | Endpoint | Notes |
|---|---|---|
| Post a notification | `POST https://slack.com/api/chat.postMessage` with `channel` plus `text` or `blocks` [S59] | Message content is built from redacted metadata and links, never from raw logs |

Planned message content:

- Incident title, redacted and ≤160 characters.
- Severity, service and, if known, the task link.
- One link to the provider incident and up to three citation links.
- No log bodies, no stack traces, no event JSON, no credentials, no PII.
- Every claim links to a cited context item or is omitted; no model speculation presented as fact.

## 6. Rate limits and delivery behavior

| Constraint | Value | Handling |
|---|---|---|
| Per-channel rate | 1 message per second to a specific channel [S59] | Queue per channel; coalesce incident updates |
| Tier limits | 1+/min, 20+/min, 50+/min, 100+/min depending on method [S60] | One message per state transition; no per-log-line posts |
| `429` | Read `Retry-After` and wait [S59, S60] | At most one retry; then mark the notification failed and keep the task result |

Notification failure must never fail the task. A missing Slack message is an observability gap, not a reason to retry a provider write or block a result.

## 7. What must never enter model context or Slack

- Bot token, webhook URL, signing secret.
- Full logs, stack traces, event JSON or incident free text.
- PII: emails, phone numbers, user ids, customer names.
- Tokens embedded in provider URLs.
- Model-generated speculation presented as fact; every claim links to a cited context item or is omitted.

## 8. Data retention notes

- Slack message retention was not researched; it is governed by the workspace's plan and admin settings. The connector must not rely on Slack as a record — the task and its artifacts are the record.
- The platform stores a notification receipt (channel id, message ts, outcome, timestamp) for audit, not the message body.
- No Slack content is stored as context; there is no excerpt TTL to manage for this connector.
- Deleting a task or organization should not be assumed to delete Slack messages; document that limitation for the user.

## 9. Phased implementation checklist

1. **Decide** the workspace, the channel policy (per org/service/severity) and whether on-call is mentioned.
2. **Contract**: a bounded notification payload derived from the task result and the context bundle; channel id comes from configuration, not from the payload.
3. **Client**: one `chat.postMessage` adapter with a 5-second timeout, one retry on `429` after `Retry-After`, fixed error text, token never logged.
4. **Composition**: send once per state transition (`review_ready`, `failed`, `blocked`), after the task result is durable; never inside the webhook request.
5. **Tests**: fake transport; 429 then success; 429 twice gives up; no token or excerpt in the message fixture; channel id cannot be overridden by payload.
6. **Offline gates** twice with providers disabled; no keys.
7. **Live acceptance** only with explicit user authorization: one message to a test channel, no retries, then verify no further sends.
8. **Do not** add an approval action or an inbound Events API in this wave.

## 10. Open questions for the user

1. Which workspace, and one channel per org, per service, or per severity?
2. Should the message mention on-call, or only post a link?
3. Is a short stack trace ever allowed, or only metadata plus links?
4. Who owns the channel and the app installation?
5. Is a notification low-risk enough to send without approval? (Recommended: yes, but audited and rate-limited.)
6. What retention does the workspace enforce, and is that acceptable for incident titles?
7. Should notifications be disabled per organization?

## 11. Sources

All accessed 2026-10-30; copied from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9.

| ID | Source |
|---|---|
| S57 | [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth) |
| S58 | [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack) |
| S59 | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage) |
| S60 | [Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits) |
