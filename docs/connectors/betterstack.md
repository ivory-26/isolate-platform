# Better Stack connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/betterstack/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — free plan across Uptime, Logs and Incidents |
| Auth | Global API token, `Authorization: Bearer <token>` [S5] |
| Inbound | **No HMAC** on uptime webhooks — relay/generic bridge required [S2] |
| Read | Incidents, monitors, optional bounded log query [S3][S4][S6] |
| Writes | None in scope |

Nothing below is implemented. `betterstack` is **not** in `INCIDENT_SOURCES`
(`packages/shared/src/types/incident.ts`). A shared-contract commit must add the
enum value before the adapter. There is no route mode and no verifier.

## 1. Role in the agent

Better Stack answers "is the service down, since when, and what does the check
see". Uptime incidents are lifecycle metadata, not code location; pair them
with GitHub. The Logs product can add a very small, bounded error excerpt, but
it is a second credential and a second query surface.

The trigger is the primary value. Use Better Stack when uptime checks are the
authoritative signal. Do not use it as a log-search proxy: a "query the logs"
tool would defeat the bounded-evidence design.

**Kinds and policy.** `incident` webhooks create a task only when the monitor
transitions to `Started`/down. `Acknowledged` and `Resolved` update an existing
task. A recovery never creates one. Status-page subscription webhooks are
reporting events, not incident triggers, and are ignored.

**Severity mapping.** Better Stack uptime incidents do not carry a rich
severity. Use the monitor's critical flag:

| Signal | `IncidentSeverity` |
|---|---|
| `critical_alert` true and monitor down | `critical` |
| monitor down, no critical flag | `high` |
| degraded / slow response | `medium` |
| resolved | no task |

The exact field name for the critical flag in the v3 payload was not extracted
— **UNVERIFIED**. If it is absent, default every down incident to `high` and
let the operator lower the floor; never guess `critical`.

**Fingerprint.** `betterstack:<monitor-id>:<incident-id>` — both ids are stable
across retries and status transitions. The webhook delivery id is traceability
only.

**Evidence added.** Monitor name and URL host, incident cause, started and
acknowledged timestamps, response status, and optionally one bounded error
group from Logs.

## 2. Free tier and quotas

Better Stack bundles Uptime, Logs and Incidents into one free plan with a
single responder seat.

| Product | Free limit | Notes |
|---|---|---|
| Uptime monitors/heartbeats | 10 | Checks as often as every 30 s [S1] |
| Status pages | 1 | Custom domain and SSO excluded [S1] |
| Incidents / on-call | 1 responder seat | Slack and email alerts; paid responders from about $29-34/mo [S1] |
| Logs (Logtail) | 3 GB/month, retained 3 days | Paid bundles include 30-day retention [S1] |
| Traces | 3 GB/month, retained 3 days | [S1] |
| Error tracking | 100,000 exceptions/month | 5,000 replays/month reported on the pricing page [S1] |
| Metrics | Not confirmed for free | A 30 GB figure appears on the pricing page but its plan attribution was not extracted — **UNVERIFIED** |
| Trial | None needed; the free plan is permanent | Paid plans carry a 60-day money-back guarantee [S1] |

The 3-day log retention is the binding constraint: a Logs excerpt is only
useful for incidents detected within three days. Never cache a log URL or
assume a query can reach last week.

API rate limits are not published on the retrieved pages — **UNVERIFIED**.
Assume a conservative client bucket, honor `429`, and treat a rate-limited
bundle as `truncated` rather than retrying.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Bearer <global API token>` [S5] |
| Token type | Global API token created under API tokens [S5] |
| Base URL | `https://incidents.betterstack.com` for the Uptime/Incidents API [S3][S5] |
| Logs credential | Separate SQL API username/password over Basic auth [S6] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active global token; create the replacement, deploy, verify one read, revoke the old token |

There is no per-resource scope on a global API token: it can read the team's
monitors, incidents and telemetry. Treat it as organization-wide. If the plan
supports multiple teams, use a dedicated team/token for the connector and never
a personal token.

The Logs SQL API does not accept the Bearer token; it uses a connection
username and password per region [S6]. Store them as a second credential and do
not enable log reads until the Uptime path is proven.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature | **No HMAC documented.** Status-page webhooks send `Content-Type`, `User-Agent` and `X-BetterUptime-Event`; no signing header [S2] |
| Uptime alert webhook | Custom destination URL; no signature or shared-secret header documented — **UNVERIFIED** |
| Replay | No signature and no timestamp; dedupe by `(monitor-id, incident-id)` and reject stale `started_at` |
| Retries | Status-page webhooks: 10 attempts with exponential backoff, about 8.5 hours, then disabled [S2]. Uptime alert webhook retries are not documented — **UNVERIFIED** |
| Timeout | 30 seconds [S2] |
| Body cap | 64 KiB platform cap; Better Stack payload size not documented — **UNVERIFIED** |
| Proposed handling | Relay that re-signs to the generic endpoint, or poll `GET /api/v3/incidents` |

Because there is no signature, a direct delivery is a hint, not evidence. The
receiver must re-fetch the incident by id before creating a task. A forged
payload can at most cause a read of real state.

If the webhook can be configured with a custom `Authorization` header, that is
still a shared secret, not a body signature: it proves the sender knows the
header, not that the body is intact. It does not remove the re-fetch
requirement. Whether custom headers are available is **UNVERIFIED**; the
documented status-page webhook exposes none.

Event names in status-page webhooks are exposed through `X-BetterUptime-Event`;
the uptime incident payload carries monitor and incident metadata and the
incident id. Dedupe on the ids, never on the delivery.

## 5. Read-only context

| # | Need | Endpoint | Params and fields |
|---|---|---|---|
| 1 | Incidents | `GET https://incidents.betterstack.com/api/v3/incidents` | `monitor_id`, page params; `cause`, `status`, `started_at`, `acknowledged_at`, `resolved_at` [S4] |
| 2 | Monitors | `GET https://incidents.betterstack.com/api/v2/monitors` | Default 50, max 250 per page; `id`, `type`, `attributes`, `pagination` [S3] |
| 3 | Monitor detail | `GET /api/v2/monitors/{id}` | Check URL host, frequency, status; exact field list **UNVERIFIED** |
| 4 | Logs (optional) | `POST https://<region>-connect.betterstackdata.com` | ClickHouse SQL over Basic auth; hot/cold storage [S6] |

The Logs call is off by default. When enabled it is one query, one source, last
15 minutes, `LIMIT 50`, and the result is reduced to an error-count summary plus
five redacted message lines — never raw rows. The legacy Query API v1
(`GET https://telemetry.betterstack.com/api/v1/query`) is deprecated and was
scheduled for decommissioning in 2024; do not build on it [S7].

Caps: at most 3 API calls plus one optional log query, 10 s timeout, 256 KiB
response cap. The bundle obeys 100 items / 4,000 chars per excerpt / 256 KiB
total; the incident excerpt is capped at 1,500 characters and the log summary
at 2,000.

Pagination: monitors default 50 / max 250; incidents default 10 / max 50
[S3][S4]. Stop at one page. Never walk the incident history; the trigger id is
the only incident that matters.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/betterstack/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | **Must add `betterstack` to `INCIDENT_SOURCES` before the adapter** |
| Contract change required first | Enum value, relay/vendor route mode, and a Better Stack trigger rule |
| Inbound | No native verifier; `normalizeBetterStackIncident(payload)` after a signed relay delivery or poll |
| Reader | `fetchBetterStackIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (server-side only):

| Tool | Risk band | Notes |
|---|---|---|
| `betterstack.fetch_incident_context` | `read_only` | Fixed plan; audited |
| `betterstack.acknowledge_incident` | `sensitive` | Out of scope; approval bound to incident id |

No write tool is proposed. Acknowledging a page is a human action and must not
be automated from a passing test.

**Sandbox implications.** Tools execute in the worker, not the Modal sandbox.
The sandbox keeps egress denied and never sees `BETTERSTACK_API_KEY`,
`BETTERSTACK_WEBHOOK_SECRET` or the Logs SQL password. Results are bounded and
redacted; every call appends `audit_events` with `tool.execute`, risk, outcome
and monitor/incident ids. Never record log lines or response bodies.

**Tests.** Fake fetch only: unsigned delivery rejected by the relay contract;
down vs resolved; severity fallback when the critical flag is absent; 3-day log
window enforced; redaction seeds; `429`; foreign-tenant read `NOT_FOUND`.
A log query test must prove the SQL string is fixed in code and cannot be
influenced by the model.

## 7. Operator setup checklist

1. Confirm the free plan covers the pilot: 10 monitors, 1 responder, 3-day
   logs. If 30-day log retention is required, budget for a paid bundle.
2. Create a global API token under API tokens; record the team and region.
3. Choose the inbound path: relay to the generic endpoint, or polling the v3
   incidents API. Do not configure an unsigned webhook directly.
4. If a relay is used, store its signing secret in
   `BETTERSTACK_WEBHOOK_SECRET`; never log the relay URL.
5. Map each monitor id to one repository binding. Monitor names are not unique.
6. Enable the log query only if an error group is worth the second credential;
   create the SQL API username/password for the region.
7. Rotate the global token and the SQL password separately; a leak of one must
   not require rotating the other.

```dotenv
BETTERSTACK_API_KEY=
BETTERSTACK_BASE_URL=
BETTERSTACK_WEBHOOK_SECRET=
BETTERSTACK_QUERY_BASE_URL=
BETTERSTACK_QUERY_USERNAME=
BETTERSTACK_QUERY_PASSWORD=
```

## 8. Acceptance checklist

Offline, providers disabled:

- [ ] Relay contract rejects unsigned/stale deliveries; a valid signed relay
      delivery normalizes to one signal and re-fetches the incident.
- [ ] `normalizeBetterStackIncident` creates only on a down transition and
      never on `Resolved`.
- [ ] Reader caps at 3 calls / 1 page, redacts, sets `truncated`; the optional
      log query is fixed SQL with `LIMIT 50`.
- [ ] Foreign-tenant read returns `NOT_FOUND`; `429` fails closed.

One bounded live read after explicit authorization: one monitor incident and
one monitor record. No retries. Better Stack is not credit-funded.

## 9. Risks / never in model context

- Monitor URLs can contain tokens, basic-auth userinfo or internal hostnames.
  Store the host only; drop the query and userinfo.
- Raw log rows: request headers, cookies, IPs, user ids, payload bodies.
- Responder PII: names, emails, phone numbers, escalation targets.
- API token, webhook relay secret, SQL username/password.
- Status-page subscriber data and incident update free text.
- The free plan's 3-day retention means missing logs are not evidence of
  absence; never present an empty log query as "no errors".

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Better Stack pricing](https://betterstack.com/pricing) |
| S2 | [Status page webhook subscriptions](https://betterstack.com/docs/uptime/status-pages/subscribing-to-status-updates/subscribing-with-webhooks/) |
| S3 | [List monitors](https://betterstack.com/docs/uptime/api/list-all-existing-monitors/) |
| S4 | [List incidents](https://betterstack.com/docs/uptime/api/list-all-incidents/) |
| S5 | [Uptime API authentication](https://betterstack.com/docs/uptime/api/) |
| S6 | [Logs SQL API / remote connection](https://betterstack.com/docs/logs/query-api/connect-remotely/) |
| S7 | [Query API (legacy v1)](https://betterstack.com/docs/logs/query-api/) |
| S8 | [Incoming webhooks](https://betterstack.com/docs/uptime/incoming-webhooks/) |
