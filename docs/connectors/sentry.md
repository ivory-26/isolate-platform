# Sentry connector

| Field | Value |
|---|---|
| Status | **Design-only — no code in this repo** |
| Module | `packages/integrations/src/sentry/` (proposed; does not exist) |
| Free tier verified | 2026-10-31 — Developer plan, free forever |
| Auth | Organization auth token, `Authorization: Bearer <token>` [S4] |
| Inbound | Integration-platform webhook, `Sentry-Hook-Signature` [S6] |
| Read | Issue, latest event and bounded stack trace, release, deploys [S8–S15] |
| Writes | None in scope |

Nothing below is implemented. `sentry` is already a value in `INCIDENT_SOURCES`
(`packages/shared/src/types/incident.ts`), but there is no verifier, normalizer,
reader or route mode for it. Today `detectIncidentIntakeMode` returns only
`generic` or `github`, so a Sentry delivery would be parsed as a generic signal
and rejected by the strict schema.

## 1. Role in the agent

Sentry supplies the "where is the defect" half of an incident: an issue ties a
stack trace and a release to a project, the latest event supplies the failing
frame, and deploys correlate the error with a change. That is the input a
code-fix loop needs (`docs/devsecops-connectors.md` §5.3). Use Sentry when the
authoritative signal is an error group; use PagerDuty when it is a human-declared
incident. The trigger is the primary value; the reader is the second.

**Kinds and policy.** Only `issue` webhooks with action `created` or
`unresolved` may create a task. `resolved`, `assigned` and `archived` are
lifecycle updates, not new evidence. A regression is a new `unresolved` event
for an existing issue id and is deduplicated by fingerprint, not by delivery.

**Severity mapping.** Sentry `level` is not a business severity.

| Sentry level | `IncidentSeverity` |
|---|---|
| `fatal` | `critical` |
| `error` | `high` |
| `warning` | `medium` |
| `info` | `low` |
| `debug` | `info` |

The platform trigger policy is GitHub-shaped (`evaluateIncidentTrigger`). It
must gain a Sentry rule: an `environment=production` issue at `high` or above is
accepted; feature-preview environments never create a task.

**Fingerprint.** `sentry:<org-slug>:<project-id>:<issue-id>`, bounded to 128
chars; delivery and event ids are traceability only. **Evidence added:** issue
metadata, one event with a bounded stack trace, release and newest deploy.

## 2. Free tier and quotas

| Limit | Free Developer | Notes |
|---|---|---|
| Price | $0 | Free forever [S1] |
| Users | 1 | Organization token still usable by that owner [S1] |
| Projects | Unlimited | [S1] |
| Errors | 5,000 per month | Event-based; billed monthly [S1] |
| Logs and application metrics | 5 GB each per month | [S1] |
| Spans | 5 million per month | [S1] |
| Replays | 50 per month | [S1] |
| Uptime / cron monitors | 1 each | [S1] |
| Retention | 30 days | Fixed at ingestion by the current plan [S3] |
| Trial | 14 days of Business | New accounts, no card [S2] |
| Overage | Not stated | **UNVERIFIED**; assume events beyond quota are dropped until reset |

The 30-day retention is the hard constraint: never build a historical corpus
or promise evidence older than 30 days. Rate limits apply per unique caller and
endpoint, with a requests-per-second window and a concurrency limit; no numeric
ceiling is published [S16]. Treat `429` as a degraded bundle, never a retry loop.

## 3. Auth and least privilege

| Item | Value |
|---|---|
| Token type | Organization auth token, bound to one organization [S4][S20] |
| Header | `Authorization: Bearer <token>` [S4] |
| Lifetime | No expiry documented for organization tokens; OAuth access tokens expire after 30 days [S4] |
| Creation | Organization settings; only owners/managers can revoke [S20] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |

| Scope | Needed for | Source |
|---|---|---|
| `event:read` | Issues, events, stack traces | [S5] |
| `project:read` | Project metadata used for the service name | [S5] |
| `org:read` | Organization metadata and release lookup | [S5] |
| `project:releases` | Releases and deploys | [S5] |
| `member:read` | Optional; assignee display only | [S5] — omit by default because it exposes personal data |

Never request `event:write`, `project:write`, `project:admin`, `org:admin` or
`member:admin`. Rotation: create a second organization token with the same four
read scopes, deploy, verify one read, then revoke the first. Organization tokens
cannot be edited after creation, so a scope change is a new token [S20].

## 4. Inbound trigger

| Property | Value |
|---|---|
| Proposed endpoint | `POST /api/webhooks/sentry` |
| Signature header | `Sentry-Hook-Signature` [S6] |
| Algorithm and signed string | HMAC-SHA256 hex digest over the exact raw request body bytes, keyed by the integration Client Secret [S6] |
| Timestamp | `Sentry-Hook-Timestamp` is sent but **not covered by the signature** [S6] |
| Resource header | `Sentry-Hook-Resource` (`issue`, `event_alert`, `metric_alert`, …) [S6] |
| Replay window | Enforce our own ±300 s window on `Sentry-Hook-Timestamp`; vendor behavior is not documented |
| Retries | No retry documentation; response timeout is 1 second [S6] |
| Dedupe key | `(organization, sentry, fingerprint)` for 30 minutes; delivery id is traceability only |
| Body cap | 64 KiB platform cap; oversized deliveries are `413` |
| Accepted actions | `created`, `unresolved` (payload actions: created, resolved, assigned, archived, unresolved) [S7] |

The receiver must select this verifier from headers, never the body. The
existing route chooses `github` when `x-github-event` is present and `generic`
otherwise; adding Sentry requires a new mode (for example
`Sentry-Hook-Resource` present) in the same commit as the verifier. A Sentry
request must never fall through to the generic verifier and its secret.

Because the timestamp is not signed, a captured body can be replayed; the
±300 s window bounds that, and the 30-minute fingerprint dedupe prevents a
second task. A stale delivery is `202 {accepted:false}`. No response, log line
or error may echo the body, signature, secret or provider text; accepted
deliveries return `202` before any model or provider fetch.

## 5. Read-only context

Base host is the organization's region host (`https://sentry.io` for US,
`https://de.sentry.io` for EU). The plan is fixed in trusted code.

| # | Need | Endpoint | Fields and params |
|---|---|---|---|
| 1 | Issue metadata | `GET /api/0/organizations/{org}/issues/{issue_id}/` | `title`, `culprit`, `level`, `status`, `firstSeen`, `lastSeen`, `count`, `shortId`, `project`, `metadata`; `environment` [S8] |
| 2 | Latest event | `GET /api/0/organizations/{org}/issues/{issue_id}/events/latest/` (or `events/{event_id}` with `latest`) | `eventID`, `message`, `culprit`, `tags` (allowlisted), `stacktrace.frames` [S10] |
| 3 | Release | `GET /api/0/organizations/{org}/releases/{version}/` | `version`, `dateCreated`, `dateReleased`, `projects`, `lastEvent` [S13] |
| 4 | Deploys | `GET /api/0/organizations/{org}/releases/{version}/deploys/` | `environment`, `dateStarted`, `dateFinished`, `name`, `url`; `cursor` [S14] |

Fallback: `GET /api/0/projects/{org}/{project}/events/{event_id}/` when the
issue is not the entry point [S11]. Caps: at most 4 calls, one page each, 10 s
timeout, 256 KiB response cap. The bundle obeys 100 items / 4,000 chars per
excerpt / 256 KiB total. The stack trace is cut to 3,000 chars after redaction,
keeping the error message and the application frames nearest the throw. Never
fetch full event JSON, attachments, breadcrumbs, request data or spans.
Pagination is cursor-based via `Link`, at most two pages [S19]. `429`/`401`/
transport fail the bundle; `404`/`403` on an optional resource sets
`truncated: true` and keeps the rest.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/sentry/{auth,webhook,incidents,context,redact}.ts` |
| Source enum | `sentry` already exists in `INCIDENT_SOURCES`; no contract change for the enum |
| Contract change required first | Add a vendor mode to `detectIncidentIntakeMode` and a Sentry trigger rule; both are shared transport changes, not adapter-local |
| Inbound | `verifySentryWebhook(rawBody, headers, secret)` → closed reason union |
| Normalize | `normalizeSentryIncident(payload)` → strict `IncidentSignal` |
| Reader | `fetchSentryIncidentContext(deps, input)` → `ContextBundle` |

**Agent tools** (registered server-side, never in the sandbox):

| Tool | Risk band | Notes |
|---|---|---|
| `sentry.fetch_issue_context` | `read_only` | Fixed query plan; audited |
| `sentry.resolve_issue` | `sensitive` | Out of scope; would require approval bound to `{issueId, action}` |

Under `createRiskTablePolicy`, `read_only` proceeds and is audited; `sensitive`
returns `APPROVAL_REQUIRED`. No Sentry tool may resolve an issue because a
validation command passed.

**Sandbox implications.** Tools execute in the worker, not the Modal sandbox.
The sandbox keeps egress denied and never sees `SENTRY_API_KEY`,
`SENTRY_WEBHOOK_SECRET` or an `Authorization` header. Results are bounded,
redacted and typed. Every call appends `audit_events` with `tool.execute`, the
tool name, risk, outcome and bounded target ids; never the token or provider
text.

**Tests.** Fake fetch and fixtures only: valid/tampered HMAC, missing
timestamp, unknown resource, `created` vs `resolved`, severity and fingerprint
tables, redaction seeds, cap/`truncated`, `429`/timeout, foreign `NOT_FOUND`.

## 7. Operator setup checklist

1. Choose the Sentry organization; confirm region (US or EU) and the plan.
2. Create one organization auth token with `event:read`, `project:read`,
   `org:read` and `project:releases`; omit `member:read`.
3. Create an internal integration with an issue webhook at
   `https://<host>/api/webhooks/sentry`; subscribe to `issue` only; copy the
   Client Secret once.
4. Record the org slug, project slug and region host; the signal service is the
   project slug, so the repository binding must map it.
5. Ship the shared Sentry mode and trigger policy first, then verify one test
   delivery creates one signal row, one task and a context section. Rotate by
   replacing the token and revoking the old one.

```dotenv
SENTRY_API_KEY=
SENTRY_BASE_URL=
SENTRY_ORG_ID=
SENTRY_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] `verifySentryWebhook` accepts a valid HMAC and rejects a tampered body,
      missing headers, unknown resource and oversize body without echoing a
      secret.
- [ ] `normalizeSentryIncident` creates signals only for `created`/`unresolved`
      and maps levels per §1.
- [ ] `fetchSentryIncidentContext` uses at most 4 calls, enforces 100 items /
      4,000 chars / 256 KiB, redacts before truncation, sets `truncated`, and
      returns `NOT_FOUND` for a foreign tenant; `429` fails closed.

One bounded live call, only after explicit authorization and key insertion:
fetch one named issue, latest event and release once; record item count, bytes
and any `truncated` flag. No retries. This vendor is not credit-funded.

## 9. Risks / never in model context

- Full event JSON: request headers, cookies, query strings, `user`, breadcrumbs,
  stack locals, transaction names, span attributes and tags [S18].
- PII (email, IP, user id, names, session ids), attachments and binary blobs.
  The 1 MB event limit [S17] is not a licence to send the event.
- Auth tokens, DSNs (a DSN can ingest events), source-map credentials,
  organization/project keys, webhook Client Secret. Full issue threads and
  arbitrary issue text are excluded; only allowlisted fields and a bounded
  stack trace. A stack trace is untrusted text and is rendered under the
  prompt's untrusted-data heading with `trustLevel: "untrusted"`.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Sentry pricing](https://sentry.io/pricing/) |
| S2 | [Pricing and billing](https://docs.sentry.io/pricing/) |
| S3 | [Data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/) |
| S4 | [API authentication](https://docs.sentry.io/api/auth/) |
| S5 | [API permissions](https://docs.sentry.io/api/permissions/) |
| S6 | [Integration platform webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/) |
| S7 | [Issue webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/) |
| S8 | [Retrieve an issue](https://docs.sentry.io/api/events/retrieve-an-issue/) |
| S10 | [Retrieve an issue event](https://docs.sentry.io/api/events/retrieve-an-issue-event/) |
| S11 | [Retrieve an event for a project](https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/) |
| S13 | [Retrieve an organization's release](https://docs.sentry.io/api/releases/retrieve-an-organizations-release/) |
| S14 | [List a release's deploys](https://docs.sentry.io/api/releases/list-a-releases-deploys/) |
| S16 | [Rate limits](https://docs.sentry.io/api/ratelimits/) |
| S17 | [Size limits](https://docs.sentry.io/concepts/data-management/size-limits/) |
| S18 | [Sensitive data](https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/) |
| S19 | [Pagination](https://docs.sentry.io/api/pagination/) |
| S20 | [Auth tokens](https://docs.sentry.io/account/auth-tokens/) |
