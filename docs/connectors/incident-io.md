# incident.io connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/incident-io/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — Basic is free forever, **but excludes API and webhooks** |
| Auth | API key, `Authorization: Bearer <key>` [S5] |
| Inbound | Signed outgoing webhook (Svix scheme) on paid plans [S2][S3] |
| Read | Incident by id/list, severity, status, timestamps [S5] |
| Writes | None in scope |

Nothing below is implemented. `incident_io` is **not** in `INCIDENT_SOURCES`
(`packages/shared/src/types/incident.ts`); a shared-contract commit must add it
before an adapter. There is no route mode and no verifier.

## 1. Role in the agent

incident.io is a Slack-native incident record: it answers "what is declared,
at what severity, by whom, and what is the current lifecycle state". It does
not localize a defect. Pair it with GitHub for code and Sentry for stack
traces.

The trigger and the reader are both useful, but only on a paid plan. The free
Basic plan has no API and no webhooks, so the connector cannot function at $0
(§2). Treat incident.io as a paid connector whose value is a clean incident
record and a signed, well-specified webhook.

**Kinds and policy.** A signed `incident.created` (or the equivalent alert
webhook) creates a task. `incident.updated`, `incident.status_updated` and
`incident.severity_updated` update an existing task. Post-incident workflows,
action items and follow-ups are not triggers.

**Severity mapping.** incident.io severities are custom per organization, with
a numeric `rank` (1 is most severe).

| Severity | `IncidentSeverity` |
|---|---|
| rank 1 / name containing "critical" or "P1" | `critical` |
| rank 2 / "major" or "P2" | `high` |
| rank 3 / "minor" or "P3" | `medium` |
| rank 4+ / "cosmetic" | `low` |
| no severity | `medium` |

The mapping must be configuration, not a name match: ranks are stable, names
are not. The exact severity object shape in the public API was not extracted —
**UNVERIFIED**.

**Fingerprint.** `incident_io:<incident-id>` — stable across updates. The
webhook message id and Svix id are traceability only.

**Evidence added.** Incident name, summary, severity, status, type, created and
updated timestamps, and the canonical incident URL. No Slack messages.

## 2. Free tier and quotas

The Basic plan is genuinely free forever, but it is incident response, not an
integration platform.

| Limit | Basic (free) | Notes |
|---|---|---|
| Price | $0 | "Free. Forever." [S1] |
| Users | Not stated | No free-plan user cap published [S1] |
| Schedules | 1 | Single-team on-call [S1] |
| Integrations | 2 | [S1] |
| Status pages | 1 public page | [S1] |
| API access | **Not included** | Explicitly excluded from Basic [S1] |
| Outgoing webhooks | **Not included** | Explicitly excluded from Basic [S1] |
| SSO | Not included | [S1] |
| Paid plans | Team $19/user/mo; Pro $25/user/mo | Per-user monthly list prices [S1] |
| Trial | Not applicable to Basic | Paid plans are the evaluation path — exact trial length **UNVERIFIED** |

**Finding:** a zero-cost incident.io connector is not possible. Without API
access there is no read path; without webhooks there is no signed trigger. An
alert source may still create incidents on Basic, but the agent could not fetch
the incident or its context. Do not design a free-tier deployment; budget for
Team or Pro.

Rate limits (paid): 1,200 requests/minute by default, and 60 requests/minute
for the list-incidents endpoint [S5]. A bundle is a handful of calls, so the
list limit is the one that matters for polling. Prefer a webhook trigger and a
single get-by-id read.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Bearer <API_KEY>` [S5] |
| Key creation | `app.incident.io/~/settings/api-keys` [S5] |
| Key scope | Organization-wide; no per-resource read scope documented — **UNVERIFIED** |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active key; create the replacement, deploy, verify one read, revoke the old key |

The public docs describe an API key, not an OAuth scope list. There is no
documented read-only variant; treat the key as powerful and keep it server-side.
Do not reuse the webhook signing secret as the API key. A write key, if one
exists separately, is out of scope.

Webhook signing uses a per-endpoint signing secret shown once at creation
[S2]. Store it as `INCIDENT_IO_WEBHOOK_SECRET`, separate from the API key.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature headers | `webhook-id`, `webhook-timestamp`, `webhook-signature` [S2][S3] |
| Algorithm and signed string | HMAC over `$WEBHOOK_ID.$WEBHOOK_TIMESTAMP.$REQUEST_BODY`; signature prefixed `v1,` [S3] |
| Encoding | Svix-compatible; base64 is the Svix convention, but the incident.io page does not state it — **UNVERIFIED** |
| Signed timestamp | Yes, `webhook-timestamp` |
| Replay window | Not stated by incident.io; Svix libraries default to 5 minutes — enforce ±300 s locally [S3] |
| Retries | Exponential backoff over 24 hours; endpoint disabled after 5 days of failure [S3] |
| Dedupe key | Source fingerprint; `webhook-id` is traceability only |
| Body cap | 64 KiB platform cap; vendor payload limit not documented — **UNVERIFIED** |

The Svix scheme is well specified and testable offline. Because the timestamp
is signed as part of the string, a captured delivery cannot be replayed after
the window. Verify over raw bytes, compare in constant time, accept the `v1,`
prefix only, and reject an unknown version.

The webhook endpoint is configured in Settings > Webhooks on a paid plan; the
free Basic plan cannot create one [S1]. Accepted payloads are incident
lifecycle events; the exact event type names and field schema were not
extracted — **UNVERIFIED**. Parse strictly against an allowlist and reject
unknown event types with `202 {accepted:false}`.

For alert sources (custom HTTP), the payload is defined by a synchronous
JavaScript transform (ES2023) with `source_payload` as root; required fields
include `title`, `status`, `source_url` and `metadata`, and deduplication uses a
separate key path [S4]. Authentication for that inbound URL is not documented
on the page — **UNVERIFIED**. Do not configure an alert source directly until
the auth scheme is confirmed; a signed incident webhook is the safer trigger.

## 5. Read-only context

Base host: `https://api.incident.io`. The plan is fixed in code.

| # | Need | Endpoint | Params and notes |
|---|---|---|---|
| 1 | Incident | `GET /v1/incidents/{id}` | Name, summary, severity, status, incident type, timestamps, URL; exact field names **UNVERIFIED** [S5] |
| 2 | Incident list (poll) | `GET /v1/incidents` | `page_size`, `after`, status filters; 60 requests/minute [S5] |
| 3 | Severity catalogue | Not extracted | Needed only if rank mapping is not in the incident object — **UNVERIFIED** |
| 4 | Incident updates | Not extracted | Do not fetch Slack messages or timelines in this wave — **UNVERIFIED** |

Caps: at most 2 calls, one page, 10 s timeout, 256 KiB response cap. The bundle
obeys 100 items / 4,000 characters per excerpt / 256 KiB total. The incident
excerpt is capped at 2,000 characters and includes only allowlisted fields.

Pagination uses an `after` cursor [S5]. Stop after one page and never walk the
incident history. A `429` fails the bundle with a bounded error; the list
endpoint's 60/minute limit is low enough that polling must be at least a minute
apart.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/incident-io/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | **Must add `incident_io` to `INCIDENT_SOURCES` before the adapter** |
| Contract change required first | Enum value, vendor route mode, and an incident.io trigger rule |
| Inbound | `verifyIncidentIoWebhook(rawBody, headers, secret)` implementing the Svix scheme |
| Normalize | `normalizeIncidentIoIncident(payload)` → strict `IncidentSignal` |
| Reader | `fetchIncidentIoIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (server-side only):

| Tool | Risk band | Notes |
|---|---|---|
| `incident_io.fetch_incident_context` | `read_only` | Fixed plan; audited |
| `incident_io.update_incident_status` | `sensitive` | Out of scope; approval bound to `{incidentId, status}` |

No write tool is proposed for this wave. Status changes are responder actions
and must not be automated from a passing validation.

**Sandbox implications.** Tools execute in the worker, not the Modal sandbox.
The sandbox keeps egress denied and never sees `INCIDENT_IO_API_KEY` or
`INCIDENT_IO_WEBHOOK_SECRET`. Results are bounded and redacted; every call
appends `audit_events` with `tool.execute`, risk, outcome and incident id.
Never record the API key, signing secret or Slack content.

**Tests.** Fake fetch only: valid/tampered/expired Svix signature, unknown
event type, severity rank mapping, cap/truncated, `429` on list, foreign-tenant
read `NOT_FOUND`. The signature fixture must include the exact
`id.timestamp.body` string so a future verifier cannot silently change it.

## 7. Operator setup checklist

1. Accept that this connector requires a paid plan: Basic has no API and no
   webhooks [S1]. Choose Team or Pro and confirm the seat count.
2. Create an API key at `app.incident.io/~/settings/api-keys`; record the
   organization and region.
3. Create a webhook endpoint in Settings > Webhooks; subscribe to incident
   lifecycle events; copy the signing secret once. Point it at
   `https://<host>/api/webhooks/incident-io`.
4. Map incident severities by rank to the table in §1; store the mapping as
   configuration.
5. Map incident types/services to repository bindings; the incident id is the
   stable key.
6. If an alert source is used instead, confirm its authentication before
   exposing a URL; prefer the signed webhook.
7. Rotate the API key and the signing secret independently.

```dotenv
INCIDENT_IO_API_KEY=
INCIDENT_IO_BASE_URL=
INCIDENT_IO_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline, providers disabled:

- [ ] `verifyIncidentIoWebhook` accepts a valid Svix signature, rejects a
      tampered body, wrong id/timestamp, unknown version and a delivery older
      than 300 s.
- [ ] `normalizeIncidentIoIncident` creates only on creation events and maps
      severity by rank.
- [ ] Reader caps at 2 calls / 1 page, redacts and sets `truncated`.
- [ ] Foreign-tenant read returns `NOT_FOUND`; `429` fails closed.

One bounded live read after explicit authorization, on a paid plan: one named
incident. No retries. incident.io is not credit-funded, but the plan itself is
a cost; record it in the wave decision.

## 9. Risks / never in model context

- Slack messages, threads and reaction content; never fetched.
- Responder PII: names, emails, phone numbers, on-call schedules.
- API key, webhook signing secret, alert-source URL token.
- Incident free-text summaries and custom fields can contain customer data;
  allowlist fields and redact before truncation.
- Severity names are organization-custom and untrusted text; map by rank, not
  by string.
- The Basic plan's lack of API/webhooks is a hard boundary; never suggest a
  free workaround that scrapes Slack.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [incident.io pricing](https://incident.io/pricing) |
| S2 | [Webhooks (integration guide)](https://docs.incident.io/integrations/webhooks) |
| S3 | [Webhooks API reference](https://docs.incident.io/api-reference/webhooks) |
| S4 | [Custom HTTP alert sources](https://docs.incident.io/alerts/custom-http-sources) |
| S5 | [API introduction](https://docs.incident.io/api-reference/introduction) |
| S6 | [Automate incident creation with Alerts](https://docs.incident.io/incidents/auto-create) |
