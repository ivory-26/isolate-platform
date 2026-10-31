# PagerDuty connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/pagerduty/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — free plan still exists, 5 users |
| Auth | Account API key, read-only, `Authorization: Token token=<key>` [S2] |
| Inbound | V3 webhook, `X-PagerDuty-Signature: v1=<hex>` [S4] |
| Read | Incident, bounded log entries, service, escalation policy name [S9–S14] |
| Writes | Not in scope; ack/resolve/snooze designed as approval-gated [S11][S12] |

Nothing below is implemented. `pagerduty` is already a value in
`INCIDENT_SOURCES` (`packages/shared/src/types/incident.ts`), but there is no
verifier, normalizer, reader or route mode. The existing receiver selects only
`github` or `generic`; a PagerDuty delivery would be parsed as generic and
rejected.

## 1. Role in the agent

PagerDuty is the system of record for human-declared incidents and escalation.
It answers "who is paged, how severe, and what changed" — not "where is the
defect"; pair it with GitHub and Sentry. The trigger is the primary value, the
reader is supporting evidence.

**Kinds and policy.** `incident.triggered` creates a task. `resolved` and
`acknowledged` update an existing incident and never create a second one;
`escalated`, `reassigned` and `priority_updated` are lifecycle changes;
`service.updated` is ignored.

**Severity mapping.** PagerDuty has both `urgency` (`high`/`low`) and an
optional `priority` object.

| Signal | `IncidentSeverity` |
|---|---|
| `priority.name` P1 or `urgency=high` | `critical` |
| `priority.name` P2 | `high` |
| `priority.name` P3 or `urgency=low` | `medium` |
| P4 / P5 | `low` |
| no priority, no urgency | `medium` |

The final mapping is an open question; the trigger policy must reject anything
below the configured floor. `evaluateIncidentTrigger` is GitHub-shaped and
cannot be reused unchanged.

**Fingerprint.** `pagerduty:<service-id>:<incident-id>`; `X-Webhook-Id` and
`event.id` are traceability only. **Evidence added:** title, status, urgency,
priority, service name/id, timestamps and bounded lifecycle log entries.

## 2. Free tier and quotas

| Limit | Free plan | Notes |
|---|---|---|
| Price | $0 per year | "A single team trying on-call and incident response" [S1] |
| Users | 5 | Hard seat limit [S1] |
| On-call schedules | 1 | [S1] |
| Escalation policies | 1 | Confirmed by product docs [S14] |
| Notifications | 100 SMS/phone per month | Chat, email and push are basic [S1] |
| Status pages / AIOps | Not included | No status page; no advanced analytics [S1] |
| API access | Included | REST API v2 is usable on the free plan [S1] |
| Retention | Not stated | **UNVERIFIED**; audit records are 12 months, incident history is not documented [S16] |
| Trial | Paid plans are available for evaluation | No separate free trial length extracted — **UNVERIFIED** |

The free plan fits a one-service pilot; a real rotation needs a paid tier, and
the single escalation policy is a hard design limit. REST API limit is 960
requests/minute per key [S7]; a five-call bundle is far below it. The real risk
is a flapping monitor, already bounded by fingerprint dedupe and the two-active-
task cap.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Header | `Authorization: Token token=<API_KEY>` [S2] |
| Key type | Account API key, **read-only** [S2] |
| Avoid | User API keys (act as the user, need Advanced Permissions) and full-access account keys [S2] |
| Scoped alternative | Private App with scoped OAuth; read scopes below [S3][S15] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active key; create the replacement, deploy, verify one read, revoke the old key |

| Scope | Needed for | Source |
|---|---|---|
| `incidents.read` | Incidents and incident log entries | [S10][S15] |
| `services.read` | Service metadata and service-to-repository mapping | [S15] |
| `oncalls.read` | On-call lookup (not fetched by default; responder data is PII) | [S15] |
| `escalation_policies.read` | Policy name/id context only | [S15] |
| `schedules.read` | Optional; schedule names only | [S15] |
| `incidents.write` | Ack/resolve/snooze — **separate credential, later wave** | [S11][S12] |

A read-only account key cannot write by construction. Writes need a separate
token with `incidents.write` plus a `From` header naming a valid user; store
that address server-side, never in a prompt.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Proposed endpoint | `POST /api/webhooks/pagerduty` |
| Signature header | `X-PagerDuty-Signature: v1=<hex>` [S4] |
| Algorithm and signed string | HMAC-SHA256 over the exact raw request body bytes; the body only, no timestamp [S4] |
| Rotation | The header may contain several comma-separated `v1=` values; accept any that matches an active secret [S4] |
| Signed timestamp | **No**; `event.occurred_at` is unsigned payload data |
| Replay window | None vendor-side; enforce a ±300 s freshness check on `event.occurred_at` and reject stale events |
| Dedupe key | Source fingerprint; `X-Webhook-Id` is the documented idempotency header and is traceability only [S5] |
| Body cap | 64 KiB platform cap; PagerDuty guarantees 55 KB and drops above 256 KB [S5] |
| Retries | Up to 48 hours; 5 s response timeout; subscription disabled after 3 consecutive dropped deliveries; order preserved [S5] |

Because the signature covers the body only, a captured delivery can be replayed
unless the receiver rejects stale `occurred_at`; the signature proves authorship,
not freshness. Event types: `incident.triggered`, `incident.resolved`,
`incident.acknowledged`, `incident.escalated`, `incident.reassigned`,
`incident.priority_updated`, `service.updated` [S6]. Payload fields include
`event.id`, `event.event_type`, `event.occurred_at`, `incident.id`,
`incident.title`, `incident.urgency`, `incident.priority`, `incident.service`,
`incident.html_url` [S6]. Verification is constant-time and fail closed; an
accepted delivery returns `202` before any model or provider fetch.

## 5. Read-only context

Base host: `https://api.pagerduty.com`. The plan is fixed in code; the model
cannot author a query.

| # | Need | Endpoint | Params and notes |
|---|---|---|---|
| 1 | Incident | `GET /incidents/{id}` | `include[]=services,priorities`; allowlist `id`, `incident_number`, `title`, `status`, `urgency`, `priority`, `service`, `created_at`, `html_url` [S9] |
| 2 | Log entries | `GET /incidents/{id}/log_entries` | `limit`, `offset`, `since`, `until`, `is_overview`; scope `incidents.read`; first and last page only [S10] |
| 3 | Service | `GET /services/{id}` | `id`, `name`, `html_url`, `escalation_policy`; used to resolve the repository [S13] |
| 4 | Escalation policy | `GET /escalation_policies/{id}` | `id`, `name` only; never responders or schedules [S14] |

Never call `/incidents/{id}/alerts`, `/notes`, `include[]=channels` or
`first_trigger_log_entries`: alert payloads and notes are free text with
monitoring labels, URLs and customer identifiers, and the last two recover the
original alert. A future note excerpt needs its own approval.

Caps: at most 4 calls, one page each, 10 s timeout, 256 KiB response cap. The
bundle obeys 100 items / 4,000 chars / 256 KiB; the timeline is 25 entries,
each a one-line action + actor role (no names), and the excerpt 2,000 chars.
Pagination: `limit` default 25, max 100; `offset` + `limit` <= 10,000; `more`
flag [S8]. The reader stops at page one.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/pagerduty/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | `pagerduty` already exists; no contract change for the enum |
| Contract change required first | New vendor route mode + a PagerDuty trigger rule; both are shared transport changes |
| Inbound | `verifyPagerDutyWebhook(rawBody, headers, secrets[])` → closed reason union; accepts multiple `v1=` values |
| Normalize | `normalizePagerDutyIncident(payload)` → strict `IncidentSignal`; triggered only |
| Reader | `fetchPagerDutyIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (server-side only):

| Tool | Risk band | Notes |
|---|---|---|
| `pagerduty.fetch_incident_context` | `read_only` | Fixed call plan; audited |
| `pagerduty.acknowledge_incident` | `sensitive` | Approval bound to `{incidentId, action}` |
| `pagerduty.resolve_incident` | `sensitive` | Resolution is an incident-owner decision, never a test outcome |
| `pagerduty.snooze_incident` | `sensitive` | Approval bound to `{incidentId, durationSeconds}` |

Write API: `PUT /incidents` with a one-element `incidents` array (`status`) or
`POST /incidents/{id}/snooze` (`duration` 1-604800); needs `incidents.write` and `From` [S11][S12].

Under `createRiskTablePolicy`, `sensitive` returns `APPROVAL_REQUIRED` and the
worker pauses for a persisted approval; there is no auto-ack or auto-resolve.
If these were ever classified `scoped_write` they would execute without a
second approval, which is unacceptable for paging state.

**Sandbox implications.** Tools run in the worker, not the Modal sandbox. The
sandbox has egress denied and never sees `PAGERDUTY_API_KEY`,
`PAGERDUTY_WEBHOOK_SECRET` or the `From` address. Results are bounded and
redacted; every call appends `audit_events` with `tool.execute`, risk, outcome
and target id — never the token, note body or responder data.

**Tests.** Fake fetch only: multi-signature rotation, tampered body, stale
`occurred_at`, triggered vs resolved, severity table, responder fields absent,
cap/truncated, `429`, foreign `NOT_FOUND`, approval payload mismatch.

## 7. Operator setup checklist

1. Decide whether PagerDuty owns the trigger or mirrors Sentry/GitHub.
2. Confirm the plan. The free plan allows 5 users, one schedule and one
   escalation policy; verify that is enough for the pilot.
3. Create a read-only account API key (or a Private App with the read scopes in
   §3). Record the account subdomain and API base.
4. Add a v3 webhook pointed at `https://<host>/api/webhooks/pagerduty`;
   subscribe to the incident events in §4. Copy the signing secret once.
   Enable only after the shared route mode ships.
5. Map each in-scope PagerDuty service id to one repository binding. The
   service name is not unique; bind by id.
6. Decide the severity floor and which services may create tasks.
7. For writes, create a second credential and a `From` user; do not enable
   until offline tests and one approval-bound acceptance pass.
8. Rotate by adding a second secret, accepting both `v1=` values, then removing
   the old one.

```dotenv
PAGERDUTY_API_KEY=
PAGERDUTY_BASE_URL=
PAGERDUTY_WEBHOOK_SECRET=
PAGERDUTY_FROM_EMAIL=
```

## 8. Acceptance checklist

Offline, providers disabled:

- [ ] `verifyPagerDutyWebhook` accepts either of two active signatures during
      rotation; rejects tampered bodies, missing headers and oversize bodies.
- [ ] `normalizePagerDutyIncident` creates only on `incident.triggered`;
      resolved/acknowledged update and never duplicate.
- [ ] Reader caps at 4 calls / 25 log entries / 2,000 chars, redacts actor
      names and free text, sets `truncated`; writes resolve `APPROVAL_REQUIRED`
      with a payload hash bound to the incident id and action.
- [ ] Foreign-tenant read returns `NOT_FOUND`; `429` fails closed.

One bounded live read after explicit authorization: one named incident, one
log-entry page, one service. No retries. PagerDuty is not credit-funded.

## 9. Risks / never in model context

- Responder PII: names, emails, phone numbers, notification targets, on-call
  schedules and escalation-policy membership.
- Full alert payloads: monitoring labels, dashboard URLs with tokens, customer
  identifiers; raw log-entry bodies and arbitrary note text.
- API keys, OAuth tokens, webhook signing secrets and the `From` address.
- Escalation policy structure beyond id and name. Free-text titles can carry
  customer names; they pass the shared redactor and 200-character cap.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Plans and pricing](https://www.pagerduty.com/pricing/) |
| S2 | [Authentication](https://docs.pagerduty.com/developer/authentication) |
| S3 | [Private Apps / scoped OAuth](https://docs.pagerduty.com/developer/private-apps) |
| S4 | [Verifying webhook signatures](https://docs.pagerduty.com/developer/verifying-webhook-signatures) |
| S5 | [Webhook behavior](https://docs.pagerduty.com/developer/webhook-behavior) |
| S6 | [Webhooks overview](https://docs.pagerduty.com/developer/webhooks-overview) |
| S7 | [REST API rate limits](https://docs.pagerduty.com/developer/rest-api-rate-limits) |
| S8 | [Pagination](https://docs.pagerduty.com/developer/pagination) |
| S9 | [Get an incident](https://docs.pagerduty.com/developer/api/reference/rest/incidents/get-incident) |
| S10 | [List log entries for an incident](https://docs.pagerduty.com/developer/api/reference/rest/incidents/list-incident-log-entries) |
| S11 | [Manage incidents](https://docs.pagerduty.com/developer/api/reference/rest/incidents/update-incidents) |
| S12 | [Snooze an incident](https://docs.pagerduty.com/developer/api/reference/rest/incidents/create-incident-snooze) |
| S13 | [Get a service](https://docs.pagerduty.com/developer/api/reference/rest/services/get-service) |
| S14 | [Escalation policy basics](https://docs.pagerduty.com/incident-management/schedules/escalation-policies) |
| S15 | [Backstage integration guide (scope list)](https://docs.pagerduty.com/integrations/backstage-integration-guide) |
| S16 | [Audit Records API](https://docs.pagerduty.com/developer/audit-records-api) |
