# Rootly connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/rootly/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — **no free plan**; 14-day trial, then paid |
| Auth | API key, `Authorization: Bearer <key>` [S3] |
| Inbound | Outgoing webhook, `X-Rootly-Signature: t=…,v1=…` [S2] |
| Read | Incident by id/list, severity, status, timestamps [S4] |
| Writes | None in scope |

Nothing below is implemented. `rootly` is **not** in `INCIDENT_SOURCES`
(`packages/shared/src/types/incident.ts`); a shared-contract commit must add it
before an adapter. There is no route mode and no verifier.

## 1. Role in the agent

Rootly is an incident-response platform: it answers "what is declared, how
severe, what is the lifecycle state, and who owns it". It is not a code
location source. Pair it with GitHub and, when available, Sentry.

The trigger is the primary value; the reader supplies bounded incident
metadata. Rootly is viable only as a paid connector: there is no free plan, so
the zero-cost evaluation is a 14-day trial (§2). Do not design a permanent
deployment around the trial.

**Kinds and policy.** `incident.created` creates a task. `incident.updated`,
`incident.resolved`, `incident.mitigated` and `incident.cancelled` update an
existing task. Retrospective, action-item and workflow events are not
triggers.

**Severity mapping.** Rootly severity is organization-defined; use the
severity slug/name and a configured map.

| Rootly severity | `IncidentSeverity` |
|---|---|
| `critical` / `sev0` / `p1` | `critical` |
| `high` / `sev1` / `p2` | `high` |
| `medium` / `sev2` / `p3` | `medium` |
| `low` / `sev3` / `p4` | `low` |
| none | `medium` |

The exact severity object shape returned by the API was not extracted —
**UNVERIFIED**. Map by a configured field, not by guessing free text.

**Fingerprint.** `rootly:<incident-id>` — stable across updates and webhook
retries. The webhook delivery id is traceability only.

**Evidence added.** Incident title, slug, kind, severity, status, summary,
started/created timestamps and canonical URL. No timeline, no responders.

## 2. Free tier and quotas

Rootly does not publish a free plan in 2026.

| Limit | Value | Notes |
|---|---|---|
| Free plan | **None** | No $0 tier on the pricing page [S1] |
| Trial | 14 days | "Try Rootly free for two weeks" [S1] |
| Incident Response | $20 per user/month | [S1] |
| On-Call | $20 per user/month | Billed separately from Incident Response [S1] |
| AI SRE | Requires Incident Response | Price not extracted — **UNVERIFIED** [S1] |
| Retention | Not stated | **UNVERIFIED**; assume plan-dependent |
| API access | Included with the paid product | Exact plan gating not stated — **UNVERIFIED** |

A pilot needs at least the Incident Response seat plus one On-Call seat if
paging is in scope: about $40 per user per month. Record that cost in the
decision, because it is the opposite of the free-tier connectors in this wave.

Rate limit: 3,000 requests per minute [S3]. A bundle is a handful of calls;
the limit is not the constraint. The trial expiry is.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Bearer <token>` [S3] |
| Token type | Rootly API key / auth token created in account settings [S3] |
| Scope | No per-resource read scope documented — **UNVERIFIED** |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active token; create the replacement, deploy, verify one read, revoke the old token |

The API reference documents bearer authentication and a JSON:API content type
(`application/vnd.api+json`), not an OAuth scope catalogue [S3]. Treat the token
as organization-wide and keep it server-side. Do not use the webhook signing
secret as the API token; they are separate credentials.

Inbound generic webhook alert sources use a static Bearer token in the
`Authorization` header, or a secret query parameter [S5]. A secret in a query
string is a credential in logs; prefer the header and never log the URL.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `X-Rootly-Signature: t=<timestamp>,v1=<hex>` [S2] |
| Algorithm and signed string | HMAC-SHA256, hex digest, over the timestamp concatenated with the raw request body (docs state no separator) [S2] |
| Signed timestamp | Yes; `t=` is part of the signed string |
| Replay window | "Within a few minutes"; enforce ±300 s locally [S2] |
| Retries | 3 attempts at 15 s, 1 min and 5 min [S2] |
| Dedupe key | Source fingerprint; the delivery id is traceability only |
| Body cap | 64 KiB platform cap; vendor payload limit not documented — **UNVERIFIED** |

The no-separator signed string is unusual: `${timestamp}${body}`, not
`${timestamp}.${body}`. Implement it exactly as documented and pin the
concatenation in a fixture; a verifier copied from a Stripe-style scheme would
reject every delivery.

Because the timestamp is signed, replay is bounded by the freshness check.
Verify over raw bytes, compare hex in constant time, accept only `v1`, and
reject a missing or malformed `t`. Event names include `incident.created` and
`incident.resolved` [S2]; the complete event catalogue and payload schema were
not extracted — **UNVERIFIED**. Parse strictly and ignore unknown events with
`202 {accepted:false}`.

The generic webhook alert source is a separate inbound path: Rootly receives
alerts there, it does not deliver incident events. It is not a substitute for
the outgoing webhook.

## 5. Read-only context

Base host: `https://api.rootly.com/v1`. The plan is fixed in code.

| # | Need | Endpoint | Params and notes |
|---|---|---|---|
| 1 | Incident | `GET /v1/incidents/{id}` | `id`, `title`, `slug`, `kind`, `severity`, `status`, `started_at`, `created_at`, `url`, `summary` [S4] |
| 2 | Incident list (poll) | `GET /v1/incidents` | `page[number]`, `page[size]`, filters; JSON:API [S3] |
| 3 | Severity catalogue | Not extracted | Only if severity is an id rather than a name — **UNVERIFIED** |
| 4 | Timeline / action items | Not extracted | Out of scope; free text and responder PII — **UNVERIFIED** |

Caps: at most 2 calls, one page, 10 s timeout, 256 KiB response cap. The bundle
obeys 100 items / 4,000 characters per excerpt / 256 KiB total. The incident
excerpt is capped at 2,000 characters and includes allowlisted fields only.

Pagination is JSON:API `page[number]` / `page[size]` [S3]. Stop after one page;
the incident history is not evidence for a code fix. A `429` fails the bundle
with a bounded error and no retry loop.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/rootly/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | **Must add `rootly` to `INCIDENT_SOURCES` before the adapter** |
| Contract change required first | Enum value, vendor route mode, and a Rootly trigger rule |
| Inbound | `verifyRootlyWebhook(rawBody, headers, secret)` with timestamp+body concatenation |
| Normalize | `normalizeRootlyIncident(payload)` → strict `IncidentSignal` |
| Reader | `fetchRootlyIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (server-side only):

| Tool | Risk band | Notes |
|---|---|---|
| `rootly.fetch_incident_context` | `read_only` | Fixed plan; audited |
| `rootly.update_incident_status` | `sensitive` | Out of scope; approval bound to `{incidentId, status}` |

No write tool is proposed for this wave. Resolving or mitigating an incident is
a responder decision and must not follow a validation result.

**Sandbox implications.** Tools execute in the worker, not the Modal sandbox.
The sandbox keeps egress denied and never sees `ROOTLY_API_KEY` or
`ROOTLY_WEBHOOK_SECRET`. Results are bounded and redacted; every call appends
`audit_events` with `tool.execute`, risk, outcome and incident id. Never record
the token, signing secret, timeline or responder fields.

**Tests.** Fake fetch only: valid/tampered/expired signature using the exact
`${timestamp}${body}` concatenation; created vs resolved; severity map; cap and
`truncated`; `429`; foreign-tenant read `NOT_FOUND`.

## 7. Operator setup checklist

1. Budget for a paid plan: Incident Response at $20/user/month, plus On-Call at
   $20/user/month if paging is in scope. The 14-day trial is evaluation only.
2. Create an API token in account settings; record the organization and region.
3. Create an outgoing webhook in Settings > Webhooks; copy the signing secret
   once. Point it at `https://<host>/api/webhooks/rootly`.
4. Confirm the event names and payload schema against the live account; the
   public page documents only a subset — mark any gap **UNVERIFIED**.
5. Map incidents to repository bindings by incident id or service; titles are
   not unique.
6. Configure the severity map; decide whether `medium` creates a task.
7. Rotate the API token and the webhook secret independently.

```dotenv
ROOTLY_API_KEY=
ROOTLY_BASE_URL=
ROOTLY_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline, providers disabled:

- [ ] `verifyRootlyWebhook` accepts the exact timestamp+body HMAC, rejects a
      tampered body, wrong separator, missing `t` and a delivery older than
      300 s.
- [ ] `normalizeRootlyIncident` creates only on `incident.created` and maps
      severity by configuration.
- [ ] Reader caps at 2 calls / 1 page, redacts and sets `truncated`.
- [ ] Foreign-tenant read returns `NOT_FOUND`; `429` fails closed.

One bounded live read during the trial, only after explicit authorization: one
named incident. No retries. Rootly is not credit-funded, but the plan is a
recurring cost; record it before the trial converts.

## 9. Risks / never in model context

- Responder PII: names, emails, phone numbers, on-call schedules, paging
  targets.
- Incident timelines, action items and retrospective text; never fetched.
- API token, webhook signing secret, generic alert-source token or query
  secret.
- Customer data in incident titles, summaries and custom fields; allowlist
  fields and redact before truncation.
- Slack channel names and message links can reveal internal structure; do not
  include them.
- No free tier means a trial expiry can silently stop the connector; surface
  `INTEGRATION_UNAVAILABLE` rather than treating a `401`/`402` as "no incident".

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Rootly pricing](https://rootly.com/pricing) |
| S2 | [Outgoing webhooks](https://docs.rootly.com/configuration/webhooks) |
| S3 | [API overview: authentication and conventions](https://docs.rootly.com/api-reference/overview) |
| S4 | [Retrieve an incident](https://docs.rootly.com/api-reference/incidents/retrieves-an-incident) |
| S5 | [Generic webhook alert source](https://docs.rootly.com/integrations/generic-webhook-alert-source/generic-webhook-alert-source) |
