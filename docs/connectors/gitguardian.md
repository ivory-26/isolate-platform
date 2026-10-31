# GitGuardian connector

| Field | Value |
|---|---|
| Status | **Design only — no code exists in this repository** |
| Code | none — no code exists in this repository |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §1.2, §4 |
| Free tier verified | 2026-10-31 (Starter: up to 25 devs, 500 historical scan detections, 10K API calls/month) |
| Auth | GitGuardian API token, `Authorization: Token <token>`, scope `incidents:read` |
| Inbound | Custom webhook, `Gitguardian-Signature` HMAC-SHA256 with `Timestamp` |
| Read | Secret incidents and their file locations |
| Writes | None in scope; future resolve/ignore is `scoped_write`; secret rotation is `sensitive` |

Nothing below is implemented. Shared transport rules are in [README.md](README.md) §3.

## 1. Role in the agent

GitGuardian detects credentials in source, history and public repositories. The connector answers "which secret type leaked, where, is it still valid, and is it public" and hands the agent a remediation task that **never contains the secret**. It is not a secret store, a validity oracle that reveals credentials, or an auto-rotation tool.

| Kind | Trigger | Evidence added | Fix signal |
|---|---|---|---|
| `gitguardian_secret_incident` | `incident_triggered` | Detector name/display, secret type, validity, status, severity, public-leak flag, file path and line | Revoke, rotate, purge history |
| `gitguardian_public_incident` | Public monitoring incident | Repository/source, first seen, validity | Revoke and notify |

Severity is GitGuardian's `critical`, `high`, `medium`, `low`, `info` or `unknown` [S1]. Map the first five one-to-one; map `unknown` to `medium` and record that the vendor had no severity. Validity is a separate axis: `valid` (live credential), `invalid`, `failed_to_check`, `no_checker`, `unknown` [S1]. A live credential (`valid`) should be `critical` even if the incident severity is lower, because the blast radius is active; make that policy explicit and configurable.

Fingerprint: `gitguardian:<workspace_slug>:<incident_id>:<detector_name>`, bounded to 128 characters. The incident id is the identity; the detector name is required so a reclassified incident is visible. The webhook has no delivery id; the receiver's own dedupe is the only replay control.

## 2. Free tier and quotas

| Item | Starter (Free) | Source |
|---|---|---|
| Price | $0, no credit card | [S2] |
| Developers | Up to 25 | [S2] |
| Real-time scanning | Unlimited | [S2] |
| Historical scan detection | Up to 500 | [S2] |
| API calls | 10,000/month | [S2] |
| Repositories | Public repositories under the GitHub organization; private repositories within the dev cap | [S2] |
| Custom detectors | Not included | [S2] |
| Endpoint scanning | Not included | [S2] |
| Webhooks | Available for a personal workspace per the setup guide; plan gating is not stated — **UNVERIFIED** | [S3] |

"Developer" is defined as an active contributor to a secured project with at least one commit in the last 90 days [S2]. The 500 historical scan detections are a one-time backfill allowance, not a monthly quota; do not spend them on connector tests.

Public-vs-private: public repositories are monitored under the GitHub organization; private repository coverage is bounded by the 25-developer cap. Neither makes secret **values** available; the API returns metadata and separately exposes a content endpoint that must never be called.

Limits:

| Constraint | Value | Handling |
|---|---|---|
| API calls | 10,000/month on Free | 2 calls per task; no polling loop |
| API rate limit (per minute/hour) | Not stated on the pages read — **UNVERIFIED** | One bounded retry on `429` only after `Retry-After` |
| Pagination | `page`/`per_page` plus `Link`, `X-Total-Pages`, `X-Next-Page` headers [S1] | One page per bundle |
| Retention | Plan-dependent; not stated on the pages read — **UNVERIFIED** | Use the incident, never a historical corpus |

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Header | `Authorization: Token <API_TOKEN>` [S4] |
| Token type | Service account token, tied to the workspace; preferred over a personal token for automation [S4] |
| Scopes | `incidents:read` only. Do **not** request `secrets:read` or `secrets:write`: the content endpoint that returns clear-text secrets is gated by those scopes and is never needed | [S4] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second service account token, deploy it, verify one read, revoke the first |

Some GitGuardian endpoints accept only a personal access token and refuse service accounts [S1]. The incident list and detail endpoints are intended for automation; verify the chosen token type against them in the sandbox before enabling the connector. Never grant a token workspace-administration or scan-trigger scope.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `Gitguardian-Signature: sha256=<hex>`; the older `X-GitGuardian-Signature` is deprecated but still sent [S3] |
| Algorithm | HMAC-SHA256 hex digest of the request payload [S3] |
| HMAC key | The string concatenation `timestamp + signature_token`, where `signature_token` is the secret configured in the webhook settings [S3] |
| Timestamp header | `Timestamp`; counters replay. GitGuardian suggests dropping a request whose timestamp differs by more than a few seconds [S3] |
| Replay window | Enforce ±300 s; the vendor gives no exact tolerance |
| Body cap | 64 KiB platform default; an incident with many censored `matches` can exceed it |
| Retries | Delivery is best effort; GitGuardian explicitly does not guarantee it [S3] |
| Dedupe | Incident id + detector name; no delivery id is supplied |

Only `incident_triggered` creates a task. `incident_resolved`, `incident_assigned`, `incident_severity_changed` and `incident_risk_score_updated` are evidence updates and are ignored for task creation. The payload includes `incident.matches[]` with `match: "--censored--"` [S3]; drop the entire `matches` array before normalization, and never log the raw body. A payload that exceeds 64 KiB is `413` and creates nothing; the design proposes a dedicated 256 KiB cap for this route and an explicit truncation flag, never an unbounded read.

Because delivery is not guaranteed and there is no delivery id, a missed webhook is invisible. Reconcile with one API list call filtered by `date_after` on a schedule the operator sets; do not run it inside the webhook request.

## 5. Read-only context

Base `https://api.gitguardian.com`, header `Authorization: Token <token>`. The current path is `/v1/incidents/secrets`; older material that shows `/v1/incidents` is stale and must not be used [S1].

| # | Need | Endpoint | Fields / notes | Source |
|---|---|---|---|---|
| 1 | Incident detail | `GET /v1/incidents/secrets/{incident_id}` | `id`, `date`, `detector.name/display_name/family`, `secret_hash`, `occurrences_count`, `status`, `severity`, `validity`, `publicly_leaked`, `secret_revoked`, `gitguardian_url` | [S1] |
| 2 | Locations | `GET /v1/incidents/secrets/{incident_id}/locations` | `filepath`, `matches[].line_start/line_end`, `number_of_mentions`, `last_updated_at`; no secret value | [S1] |
| 3 | Reconcile | `GET /v1/incidents/secrets?status=TRIGGERED&severity=critical,high&per_page=20&date_after=<iso>` | Cursor or page pagination; filter narrowly | [S1] |

Fixed plan: 2 calls for the common path (3 on reconcile), one page each, 10 s timeout, 256 KiB response cap, 100 items, 4,000 characters per excerpt, 256 KiB total. Allowed `status` values are `IGNORED`, `TRIGGERED`, `ASSIGNED`, `RESOLVED`; `severity` is `critical`, `high`, `medium`, `low`, `info`, `unknown`; `validity` is `valid`, `invalid`, `failed_to_check`, `no_checker`, `unknown` [S1].

Never call `GET /v1/occurrences/secrets/{occurrence_id}/content`: the vendor documents that it "shows the secret in clear text" and may retain the content even after the commit is removed from history [S1]. Never follow an issue/PR/wiki link from a location object, and never request a `share_url` or a vault path. The incident list and detail responses expose `secret_hash`, not the secret; keep it out of prompts anyway because it is a stable correlation identifier.

## 6. Framework fit

Module `packages/integrations/src/gitguardian/`. Add `"gitguardian"` to `INCIDENT_SOURCES` in a contract commit **before** the adapter; no migration is needed for the value.

| Function | Purpose | Risk |
|---|---|---|
| `verifyGitGuardianWebhook` | HMAC key `timestamp + secret`, `Timestamp` window, 64 KiB cap | `read_only` transport |
| `normalizeGitGuardianIncident` | `incident_triggered` -> `IncidentSignal`; severity/validity and fingerprint | `read_only` |
| `fetchGitGuardianIncidentContext` | 2-call plan -> `ContextBundle` | `read_only` |
| `gitguardian.resolve_incident` | Mark resolved with reason and comment | `scoped_write` |
| `gitguardian.ignore_incident` | Ignore with reason and expiry | `scoped_write` |
| Secret rotation, revocation, vault write | Rotate a credential or write a vault | `sensitive`; out of scope, never a tool in this wave |

Resolve/ignore is `scoped_write` under the existing policy (audited, no second approval). If the user wants a human approval before dismissing a live credential, add a per-tool policy decision; never encode that in the prompt. Secret rotation must be a separate approval-bound flow with a payload bound to the incident id and the target system.

Environment names:

```
GITGUARDIAN_API_TOKEN=
GITGUARDIAN_API_BASE_URL=
GITGUARDIAN_WORKSPACE_SLUG=
GITGUARDIAN_WEBHOOK_SECRET=
```

Sandbox implications: server-side reader only; sandbox egress deny; the sandbox never receives the GitGuardian token or any secret material. Redact before truncation; audit each write with `tool.execute`, target `gitguardian:incident/<id>`, outcome and reason code. Tests: signature with the timestamp-in-key formula; stale timestamp; malformed `sha256=` prefix; incident triggered vs resolved; severity/validity table; fingerprint replay; `matches` dropped; content endpoint never called (fake fetch assertion); page caps; `401`/`403`/`429`/timeout; no secret hash or token in output.

## 7. Operator setup checklist

1. Confirm the workspace is on Starter (25 devs) or a paid plan, and that the incident to test already exists.
2. Create a service account token with only `incidents:read`; record the workspace slug.
3. Create a custom webhook in the workspace (personal or business) and copy the signature token; subscribe to `incident_triggered` only.
4. Verify the HMAC formula against the vendor's Python/JS example using a captured test delivery before enabling the route.
5. Set the tenant binding (`WEBHOOK_ORGANIZATION_ID`, `WEBHOOK_REPOSITORY_ID`, workflow definition/version); the incident's repository must map to the bound repository.
6. Add the variables below and restart; never paste a value into a prompt, ticket, log or fixture.
7. Send the webhook test once, then one real `incident_triggered`; verify one signal, one task and no secret value.
8. Redeliver once to prove fingerprint dedupe; confirm the API reconcile path returns the same incident.

```
GITGUARDIAN_API_TOKEN=
GITGUARDIAN_API_BASE_URL=
GITGUARDIAN_WORKSPACE_SLUG=
GITGUARDIAN_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] HMAC over payload with key `timestamp + secret`; tampered body, stale timestamp and wrong prefix rejected.
- [ ] `incident_triggered` maps; resolved/assigned/severity-changed create nothing.
- [ ] `matches` is absent from every signal and bundle; `secret_hash` is absent from prompt text.
- [ ] The client refuses to call `/occurrences/.../content` (assert the URL allowlist).
- [ ] Severity/validity table, fingerprint replay, caps, `401`/`403`/`429`/timeout.

Live (explicit authorization, one bounded call):

- [ ] One incident detail read and one locations read for a known incident, once, no retry.
- [ ] Record incident id, detector and validity; confirm no secret value or clear-text content in the response.
- [ ] Do not call the content endpoint, do not resolve/ignore, do not trigger a scan.

## 9. Risks and what must never enter model context

- Any secret value, `occurrence.content`, `matches[].match`, vault contents, `share_url`, or a screenshot of the dashboard.
- `secret_hash` and `gitguardian_url` containing a workspace id; the URL is display-only at most.
- API tokens, webhook signature tokens, service-account identities and workspace membership.
- Incident comments, assignee emails and free-text remediation notes; treat as untrusted and cap them.
- The connector must never revoke, rotate, create or move a secret; those are `sensitive` actions in a separate approval-bound flow.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [GitGuardian API reference (OpenAPI 1.1.0)](https://api.gitguardian.com/docs) |
| S2 | [GitGuardian pricing](https://www.gitguardian.com/pricing) |
| S3 | [GitGuardian custom webhook](https://docs.gitguardian.com/platform/configure-alerting/notifiers-integrations/custom-webhook) |
| S4 | [GitGuardian API authentication](https://docs.gitguardian.com/api-docs/authentication) |
