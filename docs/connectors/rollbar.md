# Rollbar connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/rollbar/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — free plan, 5,000 occurrences/month |
| Auth | Project read token, `X-Rollbar-Access-Token` [S3] |
| Inbound | **No HMAC**; webhook token travels in the URL — use a relay/generic bridge [S2] |
| Read | Item, bounded occurrences, deploys [S4–S6] |
| Writes | None in scope |

Nothing below is implemented. `rollbar` is **not** in `INCIDENT_SOURCES`
(`packages/shared/src/types/incident.ts` currently lists `github`, `sentry`,
`pagerduty`, `datadog`, `grafana`, `generic`). A shared-contract commit must add
the enum value before any adapter lands. There is also no route mode for
Rollbar.

## 1. Role in the agent

Rollbar answers "which error item is regressing, how often, in which
environment, and what deploy preceded it". It is a code-location source like
Sentry, with a narrower API and a weaker webhook transport.

The reader is the primary value because the inbound webhook is unsigned. Treat
a Rollbar delivery as a hint, re-fetch the item, and only then create a task.
Choose Rollbar when it is already the error tracker; choose Sentry when a
signed trigger and a first-class stack-trace API are required.

**Kinds and policy.** Only `new_item` and `reactivated_item` may create a task.
`occurrence` is a counter update; `resolved_item` and `deploy` are lifecycle
events and never create a task.

**Severity mapping.** Rollbar `level`:

| Rollbar level | `IncidentSeverity` |
|---|---|
| `critical` | `critical` |
| `error` | `high` |
| `warning` | `medium` |
| `info` | `low` |
| `debug` | `info` |

The trigger policy must be source-specific. A production environment plus
`critical` is the proposed acceptance rule; staging and development never
create a task.

**Fingerprint.** `rollbar:<project-id>:<item-id>` — stable across occurrences
and deploys. The occurrence id is traceability only.

**Evidence added.** Item title, level, environment, first/last occurrence,
total count, and a bounded occurrence summary with the top application frames.
No raw occurrence payload.

## 2. Free tier and quotas

| Limit | Free plan | Notes |
|---|---|---|
| Price | $0 | Includes 5K events per month [S1] |
| Occurrences | 5,000 per month | "5K occurrences + 1K sessions" [S1] |
| Replays / sessions | 1,000 per month | Pricing page says "1K sessions"; whether that is session replay was not confirmed — **UNVERIFIED** [S1] |
| Retention | 30 days | [S1] |
| Projects | Unlimited | [S1] |
| Users | Unlimited | [S1] |
| Overage | Processing stops at the limit | Default behavior; no automatic overage charge [S1] |
| Trial | 14 days of Advanced, 200K occurrences | Separate from the free plan [S1] |

The free plan is free forever, not a trial. The 30-day retention means an item
first seen 31 days ago may exist as a summary but its occurrences are gone; do
not assume the occurrence list is complete.

Rate limits are configured per access token and enforced dynamically; the
documentation does not publish a requests-per-minute number for read endpoints
[S7]. Treat `429` as a degraded bundle and do not retry in a loop. Because the
free plan stops ingesting at 5,000 occurrences, a noisy service can silently
lose evidence; the connector must surface `truncated`, never infer "no errors".

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `X-Rollbar-Access-Token: <token>` [S3] |
| Token type | **Project access token** with read scope, scoped to the one project [S3] |
| Account token | Only if several projects must be read; then every call names `project_id` [S3] |
| Capability | `read` covers GET; `write` covers POST/PUT/PATCH/DELETE [S3] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active token; create a replacement project token, deploy, verify one read, revoke the old token |

There is no OAuth scope vocabulary on project tokens: the token is either read
or read/write, and it is bound to one project. Create a read-only token and
never a write token for this connector. An account token widens blast radius to
every project; use it only when a single project token cannot cover the binding.

Do not put the token in a URL. The webhook path is a separate secret (see §4)
and must not be logged or stored as a query string.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature | **None documented.** Rollbar authenticates its webhook by a token embedded in the destination URL [S2] |
| Headers | No signature header; the payload is JSON (or XML) [S2] |
| Replay | No signature and no timestamp; dedupe by fingerprint and reject events older than the configured window |
| Retries | Up to 10 attempts with exponential backoff [S2] |
| Body cap | 64 KiB platform cap; Rollbar payload size is not documented — **UNVERIFIED** |
| Proposed handling | **Do not point Rollbar directly at the receiver.** Use a relay that verifies the URL token out of band and re-signs with `X-Isolate-Signature`, or poll the API |

A token in a URL is a credential in logs, proxies and browser history. The
platform's generic mode expects an HMAC over `${timestamp}.${body}` with
`WEBHOOK_SIGNING_SECRET`; Rollbar cannot produce it. The safe options are:

1. **Relay (preferred).** A small trusted relay receives the Rollbar webhook,
   checks the path token, discards the body's untrusted parts, and sends a
   canonical JSON signal to the generic endpoint with a valid signature.
2. **Poll.** Periodic `GET /api/1/items` for new or reactivated items; no
   inbound path at all, at the cost of detection latency.

Either way, the webhook is a hint: re-fetch `GET /api/1/item/{id}` before task
creation. A forged unsigned delivery can at most cause a read of real state.

Event names in the payload are `new_item`, `occurrence`, `resolved_item`,
`reactivated_item` and `deploy`; the body carries `event_name` and a `data`
object with the item or deploy [S2]. Only `new_item` and `reactivated_item`
are accepted by the normalizer, and only after the re-fetch confirms status.

## 5. Read-only context

Base host: `https://api.rollbar.com`. The plan is fixed in code.

| # | Need | Endpoint | Params and fields |
|---|---|---|---|
| 1 | Item | `GET /api/1/item/{item_id}` | `id`, `project_id`, `status`, `level`, `title`, `environment`, `first_occurrence_timestamp`, `last_occurrence_timestamp`, `total_occurrences`; exact response schema not extracted — **UNVERIFIED** [S8] |
| 2 | Occurrences | `GET /api/1/item/{item_id}/instances` | `page`, `limit` (default 20), `last_id`; returns pages of 20 descending by id [S4] |
| 3 | Deploys | `GET /api/1/deploys` | `project_id`, `page`, `limit`; `environment`, `revision`, `status`, `start_time`, `finish_time`, `comment` [S5] |
| 4 | Project items (poll) | `GET /api/1/items` | Project-scoped list; exact filters not extracted — **UNVERIFIED** |

Never fetch `GET /api/1/instance/{id}` for a full occurrence body in the
default plan: it contains request data, headers, person data and server
locals. If a frame is needed, the occurrence list already carries a bounded
summary; use that.

Caps: at most 3 calls, one page each, 10 s timeout, 256 KiB response cap. The
bundle obeys 100 items / 4,000 characters per excerpt / 256 KiB total. The
occurrence excerpt is capped at 2,000 characters and 10 occurrences; the item
excerpt at 1,500 characters.

Pagination is page-based (`page`, `limit`, default 20). Stop after one page;
occurrence lists can be large and the item cap, not the provider, must bind.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/rollbar/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | **Must add `rollbar` to `INCIDENT_SOURCES` in a shared-contract commit before the adapter** |
| Contract change required first | Enum value, vendor route mode (for the relay path), and a Rollbar trigger rule |
| Inbound | No native verifier. `normalizeRollbarIncident(payload)` runs only after a signed relay delivery or a poll |
| Reader | `fetchRollbarIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (server-side only):

| Tool | Risk band | Notes |
|---|---|---|
| `rollbar.fetch_item_context` | `read_only` | Fixed call plan; audited |
| `rollbar.resolve_item` | `sensitive` | Out of scope; would need approval |

No write tool is proposed for this wave. Resolving an item because a test
passed is never allowed; resolution belongs to the incident owner.

**Sandbox implications.** Tools execute in the worker, not the sandbox. The
sandbox keeps egress denied and never sees `ROLLBAR_API_KEY` or the relay
secret. Results are bounded and redacted; every call appends `audit_events`
with action `tool.execute`, tool, risk, outcome and item id. Never record the
occurrence body, request headers or the token.

**Tests.** Fake fetch only: unsigned delivery rejected by the relay contract;
`new_item` vs `occurrence`; severity table; redaction of seeded emails, IPs and
authorization headers; 20-occurrence page cap; `429`; foreign-tenant read
`NOT_FOUND`.

## 7. Operator setup checklist

1. Confirm Rollbar is the error tracker of record and the free plan's 30-day
   retention is acceptable.
2. Create a **read-only project access token** for the in-scope project.
3. Decide the inbound path: a relay that re-signs to the generic endpoint, or
   polling. Do not configure a direct Rollbar webhook to the platform receiver.
4. If a relay is used, create its URL token out of band and store the relay
   signing secret in `ROLLBAR_WEBHOOK_SECRET`; never log the URL.
5. Map the Rollbar project id to one repository binding. The project name is
   not a stable key.
6. Set the environment and level floor; staging never creates a task.
7. Rotate the project token by creating a second read-only token, deploying,
   verifying one read, then revoking the first.

```dotenv
ROLLBAR_API_KEY=
ROLLBAR_BASE_URL=
ROLLBAR_PROJECT_ID=
ROLLBAR_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline, providers disabled:

- [ ] The relay contract rejects an unsigned or stale delivery; a valid signed
      relay delivery normalizes to one signal.
- [ ] `normalizeRollbarIncident` accepts only `new_item`/`reactivated_item`
      after the canonical re-fetch, and maps levels per §1.
- [ ] Reader caps at 3 calls / 10 occurrences / 2,000 chars, redacts before
      truncation, sets `truncated`.
- [ ] Foreign-tenant read returns `NOT_FOUND`; `429` fails closed.

One bounded live read after explicit authorization: one named item and its
first occurrence page. No retries. Rollbar is not credit-funded.

## 9. Risks / never in model context

- Full occurrence payloads: request headers, cookies, query strings, person
  data, client IP, server locals and arbitrary `extra` fields.
- Source code lines and local variable values that may contain secrets.
- Project and account access tokens; the webhook URL token; relay secret.
- PII in item titles, `person` and `request.user_ip`.
- Deploy `comment` and `local_username` free text; only revision, environment
  and timestamps are allowlisted.
- Item titles are untrusted text and pass the shared redactor and 200-character
  cap before any prompt.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Rollbar pricing](https://rollbar.com/pricing/) |
| S2 | [Webhooks](https://docs.rollbar.com/docs/webhooks) |
| S3 | [Rollbar API authentication](https://docs.rollbar.com/docs/api) |
| S4 | [List all occurrences in an item](https://docs.rollbar.com/reference/get_api-1-item-item-id-instances) |
| S5 | [List all deploys](https://docs.rollbar.com/reference/list-all-deploys) |
| S6 | [Deploy tracking](https://docs.rollbar.com/docs/deploy-tracking) |
| S7 | [Rate limits](https://docs.rollbar.com/docs/rate-limits) |
| S8 | [API getting started](https://docs.rollbar.com/reference/getting-started-1) |
