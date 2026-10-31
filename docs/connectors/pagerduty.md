# PagerDuty connector

| Field | Value |
|---|---|
| Status | **Design only — no connector code exists in this repository** |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.2 (P2 alternative) |
| Trigger | PagerDuty v3 webhook (`incident.triggered`) |
| Context | Incident metadata, bounded timeline, service |
| Writes | None in scope (ack/resolve/escalate are a later, approval-gated wave) |

Nothing below is implemented.

## 1. Role in the agent

PagerDuty is the system of record for **human-declared** incidents and on-call escalation. It supplies lifecycle and severity, not code location: an incident names a service and a title, and the agent must join that service to a repository and then get code context from GitHub (and metrics from Grafana or Datadog).

Choose PagerDuty when it is what actually pages humans and Sentry is absent; choose Sentry when the trigger is an error group with a stack trace (survey §5.3).

## 2. Auth model

| Item | Design |
|---|---|
| Header | `Authorization: Token token=<API_KEY>` on REST API v2 [S25] |
| Key type | **Read-only account API key** [S25] |
| Avoid | User API keys (act as the user and need Advanced Permissions); full-access account keys [S25] |
| Alternative | Private App with scoped OAuth (app and/or user token); verified read scopes are `incidents.read` and `services.read` [S26] |
| Storage | Server-only, encrypted at rest, one credential per `(organization, connector)` |

## 3. Minimal scopes

| Scope | Needed for |
|---|---|
| `incidents.read` | Incident metadata and timeline [S26] |
| `services.read` | Service metadata used to map to a repository [S26] |

Write scopes (acknowledge, resolve, note) were not extracted from the official reference — **UNVERIFIED**. A write credential must be separate from the read credential when that work starts.

## 4. Inbound webhook

| Property | Value |
|---|---|
| Signature header | `X-PagerDuty-Signature: v1=<hex>` [S27] |
| Algorithm | HMAC-SHA256 over the payload body **only** [S27] |
| Rotation | Multiple `v1=` signatures may be present; accept any that matches an active secret [S27] |
| Signed timestamp | **None** |
| Dedupe key | `X-Webhook-Id`, unique per webhook request [S28] |
| Staleness | No signed timestamp; compare the event's creation time to receipt time and reject stale events |
| Retries | Up to 48 hours; delivery is dropped after 3 consecutive failures over 24 hours; response timeout 5 s (16 s for custom actions); events are delivered in generation order [S28] |

Event types: `incident.triggered`, `incident.acknowledged`, `incident.resolved` [S29]. Payload carries `event.id`, `event.event_type`, `incident.id`, `incident.title`, `incident.urgency`, `incident.service` [S29].

Policy: only `incident.triggered` creates a task by default; acknowledged/resolved update an existing incident rather than opening a second one. Acknowledge/resolve are not task triggers — a human action is not new evidence.

Because there is no signed timestamp, the receiver must use `X-Webhook-Id` plus a source-stable fingerprint (`pagerduty:<service>:<incident id>`) and never treat an old delivery as fresh.

## 5. Read endpoints for a ContextBundle

Base host: `https://api.pagerduty.com`. Endpoints below are quoted from the survey; several exact paths could not be extracted from the JS-rendered API reference.

| Need | Endpoint | Notes |
|---|---|---|
| Incident metadata | `GET /incidents/{id}` (id or number) | `include[]=channels` can recover the trigger payload via `first_trigger_log_entry`; allowlist fields, never take the whole payload [S31] |
| Timeline | `GET /incidents/{id}/log_entries` | First/last N entries only; redact free text [S31] |
| Alerts | `GET /incidents/{id}/alerts` | Mentioned in navigation only — **UNVERIFIED** |
| Notes | `GET /incidents/{id}/notes` | Mentioned in navigation only — **UNVERIFIED** |
| Polling fallback | Incidents list endpoint | Exact list path not extractable — **UNVERIFIED** |
| Service metadata | `GET /services/{id}` with `services.read` | Exact path not extracted — **UNVERIFIED** |
| Deploy history / metrics / checks | Not PagerDuty's role | Use GitHub / Grafana / Datadog |
| Runbook | No standard field | Look for a runbook URL in incident notes/alert details; otherwise the repository runbook by service name |

Planned sequence: incident (2 calls at most), then service metadata only if the service name is ambiguous. No timeline pagination beyond one page of 25.

## 6. Rate limits, pagination, retention

| Constraint | Value | Handling |
|---|---|---|
| API limit | 960 requests/minute per account API key and per user [S30] | Per-connector token bucket; an incident bundle uses at most 3 calls |
| Over limit | `429`; the documented reset header is `ratelimit-reset` (the page does not document `Retry-After`) [S30] | Wait until reset; no retry storm |
| Pagination | `limit`/`offset` with a `more` flag; exact defaults not extracted — **UNVERIFIED** | Cap at one page of 25 |
| Retention | Incident/history retention is plan-dependent and not stated on the retrieved pages — **UNVERIFIED** | Do not build a historical corpus |

## 7. What must never enter model context

- Responder PII: names, emails, phone numbers, notification targets, on-call schedules.
- Full alert payloads; they can carry monitoring labels, URLs with tokens and customer identifiers.
- Raw log entries or arbitrary note bodies; only a redacted excerpt.
- API keys, OAuth tokens, webhook signing secrets.
- Full escalation policies; not needed to fix code.

## 8. Data retention notes

- Vendor retention is plan-dependent and undocumented on the pages retrieved — **UNVERIFIED**; assume incident history may disappear or change.
- Store only a bounded, redacted excerpt plus a hash; TTL 30 days in the survey design.
- On-call and responder data is personal data: do not store it at all, not even redacted.
- Deletion by organization and a DSAR path are requirements for stored excerpts.
- Region/residency depends on the PagerDuty plan and the inference provider; see open questions.

## 9. Phased implementation checklist

1. **Decide** whether PagerDuty or Sentry owns the trigger; confirm the account plan and read-only key.
2. **Contract**: map `incident.triggered` to `IncidentSignal` with severity from urgency (`high` → `critical`/`high`, `low` → `medium`; final mapping is an open question). Service = PagerDuty service name; this is the key used to resolve the repository.
3. **Transport**: `verifyPagerDutyWebhook` accepting one or more `v1=` signatures, HMAC over raw body, 64 KiB cap, constant-time compare; dedupe by `X-Webhook-Id` and fingerprint; no freshness claim beyond event time.
4. **Reader**: fixed ≤3-call plan (incident, optional timeline, optional service), allowlisted fields, redaction of free text.
5. **Tests**: fake fetch; multi-signature rotation case; stale event; `429`; foreign-tenant read returns `NOT_FOUND`.
6. **Offline gates** twice with providers disabled; no keys.
7. **Live acceptance** only with explicit authorization: one signed fixture or one read of a named incident, bounded, no retries, spend recorded.
8. **Writes** (ack/resolve/note) are a separate wave with their own credential and approval payload.

## 10. Open questions for the user

1. Which PagerDuty plan, and is a read-only account API key or a scoped OAuth app allowed?
2. Is PagerDuty the authoritative trigger, or only a lifecycle mirror of a Sentry/GitHub incident?
3. How is urgency mapped to severity, and does `low` urgency ever create a task?
4. Which services are in scope, and where does the service → repository mapping live?
5. Should acknowledged/resolved events update a task, and who owns that state transition?
6. Are responder names and on-call data ever needed, or always excluded?
7. May redacted incident text leave the region to the inference provider?
8. Is any write (acknowledge, resolve, note) ever allowed, and who approves it?

## 11. Sources

All accessed 2026-10-30; copied from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9.

| ID | Source |
|---|---|
| S25 | [Authentication](https://docs.pagerduty.com/developer/authentication) |
| S26 | [Private Apps / scoped OAuth](https://docs.pagerduty.com/developer/private-apps) |
| S27 | [Verifying webhook signatures](https://docs.pagerduty.com/developer/verifying-webhook-signatures) |
| S28 | [Webhook behavior](https://docs.pagerduty.com/developer/webhook-behavior) |
| S29 | [Webhooks overview](https://docs.pagerduty.com/developer/webhooks-overview) |
| S30 | [REST API rate limits](https://docs.pagerduty.com/developer/rest-api-rate-limits) |
| S31 | [Retrieving incident details](https://docs.pagerduty.com/developer/retrieve-incident-details) |
| S32 | [REST API reference](https://docs.pagerduty.com/developer/api/reference/rest) |
