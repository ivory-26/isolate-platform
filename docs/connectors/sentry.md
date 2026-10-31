# Sentry connector

| Field | Value |
|---|---|
| Status | **Design only — no connector code exists in this repository** |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.3 (P2 default incident source) |
| Trigger | Sentry integration-platform webhook |
| Context | Issue, latest event, bounded stack trace, release |
| Writes | None in scope |

Nothing below is implemented. It is the build plan and the verified vendor facts needed to implement it without guessing.

## 1. Role in the agent

Sentry supplies the missing "where is the defect" half of an incident: an issue ties a stack trace and a release to a project, which is the input a code-fix loop needs. PagerDuty tells you a human is paged; Sentry tells you which frame threw.

Default use: `issue` webhook creates one task for a new or regressed error group; the context reader then fetches the issue, one representative event and the release. If PagerDuty is the system that actually pages humans and Sentry is absent, swap the two (survey §5.3).

## 2. Auth model

| Item | Design |
|---|---|
| Header | `Authorization: Bearer <TOKEN>` [S33] |
| Token type | **Organization token** bound to the tenant's projects; avoid a personal user token for a service integration [S33] |
| Storage | Server-only connector credential, encrypted at rest, keyed by `(organization_id, connector_id)`; resolved by a broker, never by the model |
| Rotation | One active token per organization; rotate by creating a second org token, deploying it, then revoking the first |

## 3. Minimal scopes

| Scope | Needed for | Notes |
|---|---|---|
| `event:read` | Issues and events | Primary read scope [S34] |
| `project:read` | Project metadata | [S34] |
| `org:read` | Organization metadata | [S34] |
| `member:read` | Assignee resolution only | Optional; not needed for a context bundle [S34] |

Release/deploy lookup may need an additional release permission; the exact scope string was not extracted — **UNVERIFIED**. Do not request write scopes (`event:write`, `project:write`, `member:write`) for this connector.

## 4. Inbound webhook

| Property | Value |
|---|---|
| Signature header | `Sentry-Hook-Signature` [S35] |
| Algorithm | HMAC-SHA256 over the exact request body bytes [S35] |
| Timestamp header | `Sentry-Hook-Timestamp` is sent [S35] |
| Resource header | `Sentry-Hook-Resource` identifies the object type [S35] |
| Replay window | Not documented by Sentry; enforce our own 5-minute window on `Sentry-Hook-Timestamp` and dedupe by resource + issue/event id — **UNVERIFIED** vendor behavior |
| Retries | Not documented — **UNVERIFIED**; reconcile by polling issue state rather than assuming delivery |

Planned mapping: only a new or regressed issue creates a task; resolution and assignment update an existing task. The fingerprint must be source-stable (organization + project + issue id), not the delivery id. Confirm the exact webhook payload field names against the installed integration before coding; the survey did not extract them.

Transport rules (signature over raw bytes, 64 KiB body cap, constant-time compare, 202 before any model work, no payload echo) are shared with the implemented receiver — see [README.md](README.md) §3.

## 5. Read endpoints for a ContextBundle

Base host: `https://sentry.io` or the organization's region host. All paths below are from the official API reference as extracted in the survey.

| Need | Endpoint | Fields / notes |
|---|---|---|
| Issue metadata | `GET /api/0/organizations/{org}/issues/{issue_id}/` | `title`, `culprit`, `firstSeen`, `lastSeen`, `count`, `metadata`, `assignedTo`, `status` [S36] |
| Issue events | `GET /api/0/organizations/{org}/issues/{issue_id}/events/` | `full=false`; `sample=true` only for one representative event [S37] |
| One event for an issue | `GET /api/0/organizations/{org}/issues/{issue_id}/events/{event_id}/` | Bounded stack trace; an `llmFormat` parameter exists but is not required [S38] |
| One event for a project | `GET /api/0/projects/{org}/{project}/events/{event_id}/` | Use when the issue is not the entry point [S39] |
| Releases | `GET /api/0/organizations/{org}/releases/` | `version`, `dateCreated`, `dateReleased`, `projects`, `lastEvent` [S40] |
| Deploy records | Release deploys endpoint | Exact read path not extracted — **UNVERIFIED** |
| Failing checks / metrics | Not Sentry's role | Use GitHub / Grafana / Datadog |
| Runbook | No standard field | Use a `runbook` tag or metadata if the org sets one; otherwise the repository runbook by service |

Planned request sequence (fixed in code, not model-authored): issue → one event (`full=false`) → release by version. Cap at 4 calls, one page each, 2,000-character excerpt for the event and 1,500 for metadata.

## 6. Rate limits, pagination, retention

| Constraint | Value | Handling |
|---|---|---|
| Rate limit | Applied per unique caller + endpoint; no single global number published [S42] | Per-connector token bucket; bounded calls; back off on `429` |
| `429` headers | `X-Sentry-Rate-Limit` / `Retry-After` are commonly returned but were not enumerated on the retrieved page — **UNVERIFIED** | Read `Retry-After` when present; one retry, then degrade |
| Pagination | Cursor-based `Link` header, cursor `id:offset:is_prev`, 100 events per page [S41] | At most 2 pages; stop at the item cap |
| Event retention | Developer 30 days; Team 90 days; Business/Enterprise 90 days; fixed at ingestion by plan [S43] | Prefer the latest event; never build a historical corpus |

## 7. What must never enter model context

- Full event JSON. Sentry events can contain request headers, cookies, query strings, user context, breadcrumbs, stack locals, transaction names, HTTP spans and attributes [S44].
- PII in tags or user context: email, IP address, user id, names, session ids.
- Attachment contents.
- Auth tokens, DSNs (a DSN can ingest events), source-map credentials, organization/project keys.
- Full issue comment threads and raw event payloads; only allowlisted fields and a bounded stack trace.

Structural redaction planned before truncation: drop `request.headers`, `request.cookies`, `request.query_string`, `user`, `breadcrumbs[].data`, span attributes, and any field outside the allowlist. Count redactions per item.

## 8. Data retention notes

- Provider retention is 30 or 90 days by plan [S43]; the connector must not assume older events exist.
- Store only derived, redacted excerpts with a hash; no raw event JSON. Excerpt TTL is 30 days in the survey design (`CONTEXT_ITEM_TTL_DAYS`).
- A model provider receives only the bounded excerpt. Region and cross-border transfer are open questions (§10).
- Deletion must cascade by organization; a DSAR path for stored excerpts is a requirement, not a nicety.

## 9. Phased implementation checklist

1. **Decide** plan, region host and token type (organization token). Confirm which projects are in scope.
2. **Contract**: map the webhook payload to `IncidentSignal` (source `sentry`, kind `issue` or `incident_triggered`, severity from Sentry level, service = project slug). Add a strict Zod schema for the payload subset; no raw body retention.
3. **Transport**: add `verifySentryWebhook` with HMAC over raw bytes, `Sentry-Hook-Timestamp` window, 64 KiB cap and constant-time compare; route it through the existing intake pipeline rather than a second receiver.
4. **Reader**: `fetchSentryIncidentContext` with a fixed 3-call plan, allowlisted fields, structural PII drops, bounded stack trace, `truncated` on any omission.
5. **Tests**: fake fetch and fixtures only; same-org/different-org isolation; redaction tests with seeded headers and emails; `429` and timeout paths.
6. **Offline gates** twice, with providers disabled. No keys.
7. **Live acceptance** only after explicit user authorization: one signed fixture delivery or one read against a named issue, bounded, no retries, spend recorded.
8. **Writes**: out of scope. Resolve/assign/comment would be separate approval-gated tools.

## 10. Open questions for the user

1. Which Sentry plan (30 vs 90-day retention) and which region host?
2. Is an organization token available, or must this use OAuth?
3. Which projects/environments may create tasks, and at which severity threshold?
4. Should a regression create a new task or update the prior one?
5. Is `member:read` acceptable for assignee context, or should assignees be omitted?
6. May redacted stack traces leave the region to the inference provider?
7. What is the retention requirement for stored excerpts, and is a per-organization delete workflow required?
8. Is Sentry the authoritative trigger, or PagerDuty?

## 11. Sources

All accessed 2026-10-30; copied from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9.

| ID | Source |
|---|---|
| S33 | [API authentication](https://docs.sentry.io/api/auth/) |
| S34 | [API permissions](https://docs.sentry.io/api/permissions/) |
| S35 | [Integration platform webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/) |
| S36 | [Retrieve an issue](https://docs.sentry.io/api/events/retrieve-an-issue/) |
| S37 | [List an issue's events](https://docs.sentry.io/api/events/list-an-issues-events/) |
| S38 | [Retrieve an issue event](https://docs.sentry.io/api/events/retrieve-an-issue-event/) |
| S39 | [Retrieve an event for a project](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/) |
| S40 | [List an organization's releases](https://docs.sentry.io/api/releases/list-an-organizations-releases/) |
| S41 | [Pagination](https://docs.sentry.io/api/pagination/) |
| S42 | [Rate limits](https://docs.sentry.io/api/ratelimits/) |
| S43 | [Data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/) |
| S44 | [Sensitive data](https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/) |
