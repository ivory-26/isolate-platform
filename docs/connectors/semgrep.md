# Semgrep connector

| Field | Value |
|---|---|
| Status | **Design only — no code exists in this repository** |
| Code | none — no code exists in this repository |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §1.3, §4 |
| Free tier verified | 2026-10-31 (Semgrep OSS free; Free Edition capped at 10 contributors and 10 private repos) |
| Auth | Semgrep AppSec Platform token, `Authorization: Bearer <token>` |
| Inbound | Semgrep webhook, `X-Semgrep-Signature-256` HMAC-SHA256 |
| Read | Findings API and project list for one deployment |
| Writes | None in scope; future triage/ignore is `scoped_write` |

Nothing below is implemented. Shared transport rules are in [README.md](README.md) §3.

## 1. Role in the agent

Semgrep provides SAST and supply-chain findings from a scan that already ran. The connector answers "which rule matched which file on which ref, at what severity, and what does the rule say to do". It does not run scans, install rules, upload SARIF on the agent's behalf, or fetch repository code.

| Kind | Trigger | Evidence added | Fix signal |
|---|---|---|---|
| `semgrep_code` | `semgrep_finding` | `check_id`, rule name, path, start/end line, severity, CWE/OWASP tags | Rule message and references |
| `semgrep_supply_chain` | `semgrep_supply_chain_incident` | Package, version range, advisory id, reachability if present | Upgrade path |
| `semgrep_scan` | `semgrep_scan` | Scan metadata only | No task; ignored |

Severity is `Critical`, `High`, `Medium` or `Low` in current rules and findings [S1]. Legacy rule values map as `ERROR -> high`, `WARNING -> medium`, `INFO -> low` [S1]. The webhook example carries a numeric `severity` field; its numeric encoding is not documented on the page read — **UNVERIFIED**, so do not map it. Normalize webhook severity from `metadata`/rule data only after confirming the field against a real payload; otherwise re-fetch the finding through the API, where severity is a string.

Fingerprint: `semgrep:<deployment_slug>:<finding_id>:<check_id>`, bounded to 128 characters. Semgrep already suppresses repeat notifications for the same finding, but the receiver must still dedupe: `finding_id` is the identity, `check_id` catches a rule change, and the transport delivery id is traceability only.

## 2. Free tier and quotas

| Item | Semgrep OSS (Community Edition) | Semgrep AppSec Platform Free Edition | Source |
|---|---|---|---|
| Price | Free, LGPL-2.1 | $0 for up to 10 contributors | [S3], [S9] |
| Private repositories | Scan any repo you can clone | 10 maximum | [S3] |
| Public repositories | Unlimited | Unlimited | [S3] |
| Contributors | Not applicable | 10 maximum | [S3] |
| Code (SAST) | CLI engine, community rules | Pro engine and Pro rules | [S3] |
| Supply Chain | Not included | Included | [S3] |
| Secrets | Not included | Not included on Free (paid product); exact free availability is **UNVERIFIED** | [S3] |
| AI credits | None | 60 included | [S3] |
| Findings retention | Local only | Plan-dependent; not stated on the pages read — **UNVERIFIED** | [S3] |

The OSS CLI is free and can emit SARIF locally, but it has no hosted findings API and no webhook. The Free Edition adds the platform, Pro rules and cross-file analysis for small teams. The contributor cap is a licensing limit, not a technical one: do not build a connector that assumes it can add contributors or repositories beyond 10 on Free.

Public-vs-private: unlimited public repositories do not imply unlimited private scanning on Free. A deployment that exceeds 10 private repositories is a plan change, not a connector setting.

Quotas and limits:

| Constraint | Value | Handling |
|---|---|---|
| Findings API page size | 100-3000 per page | Request 100; one page per bundle |
| API rate limit | Not stated on the pages read — **UNVERIFIED** | One reconcile call per task; back off on `429` |
| Webhook rate/retry | Not stated — **UNVERIFIED** | Do not assume delivery; reconcile by API |
| Token scopes | `Agent (CI)`, `Web API`, `Member`, `Read-only` [S4] | Use `Web API` with the least-privilege role |

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Header | `Authorization: Bearer <SEMGREP_API_TOKEN>` [S5] |
| Token type | Deployment access token with the `Web API` scope; use a read-only member role for the reader [S4] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second token, deploy it, verify one read, revoke the first; tokens do not expire automatically |
| CI token | The `Agent (CI)` scope cannot use the Web API [S6]; never reuse a CI token for context reads |

Request only read access to findings and projects in one deployment. Do not create a token with `Member` administration scope, do not request rule-editing or policy scopes, and do not use the API to trigger scans.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `X-Semgrep-Signature-256` [S5] |
| Algorithm | HMAC-SHA256, hex digest, UTF-8 [S5] |
| Signed string | The example computes HMAC over `json.dumps(payload, separators=(',', ':'))` — a compact re-serialization, not explicitly the raw bytes [S5] |
| Prefix | None in the vendor example (bare hex), unlike GitHub/Snyk — **UNVERIFIED** whether a prefix can appear |
| Signed timestamp | No |
| Secret floor | 15 characters [S5] |
| Replay control | Fingerprint dedupe; no timestamp exists |
| Body cap | 64 KiB platform default |
| Retries | Not documented — **UNVERIFIED** |

Critical transport divergence: the platform rule is "verify the raw bytes". Semgrep's own verification example re-serializes the parsed JSON compactly. If Semgrep sends compact JSON, the two are equivalent; if it sends whitespace, a raw-byte verifier will reject valid deliveries. The implementation must capture the raw body, compute the HMAC over it, and **also** compute over a compact re-serialization behind a feature flag; pick one only after a captured test delivery proves equality. Do not re-serialize before verification by default.

Events and mapping:

| Object | Creates a task | Notes |
|---|---|---|
| `semgrep_finding` | Yes | One record per new finding; apply remediation-policy filters |
| `semgrep_supply_chain_incident` | Yes, if the repository is affected | Severity and package evidence |
| `semgrep_scan` | No | Scan metadata, including scans with no findings; use for health only |

Semgrep sends a webhook only the first time a finding is detected and suppresses repeat notifications for the same changes in a PR; do not rely on that as the only dedupe [S5]. Accept only the documented object keys and reject an unknown top-level key. The 64 KiB cap is usually sufficient for one finding; a supply-chain incident with many affected projects can exceed it, in which case the delivery is `413` and the task is created only after an API reconcile, never from a truncated body.

## 5. Read-only context

Base `https://semgrep.dev`, token with `Web API`. The findings endpoint is the only read needed for the common path.

| # | Need | Endpoint | Fields / notes | Source |
|---|---|---|---|---|
| 1 | Finding list | `GET /api/v1/deployments/{deploymentSlug}/findings?status=open&severities=critical,high&page_size=100` | `id`, `severity`, `status`, `rule`, `location`, `relevant_since`; `issue_type` selects code vs supply chain, `repos` narrows the project set | [S7] |
| 2 | Projects | Deployment projects listing; exact path not confirmed — **UNVERIFIED** | Project name/slug for mapping to the bound repository; do not guess a path | [S8] |
| 3 | Single finding | Not confirmed on the reference page — **UNVERIFIED** | Prefer the list with a narrow filter over guessing a path | [S7] |

Fixed plan: 1 findings call for the common path, 2 only after a project-list path is verified, one page each, 10 s timeout, 256 KiB response cap, 100 items, 4,000 characters per excerpt, 256 KiB total. Query parameters observed on the reference page: `issue_type`, `since`, `page`, `page_size`, `status`, `severities`, `dedup`, `repos` [S7]. Treat all as trusted-code constants; the model cannot supply a deployment, repository or query string.

SARIF: the OSS CLI emits SARIF with `semgrep --sarif` or `--sarif-output=<file|url>` [S2]. Do not accept raw SARIF from a webhook, do not upload SARIF on the agent's behalf, and do not store it. SARIF results can carry `snippet`/`contextRegion` code, rule help and file contents. If a future wave parses SARIF, allowlist only `ruleId`, `level`, `locations[].physicalLocation.artifactLocation.uri`, `region.startLine/endLine`, and the message; never the snippet.

## 6. Framework fit

Module `packages/integrations/src/semgrep/`. Add `"semgrep"` to `INCIDENT_SOURCES` in a contract commit **before** the adapter; no migration is needed for the value (the column is `text` with a 32-character check).

| Function | Purpose | Risk |
|---|---|---|
| `verifySemgrepWebhook` | HMAC over raw/compact body, object allowlist, 64 KiB cap | `read_only` transport |
| `normalizeSemgrepFinding` | `semgrep_finding` -> `IncidentSignal`; severity and fingerprint | `read_only` |
| `fetchSemgrepIncidentContext` | 2-call plan -> `ContextBundle` | `read_only` |
| `semgrep.ignore_finding` | Triage one finding with reason/expiry | `scoped_write` |

Ignore/triage is a security decision: require a separate token, show the rule, path and reason in the approval payload, and record the actor. Never let the model choose a finding id from free text; it comes from the signal. Triggering a scan, deploying rules or rotating the API token is `sensitive` and out of scope.

Environment names:

```
SEMGREP_API_TOKEN=
SEMGREP_API_BASE_URL=
SEMGREP_DEPLOYMENT_SLUG=
SEMGREP_WEBHOOK_SECRET=
```

Sandbox implications: server-side reader only; sandbox egress deny; no Semgrep token in the sandbox; redact before truncation; the bundle contains paths and line numbers, not code. Tests: signature (raw and compact), oversize, unknown object, finding/scan/supply-chain mapping, severity legacy mapping, fingerprint replay, page cap, `401`/`403`/`429`/timeout, and no token or code snippet in errors.

## 7. Operator setup checklist

1. Choose OSS only (no hosted trigger) or the AppSec Platform Free Edition within 10 contributors and 10 private repositories.
2. Create a deployment token with `Web API` scope and a read-only role; record the deployment slug.
3. Configure one webhook with a random secret of at least 15 characters; subscribe only to finding and supply-chain policies, not every scan, unless scan health is wanted.
4. Confirm one open finding exists and note its id, rule and path (do not create a finding just to test).
5. Set the tenant binding used by the intake; the repository mapping must match the Semgrep project.
6. Add the variables below and restart; never paste a value into a prompt or ticket.
7. Send the built-in webhook test once, then one real finding delivery; verify one signal and one task.
8. Redeliver once to prove fingerprint dedupe and confirm no second task.

```
SEMGREP_API_TOKEN=
SEMGREP_API_BASE_URL=
SEMGREP_DEPLOYMENT_SLUG=
SEMGREP_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Raw-body and compact-JSON HMAC fixtures both behave as designed; tampered body fails.
- [ ] Secret shorter than 15 characters is "not configured" -> `503`; no downgrade.
- [ ] `semgrep_finding` creates one signal; `semgrep_scan` creates none; supply-chain maps correctly.
- [ ] Legacy severity mapping and fingerprint stability; redelivery dedupes.
- [ ] Caps, `truncated`, `401`/`403`/`429`/timeout; no token or snippet in output.

Live (explicit authorization, one bounded call):

- [ ] One findings list request with `page_size=100` and a narrow `since` filter, once, no retry.
- [ ] Record the deployment, finding id and severity; confirm no code snippet in the response excerpt.
- [ ] Do not trigger a scan or a second request after success.

## 9. Risks and what must never enter model context

- Raw SARIF, `lines`, code snippets, `contextRegion`, full file contents and repository archives.
- Rule `message` and `metadata.references` are free text; cap them and treat them as untrusted.
- Semgrep tokens, webhook secrets, CI tokens and deployment configuration.
- Contributor identities, emails and project membership.
- Supply-chain incident prose from the vendor is untrusted; use structured package/advisory fields.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [How Semgrep assigns severity](https://docs.semgrep.dev/kb/rules/understand-severities) |
| S2 | [Semgrep CLI reference (`--sarif`)](https://docs.semgrep.dev/cli-reference) |
| S3 | [Semgrep pricing and plans](https://semgrep.dev/pricing) |
| S4 | [Semgrep access tokens](https://docs.semgrep.dev/deployment/tokens) |
| S5 | [Semgrep webhooks](https://docs.semgrep.dev/semgrep-appsec-platform/webhooks) |
| S6 | [Web API 404 and token scopes](https://docs.semgrep.dev/kb/semgrep-appsec-platform/api-404-token-scope) |
| S7 | [List findings](https://docs.semgrep.dev/api-reference/v1/findingsservice/list-code-supply-chain-or-ai-powered-detection-findings) |
| S8 | [Semgrep API overview](https://docs.semgrep.dev/semgrep-appsec-platform/semgrep-api) |
| S9 | [Semgrep OSS license (LGPL-2.1)](https://github.com/semgrep/semgrep/blob/develop/LICENSE) |
