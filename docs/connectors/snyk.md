# Snyk connector

| Field | Value |
|---|---|
| Status | **Design only — no code exists in this repository** |
| Code | none — no code exists in this repository |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §1.2, §4 |
| Free tier verified | 2026-10-31 (Free plan exists; the REST API is documented as Enterprise-only) |
| Auth | Snyk API token, `Authorization: token <token>`, region-specific |
| Inbound | `project_snapshot/v0` webhook, `X-Hub-Signature` HMAC-SHA256 |
| Read | REST issues and projects in one organization |
| Writes | None in scope; future ignore/accept-risk is `scoped_write` |

Nothing below is implemented. Shared transport rules are in [README.md](README.md) §3.

## 1. Role in the agent

Snyk supplies dependency and SAST findings tied to a project and a fix version. The connector answers "which newly introduced issue is worth a task, in which project, and what upgrade removes it". It is not a scan runner, a report generator, a license-compliance tool or a replacement for GitHub security alerts.

| Kind | Trigger | Evidence added | Fix signal |
|---|---|---|---|
| `snyk_open_source` | New issue in `project_snapshot/v0` | Package, installed version, vulnerable range, CVE/CWE, exploit maturity | `fixedIn` versions, upgrade path |
| `snyk_code` | New Code issue in a snapshot | Rule id, path, line, CWE, severity | Remediation text, not source code |
| `snyk_container` | New container issue | Image, package, version | Base-image upgrade |

Severity comes from Snyk's `effective_severity_level` enum: `critical`, `high`, `medium`, `low`, `info` [S1]. Map one-to-one. Do not derive severity from CVSS or from the issue title. The production/default-branch gate remains platform policy: a new issue on a non-default branch is evidence, not automatically a task.

Fingerprint: `snyk:<org_id>:<project_id>:<issue_id>`, bounded to 128 characters. The issue id is the source-stable identity; the transport id is traceability only. A `removedIssues` entry never creates a task and never deletes a prior task.

## 2. Free tier and quotas

| Item | Free plan | Source |
|---|---|---|
| Price | $0/month | [S2] |
| Projects | 5 | [S2] |
| Snyk Open Source tests | 200/month on the pricing FAQ; 400/month on the usage-settings page | [S2], [S3] |
| Snyk Code tests | 100/month | [S2], [S3] |
| Snyk IaC tests | 300/month | [S2], [S3] |
| Snyk Container tests | 100/month | [S2], [S3] |
| Developers/users | No published Free seat cap; "individual developers and small teams"; Team is for up to 10 developers | [S2] |
| API access | **Not included**: "for free and team plan users, the personal token does not have access to the API" | [S4] |
| Webhooks | Plan availability not stated on the pages read — **UNVERIFIED** | [S5] |

Contradiction to resolve before build: Snyk's pricing FAQ says 200 Open Source tests/month for Free, while the current usage-settings page says 400 [S2], [S3]. Treat the in-product Usage page as authoritative and do not encode either number as a connector limit; the connector has no test quota of its own.

The decisive constraint is **API access**. Snyk documents the API as an Enterprise feature and states that Free and Team personal tokens work for IDE/CLI/CI authentication but not the API [S4]. Without the read API the connector cannot re-fetch a canonical alert, cannot build a context bundle and cannot verify that a webhook is still current. Therefore this connector is **gated on an Enterprise plan**; a Free or Team deployment is trigger-only at best and must not be enabled. Re-verify this before any implementation wave because plan packaging changes.

Public-vs-private: Snyk Free monitors public and private repositories within the 5-project cap, but a public repository does not make the API free. There is no "public repos only" carve-out for API access in the documentation read.

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Header | `Authorization: token <API_TOKEN>` [S4] |
| Token type | Service account token tied to one organization, preferred over a personal token; group service accounts only if cross-org reads are required [S4] |
| Region | The token is region-specific. Use `https://api.snyk.io/rest`, `https://api.us.snyk.io/rest`, `https://api.eu.snyk.io/rest` or `https://api.au.snyk.io/rest` matching the account [S6] |
| Storage | Server-only connector credential, encrypted at rest, keyed by `(organization, connector)`; never in a prompt or URL |
| Rotation | Create a second service account token, deploy it, verify one read, then revoke the first; tokens are long-lived, so rotation is scheduled, not automatic |

Requested permissions, taken from the OpenAPI description of `GET /orgs/{org_id}/issues` [S1]:

| Scope | Needed for |
|---|---|
| `org.read` | View the organization |
| `org.project.read` | List/read projects |
| `org.project.snapshot.read` | Read issue/snapshot history |

Do not request `org.edit`, `org.project.edit`, `org.project.test`, ignore-create or PR scopes. A Snyk App OAuth token uses different scope strings (`org.read`, `org.project.read`, `org.project.snapshot.read` are the same names in the Snyk Apps scope list [S7]); do not mix an App token with a service-account token.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `X-Hub-Signature: sha256=<hex>` [S5] |
| Algorithm | HMAC-SHA256 hex digest of the JSON request body [S5] |
| Signed timestamp | No. `X-Snyk-Timestamp` is sent but is **not** part of the signature [S5] |
| Replay control | Our own ±300 s window on `X-Snyk-Timestamp`, plus fingerprint dedupe; the timestamp is advisory because it is unsigned |
| Event header | `X-Snyk-Event`, required; reject a body that does not match it [S5] |
| Transport id | `X-Snyk-Transport-ID` (GUID), traceability only |
| Body cap | 64 KiB platform default |
| Retries | Not documented — **UNVERIFIED**; reconcile by polling rather than assuming delivery |

Only `project_snapshot/v0` creates a task; `ping/v0` is accepted as a no-op for webhook setup. A snapshot is sent on every test, with or without new issues, so the trigger must inspect `newIssues` and ignore an empty array. It is not sent when a project is created or imported [S5].

Accepted mapping:

- Each `newIssues[]` entry becomes one signal with kind `snyk_open_source`, `snyk_code` or `snyk_container` from `issueType`.
- `removedIssues[]` never creates or closes a task.
- A snapshot with many new issues can exceed 64 KiB. The route fails closed with `413`; the design proposes a dedicated 256 KiB cap for this path, never an unbounded read. A snapshot-level signal ("N new issues") is not a substitute because it loses the issue id needed for dedupe.

Dedupe: `(organization, source, fingerprint)` for 30 minutes, then the database bucket. The same issue reappearing after a fix gets the same fingerprint and is deduped only inside the window; after the window it can create a new task, which is correct for a regression.

## 5. Read-only context

Base URL is the region host plus `/rest`. Every request carries `?version=2024-10-15` (Snyk's recommended pin) [S6]. Responses are JSON:API with `data`, `links.next` and `meta`.

| # | Need | Endpoint | Fields / notes | Source |
|---|---|---|---|---|
| 1 | Issue detail | `GET /orgs/{org_id}/issues/{issue_id}?version=2024-10-15` | `key`, `title`, `type`, `status`, `effective_severity_level`, `created_at`, `updated_at`, `coordinates[]` (package, version, is_fixed), `problems[]` (id, source, updated_at) | [S1] |
| 2 | Project | `GET /orgs/{org_id}/projects/{project_id}?version=2024-10-15` | `name`, `type`, `target_reference`, `browse_url`, `attributes.criticality/environment/lifecycle` | [S1] |
| 3 | Open issues (reconcile) | `GET /orgs/{org_id}/issues?version=2024-10-15&status=open&effective_severity_level=critical,high&limit=50` | JSON:API `links.next` cursor; `limit` 10-100 in steps of 10 | [S1] |

Fixed plan: 3 calls maximum, one page each, 10 s timeout, 256 KiB response cap, 100 items, 4,000 characters per excerpt, 256 KiB total. The webhook already carries the new issue, so the common path is 2 calls; call 3 only to reconcile after a gap, never on every delivery. No model-authored query is possible: organization, project and issue ids are validated as UUIDs/opaque ids in trusted code.

Do not use the legacy v1 endpoint (`/v1/org/{orgId}/project/{projectId}/issue/{issueId}`) for new code; it is a different contract with different pagination. Do not fetch project dependency graphs, SBOMs, full source files or remediation pull requests. A `404` on the project is `NOT_FOUND`, not "foreign tenant"; a `403` is `POLICY_DENIED`.

## 6. Framework fit

Module `packages/integrations/src/snyk/`. Source enum value `"snyk"` must be added to `INCIDENT_SOURCES` in a contract commit **before** the adapter; the database column is `text` with a 32-character check, so no migration is required for the value.

| Function | Purpose | Risk |
|---|---|---|
| `verifySnykWebhook` | HMAC over raw bytes, event allowlist, timestamp window, 64 KiB cap | `read_only` transport |
| `normalizeSnykIssue` | `newIssues[]` -> `IncidentSignal`; severity and fingerprint | `read_only` |
| `fetchSnykIncidentContext` | Fixed 3-call plan -> `ContextBundle` | `read_only` |
| `snyk.ignore_issue` | Ignore one issue with a reason and expiry | `scoped_write` |
| `snyk.set_issue_severity` | Change severity | `scoped_write`, not proposed |

Writes need a separate token and a separate approval payload; ignore/accept-risk is a security decision, so the UI must show the issue id, project and reason, and the audit row must record the actor. Never make ignore a `read_only` convenience. Credential rotation and deploy are `sensitive` and are not connector tools.

Environment names:

```
SNYK_API_TOKEN=
SNYK_API_BASE_URL=
SNYK_ORG_ID=
SNYK_WEBHOOK_SECRET=
```

Sandbox implications: server-side reader only; sandbox egress deny; no Snyk token in the sandbox; redact before truncation; audit each write with `tool.execute`, target `snyk:org/project/issue`, outcome and reason code. Tests: signature valid/tampered/missing event/oversize; empty `newIssues`; `removedIssues` ignored; severity table; fingerprint replay; 64 KiB boundary; `403`, `404`, `429`, timeout; no email or token in error text.

## 7. Operator setup checklist

1. Confirm an Enterprise plan and an organization/region. Stop if the account is Free or Team: the API is not available there [S4].
2. Create a service account scoped to the organization with only `org.read`, `org.project.read`, `org.project.snapshot.read`.
3. Register the webhook for `project_snapshot/v0` only; set a random secret of at least 32 characters.
4. Record the organization id and the region base URL. The token and the base URL must match the same region.
5. Confirm at least one project has a snapshot with a new issue; do not run extra tests to create one.
6. Set the tenant binding used by the existing intake (`WEBHOOK_ORGANIZATION_ID`, `WEBHOOK_REPOSITORY_ID`, workflow definition/version).
7. Apply the variables below and restart. Do not paste a value into a prompt, fixture or ticket.
8. Send one webhook test (`ping`) and one real snapshot; verify one signal and one task, then a redelivery that dedupes.

```
SNYK_API_TOKEN=
SNYK_API_BASE_URL=
SNYK_ORG_ID=
SNYK_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Signature valid/tampered; missing `X-Snyk-Event`; oversize body -> `413`.
- [ ] Empty `newIssues` creates nothing; `removedIssues` creates nothing.
- [ ] Severity mapping and fingerprint table tests; same issue replay dedupes.
- [ ] `limit` and cursor handling stop at one page and the item cap.
- [ ] No token, email or raw issue description in logs, errors or bundle.

Live (explicit authorization, one bounded call):

- [ ] One `GET /orgs/{org_id}/issues/{issue_id}` for a known issue, once, no retry.
- [ ] Record the issue key, status and severity class; confirm the response has no secret or source body.
- [ ] Do not run a scan or a second read after success.

## 9. Risks and what must never enter model context

- Service-account tokens, webhook secrets, organization/group membership lists.
- `project.importingUser.email` and any assignee/owner email; usernames only.
- Full issue `description`, remediation prose, code snippets, dependency graphs, SBOM dumps and report exports.
- Ignore reasons or comments authored by users: treat as untrusted text and cap them.
- The connector must never run a Snyk test, create a project, open a PR or change a project's settings.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Snyk REST API: issues](https://docs.snyk.io/developer-tools/snyk-api/reference/issues) |
| S2 | [Snyk plans and pricing](https://snyk.io/plans/) |
| S3 | [Snyk usage settings (Free limits)](https://docs.snyk.io/platform-administration/snyk-hierarchy/usage-settings) |
| S4 | [Snyk API authentication](https://docs.snyk.io/developer-tools/snyk-api/authentication-for-api) |
| S5 | [Snyk webhook events and payloads](https://docs.snyk.io/developer-tools/snyk-api/using-specific-snyk-apis/webhooks-apis/webhooks) |
| S6 | [About the Snyk REST API (versions and regions)](https://docs.snyk.io/developer-tools/snyk-api/rest-api/about-the-rest-api) |
| S7 | [Snyk App scopes](https://docs.snyk.io/developer-tools/snyk-api/using-specific-snyk-apis/snyk-apps-apis/scopes-to-request) |
