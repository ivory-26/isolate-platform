# GitHub security alerts connector

| Field | Value |
|---|---|
| Status | **Design only — no code exists in this repository** |
| Code | none — no code exists in this repository |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §1.2, §3.1, §4 |
| Free tier verified | 2026-10-31 (public repos free; private repos need paid GitHub Secret Protection / Code Security) |
| Auth | Dedicated GitHub App, read-only security permissions, repository-scoped installation token |
| Inbound | `dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`, `secret_scanning_alert_location` |
| Read | Dependabot, code scanning and secret scanning alert REST endpoints |
| Writes | None in scope; future dismiss/resolve tools are `scoped_write` and a separate wave |

Nothing below is implemented. This page is the build plan and the verified vendor facts; it must not be read as implemented behavior. Shared transport rules are in [README.md](README.md) §3; the existing CI connector is [github.md](github.md).

## 1. Role in the agent

This connector answers "what security defect is open in this repository, where is it, and what fixes it" for three GitHub alert families. It is not a code fetcher, a SARIF store, a secret viewer or a vulnerability database.

| Kind | Trigger | Evidence added to the bundle | Fix signal |
|---|---|---|---|
| `dependabot_alert` | New/reopened vulnerable dependency | Advisory id, package, manifest path, vulnerable range, CVSS, severity | `first_patched_version` |
| `code_scanning_alert` | New/reopened CodeQL or third-party SAST alert | Rule id/name, security severity, tool, path and line range, one instance | Rule help link, not full code |
| `secret_scanning_alert` | New/reopened leaked credential | Secret type/display name, validity, public-leak flag, file path and line | Revoke and rotate; never the value |

Severity mapping is connector policy, recorded in trusted code:

| Provider field | Value | `IncidentSeverity` |
|---|---|---|
| Dependabot `security_advisory.severity` | `critical` / `high` / `medium` / `low` | same value |
| Code scanning `rule.security_severity_level` | `critical` / `high` / `medium` / `low` | same value |
| Code scanning fallback `rule.severity` | `error` / `warning` / `note` / `none` | `high` / `medium` / `low` / `info` |
| Secret scanning, no vendor severity | `validity=active` or `publicly_leaked=true` | `critical` |
| Secret scanning, no vendor severity | `validity=unknown` or `no_checker` | `high` |
| Secret scanning, no vendor severity | `validity=inactive` | `medium` |

Secret-scanning severity is a platform policy, not a GitHub field; make it configurable per organization and show the rule in the audit row. A high-severity code-scanning alert on a feature branch must not create a task unless the repository policy says so; the existing production/default-branch gate in `evaluateIncidentTrigger` still applies.

Fingerprints are source-stable and bounded to 128 characters:

- `github-security:<owner/repo>:dependabot:<alert_number>:<ghsa_id>`
- `github-security:<owner/repo>:code-scanning:<alert_number>:<rule_id>`
- `github-security:<owner/repo>:secret-scanning:<alert_number>:<secret_type>`

The alert number is the primary identity; the rule/advisory/type is the required second component so a rule change on the same number is visible rather than silently merged. The delivery id is traceability only.

## 2. Free tier and quotas

| Feature | Public repository | Private repository | Source |
|---|---|---|---|
| Dependabot alerts | Free | Free | [S1] |
| Code scanning (CodeQL default setup or SARIF upload) | Free by default | Requires GitHub Code Security | [S1] |
| Secret scanning alerts for users | Free by default | Requires GitHub Secret Protection | [S1] |
| Push protection | Public-repo user protection is free | Requires Secret Protection | [S1] |
| Validity checks, AI-detected secrets, custom patterns | Not confirmed free | Secret Protection | [S1], [S4] |
| Premium Dependabot features, dependency review, Copilot Autofix | Not applicable | Code Security | [S1], [S4] |

Prices, verified 2026-10-31: GitHub Secret Protection **$19 per active committer per month**; GitHub Code Security **$30 per active committer per month**; both are sold to GitHub Team and GitHub Enterprise Cloud organizations, not to GitHub Free organizations [S2], [S4]. An "active committer" is a unique committer to a selected repository in the last 90 days; shared committers across repositories are counted once per month [S5]. These are list prices; taxes, annual terms and reseller pricing are out of scope.

Public-vs-private caveat: this connector works on a private repository only when the organization has bought the matching product and enabled the feature. Do not infer entitlement from a successful `200`; a `403` can mean "feature not enabled for this repository". A GitHub Free organization cannot buy either product, so private-repo coverage requires a plan change, not a connector setting.

Retention and limits:

| Constraint | Value | Handling |
|---|---|---|
| Alert retention | Alerts persist until fixed, dismissed or resolved; code-scanning analysis/SARIF retention is not stated on the pages read — **UNVERIFIED** | Use the alert, never a historical corpus |
| Installation token rate limit | 5,000 requests/hour; 15,000/hour on Enterprise Cloud [S6] | One bundle <= 6 calls; no retry loop |
| Pagination | `per_page` max 100, `Link` headers [S7] | One page per resource; stop at caps |
| Webhook payload cap | GitHub caps payloads at 25 MB [S8] | Our receiver still enforces 64 KiB, see §4 |

## 3. Auth and least privilege

Use a **separate GitHub App** from the CI/PR App so security reads never share a credential with `contents:write` or `actions:write`.

| Permission (App key) | Level | Needed for | Source |
|---|---|---|---|
| `vulnerability_alerts` ("Dependabot alerts") | read | Dependabot alert REST + `dependabot_alert` webhook | [S3], [S9] |
| `security_events` ("Code scanning alerts") | read | Code scanning alert REST + `code_scanning_alert` webhook | [S3], [S10] |
| `secret_scanning_alerts` ("Secret scanning alerts") | read | Secret scanning alert REST + both secret webhooks | [S3], [S11] |
| `metadata` | read | Repository metadata; implicit for every App | [S3] |

Do not request `contents`, `actions`, `checks`, `issues`, `administration` or any write level for this App. The reader mints one repository-scoped installation token per bundle using the existing `createGitHubAppTokenProvider` (`packages/integrations/src/github/auth.ts`); the token expires after one hour and is cached only until `expires_at - 300 s`. A private key rotation is: create a second App private key, deploy it, verify one read, then delete the old key. Revoke the installation if a repository leaves scope.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `X-Hub-Signature-256: sha256=<64 hex>` [S12] |
| Algorithm | HMAC-SHA256 over the raw request body; constant-time compare |
| Signed timestamp | No; GitHub signs the body only |
| Replay control | Delivery id recorded for traceability; dedupe by fingerprint in a 30-minute bucket |
| Body cap | 64 KiB platform default; GitHub allows 25 MB [S8] |
| Retries | GitHub does not retry failed deliveries automatically; an operator can redeliver manually [S13] |
| Dedupe | `(organization, source, fingerprint)`, 30 minutes, then the database signal bucket |

Accepted actions (everything else is `202 {accepted:false}` and creates nothing):

| Event | Accepted actions | Notes |
|---|---|---|
| `dependabot_alert` | `created`, `reopened`, `reintroduced` | `fixed`, `dismissed`, `auto_dismissed`, `assignees_changed` are ignored |
| `code_scanning_alert` | `created`, `reopened`, `reopened_by_user` | `appeared_in_branch` only when the ref is the default branch; `fixed`, `closed_by_user` ignored |
| `secret_scanning_alert` | `created`, `reopened` | `resolved`, `revoked`, `assigned` ignored |
| `secret_scanning_alert_location` | `created` | Do not open a second task; the parent alert fingerprint wins |

The action names above are the GitHub-maintained webhook types [S14] plus `assigned` observed on the current event page [S15]; enforce an explicit allowlist and reject unknown actions rather than guessing.

Structural redaction happens **before** normalization: drop `alert.secret` (secret scanning webhooks can include the literal secret), `alert.rule.help`, `alert.rule.full_description`, `alert.most_recent_instance.message` beyond the cap, and every `repository` field except `full_name`, `html_url`, `default_branch`. The raw body is never persisted.

The 64 KiB cap is a real risk: a code-scanning payload embeds the rule and can exceed it. The design is fail-closed (`413`, no task) until a contract change adds a dedicated, still-bounded cap (proposed 256 KiB) for the security route. Never raise the shared cap for every connector.

## 5. Read-only context

One token, fixed query plan, no model-authored URLs. Base `https://api.github.com`, headers `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.

| # | Need | Endpoint | Allowlisted fields | Source |
|---|---|---|---|---|
| 1 | Repository | `GET /repos/{owner}/{repo}` | `full_name`, `html_url`, `default_branch` | [S16] |
| 2 | Dependabot alert | `GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}` | `number`, `state`, `html_url`, `security_advisory.ghsa_id`, `.severity`, `.summary`, `.cvss.score`, `dependency.package.name`, `dependency.manifest_path`, `security_vulnerability.vulnerable_version_range`, `security_vulnerability.first_patched_version` | [S9] |
| 3 | Code scanning alert | `GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}` | `number`, `state`, `html_url`, `rule.id`, `.name`, `.security_severity_level`, `.severity`, `tool.name`, `most_recent_instance.location.path`, `.start_line`, `.end_line`, `most_recent_instance.ref` | [S10] |
| 4 | Code scanning instances | `GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances?per_page=5` | `ref`, `commit_sha`, `location.path`, `start_line`, `end_line`; max 5 | [S10] |
| 5 | Secret scanning alert | `GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}?hide_secret=true` | `number`, `state`, `html_url`, `secret_type`, `secret_type_display_name`, `validity`, `publicly_leaked`, `multi_repo`, `created_at`, `first_location_detected`, `locations_url` | [S11] |
| 6 | Secret locations | `GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}/locations?per_page=10` | `type`, `details.path`, `start_line`, `end_line`; never issue/PR/wiki URLs | [S11] |

`hide_secret` defaults to **false**, and the alert schema documents `secret` as "the secret that was detected" [S11]. Always send `hide_secret=true` **and** delete the field from the parsed object; a provider default is not a security control. The locations endpoint has no `hide_secret` parameter, so do not follow any URL inside a location object.

Caps: 6 calls, 10 s per call, 256 KiB per response, 100 items, 4,000 characters per excerpt, 256 KiB total excerpt bytes. A `403`/`404` on an optional call sets `truncated: true` and returns the partial bundle. A `429` or transport failure fails the bundle with a bounded code and no provider text. Never call the SARIF download endpoint, the blob API, the alert's file path, or a location URL that leads to an issue/PR body.

## 6. Framework fit

Proposed module `packages/integrations/src/github-security/`; reuse `redact.ts`, `rest-client.ts` and `auth.ts` rather than copying them.

**Contract first, adapter second.** Add `"github_security"` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a contract commit before any adapter code. `incident_signals.source` is `text` with a 32-character check (`0009_incidents.sql`), so no migration is needed for the value; the web intake's mode detection and event allowlist still need code changes. Extend `ToolName` and `SANDBOX_TOOL_RISKS` in the same contract commit if writes are proposed.

Proposed functions:

| Function | Purpose | Risk |
|---|---|---|
| `verifyGitHubSecurityWebhook` | Reuse `verifyGitHubWebhook`; assert the event is one of the four | `read_only` transport |
| `normalizeGitHubSecurityAlert` | Allowlist payload -> `IncidentSignal`; severity and fingerprint | `read_only` |
| `fetchGitHubSecurityIncidentContext` | Fixed 6-call plan -> `ContextBundle` | `read_only` |
| `github.dismiss_dependabot_alert` | `PATCH` alert state, separate token | `scoped_write` |
| `github.dismiss_code_scanning_alert` | `PATCH` alert state, separate token | `scoped_write` |
| `github.resolve_secret_scanning_alert` | `PATCH` resolved + reason, separate token | `scoped_write` |

Secret rotation, key revocation and deploy are `sensitive` and out of scope: never expose them as tools. Dismiss/ignore/accept-risk is `scoped_write` under `createRiskTablePolicy` (executes audited, no second approval); if the user wants approval-bound dismissal, the policy table needs an explicit per-tool decision, not a model instruction.

Environment names (names only; values are server-side):

```
GITHUB_SECURITY_APP_ID=
GITHUB_SECURITY_APP_INSTALLATION_ID=
GITHUB_SECURITY_APP_PRIVATE_KEY_PATH=
GITHUB_SECURITY_API_BASE_URL=
WEBHOOK_GITHUB_SECURITY_SECRET=
```

Sandbox implications: the reader runs in the worker, never in the sandbox; the sandbox has egress deny and receives no GitHub credential. Only the derived, redacted bundle enters the prompt. Every write appends one `audit_events` row (`tool.execute`) with tool, risk, outcome and target; never the alert body, secret type details or token.

Tests (fakes only): signature valid/tampered/oversize; each event/action table row; secret field dropped from a fixture that contains one; severity mapping; fingerprint stability across redelivery; `hide_secret=true` asserted on every secret call; caps and `truncated`; `403`, `404`, `429`, timeout; tenant isolation; no token or secret in any error string.

## 7. Operator setup checklist

1. Decide the plan: public repositories need nothing; private repositories need Code Security (code scanning) and/or Secret Protection (secret scanning). Dependabot alerts are free.
2. Create one GitHub App per environment with only the read permissions in §3; install it on the selected repositories.
3. Generate a PKCS#8 private key, store it in a server-side file, and record the App id and installation id.
4. Enable Dependabot alerts, code scanning default setup, and secret scanning for the repositories. Confirm one open alert of each kind exists before testing.
5. Create the App webhook with a random secret of at least 32 characters; subscribe only to the four events. Point it at the dedicated security route (proposed `POST /api/webhooks/github-security`).
6. Set the tenant binding (`WEBHOOK_ORGANIZATION_ID`, `WEBHOOK_ACTOR_ID`, `WEBHOOK_REPOSITORY_ID`, workflow definition/version). These are existing names; do not read them from the payload.
7. Add the variables below, then restart. Never paste a value into a prompt, ticket or fixture.
8. Deliver one test alert and verify one signal, one task, one bundle, zero secret material. Redeliver once and verify dedupe.

```
GITHUB_SECURITY_APP_ID=
GITHUB_SECURITY_APP_INSTALLATION_ID=
GITHUB_SECURITY_APP_PRIVATE_KEY_PATH=
GITHUB_SECURITY_API_BASE_URL=
WEBHOOK_GITHUB_SECURITY_SECRET=
```

## 8. Acceptance checklist

Offline (required before merge):

- [ ] A fixture for each of the four events creates exactly one signal; an unknown action creates none.
- [ ] A fixture containing `alert.secret` produces a signal and bundle with no secret substring.
- [ ] Secret reads send `hide_secret=true`; a fake response with `secret` still yields no secret in the bundle.
- [ ] Severity table and fingerprint rules are table-tested; redelivery maps to the same fingerprint.
- [ ] Caps, `truncated`, `403`/`404` partial bundle, `429` and timeout are tested with a fake fetch.
- [ ] No test or error output contains a token, private key or secret value.

Live (only with explicit authorization, one bounded call):

- [ ] One real alert of one kind is read once, with `per_page` small, no retry, and the measured alert number recorded.
- [ ] Confirm the response contains no `secret`, raw SARIF or file body.
- [ ] Record result and time; do not run a second provider call after success.

## 9. Risks and what must never enter model context

- `alert.secret` from a secret scanning webhook, or the `secret` field from any alert response.
- The contents of `/occurrences/.../content`, issue/PR titles or bodies that may quote a secret, and wiki pages.
- Raw SARIF, `rule.help`/`full_description` free text, full source files, blobs, diffs and code snippets beyond the alert path/line.
- App private key, JWT, installation token, `Authorization` header, webhook secret.
- Author/committer emails; use usernames or omit. Dependabot `security_advisory.description` and references are free text: use `summary` and the advisory id.
- Provider status text is untrusted data; it cannot select a tool, change severity, or approve a dismissal.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [GitHub security features](https://docs.github.com/en/code-security/getting-started/github-security-features) |
| S2 | [GitHub security plans](https://github.com/security/plans) |
| S3 | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) |
| S4 | [Introducing Secret Protection and Code Security](https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/) |
| S5 | [Estimating Secret Protection price](https://docs.github.com/en/code-security/how-tos/secure-at-scale/configure-organization-security/configure-specific-tools/estimating-the-price-of-secret-protection) |
| S6 | [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| S7 | [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) |
| S8 | [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |
| S9 | [Dependabot alerts REST API](https://docs.github.com/en/rest/dependabot/alerts) |
| S10 | [Code scanning REST API](https://docs.github.com/en/rest/code-scanning/code-scanning) |
| S11 | [Secret scanning REST API](https://docs.github.com/en/rest/secret-scanning/secret-scanning) |
| S12 | [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) |
| S13 | [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) |
| S14 | [GitHub webhook types (octokit)](https://github.com/octokit/webhooks) |
| S15 | [Webhook events: dependabot_alert](https://docs.github.com/en/webhooks/webhook-events-and-payloads#dependabot_alert) |
| S16 | [Repository REST API](https://docs.github.com/en/rest/repos/repos) |
