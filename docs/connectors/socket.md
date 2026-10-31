# Socket connector

| Field | Value |
|---|---|
| Status | **Design only — no code exists in this repository** |
| Code | none — no code exists in this repository |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §1.3, §4 |
| Free tier verified | 2026-10-31 (Free is $0 with 1,000 scans/month and 500 API requests; webhooks are not listed as included) |
| Auth | Socket API token, `Authorization: Bearer <token>`, scope `alerts:list` |
| Inbound | Socket webhook, `x-webhook-signature` (`t=...,s=...`), HMAC-SHA256 |
| Read | Current and historical supply-chain alerts for one organization |
| Writes | None in scope; future alert resolution/triage is `scoped_write` |

Nothing below is implemented. Shared transport rules are in [README.md](README.md) §3.

## 1. Role in the agent

Socket supplies supply-chain risk that a CVE feed misses: malicious packages, typosquats, protestware, install-script behaviour, obfuscated code and similar package-level signals. The connector answers "is this dependency itself hostile or risky, in which repository, and what is the safe version". It is not a package installer, a tarball inspector or a sandbox for untrusted code.

| Kind | Trigger | Evidence added | Fix signal |
|---|---|---|---|
| `socket_malware` | `alert:created`, type malware/threat | Package, version, alert type, repository, severity | Removal or safe version |
| `socket_supply_chain` | `alert:created`, other alert types | Package, version, alert type, severity, purl | Upgrade/remove |
| `socket_pull_request_scan` | `pull-request:scan` | Scan summary and new alerts | PR-level decision |

Severity: Socket alert severity is `low`, `medium`, `high` or `critical` [S1]. Map one-to-one, with one policy override: an alert whose type is confirmed malware or a threat-feed match is `critical` even if the vendor severity is lower, because the consequence is code execution in the build. Record the override in the signal summary so a reviewer can see it.

Fingerprint: `socket:<org_slug>:<alert_id>:<alert_type>`, bounded to 128 characters. The webhook `eventId` is not the identity (it can have a version suffix such as `@5`); the alert id is. A cleared alert never deletes a prior task; it is ignored for task creation.

## 2. Free tier and quotas

| Item | Free | Team | Source |
|---|---|---|---|
| Price | $0 per dev seat/month | $25 per dev seat/month | [S2] |
| Dev seats | 1 | From 5 | [S2] |
| Scans | 1,000/month | 5,000/month | [S2] |
| API requests | 500 (card); comparison table says 500/hour | 2,500 | [S2] |
| Repositories | Unlimited public and private | Unlimited | [S2] |
| Scan retention | 14 days | 30 days | [S2] |
| API tokens | 1 | 5 | [S2] |
| Webhooks | **Not included** (pricing table) | Not included in the same table; Business/Enterprise text mentions webhooks | [S2] |
| Slack alerts | Not included | Included | [S2] |
| Reachability analysis | Not included | Included | [S2] |

Two contradictions are recorded, not resolved:

1. The Free API allowance is shown as "500 API requests" on the plan card and "500 / hour" in the comparison table [S2]. Treat 500 as the safe total until the dashboard shows the real unit; never design a loop that assumes 500/hour.
2. The comparison table marks webhooks "Not included" for Free, Team and Business and "Included" only for Enterprise, while the Business description lists "SSO/SAML + webhooks" [S2]. The lowest plan that actually includes outbound webhooks is **UNVERIFIED**.

Consequence: on Free, the connector is **poll-only**. Do not promise an inbound trigger on a Free account. A paid plan is required for the webhook path, and the exact tier must be confirmed in the dashboard before the operator checklist is run. Socket offers free Business upgrades to qualifying open-source maintainers on request [S3]; that is a grant, not a public free tier, and must not be assumed.

Public-vs-private: Socket's Free plan covers unlimited public and private repositories, so repository visibility is not the gating factor here; the scan count, API allowance and webhook entitlement are.

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Header | `Authorization: Bearer <SOCKET_API_TOKEN>` [S4] |
| Token type | Organization API token with the single scope `alerts:list` [S4], [S5] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)`; the token is shown once at creation |
| Rotation | Create a second token with the same scope, deploy it, verify one list call, revoke the first; Free allows only one token, so rotation has a short overlap gap or requires a plan upgrade |
| Base URL | `https://api.socket.dev/v0` [S1] |

Do not request `repo:update`, `alert-policy:*`, `triage:alerts-update`, `packages:list` or any write scope for the reader. `alerts:list` is sufficient for the alert list and is the scope Socket's own guidance recommends for read-only integrations [S5]. A separate token is required for any future resolution write.

## 4. Inbound trigger

| Property | Value |
|---|---|
| Signature header | `x-webhook-signature: t=<unix seconds>,s=<base64 signature>` [S6] |
| Algorithm | HMAC-SHA256, base64-encoded [S6] |
| Signed string | `<timestamp>.<raw request body>` [S6] |
| Key | The `whsec_`-prefixed signing key; decode the part after `whsec_` as base64 (24 random bytes) before HMAC [S6] |
| Replay window | Socket suggests rejecting a timestamp older than five minutes; enforce ±300 s [S6] |
| Dedupe | Alert id + alert type; `eventId` is traceability only |
| Body cap | 64 KiB platform default |
| Retries | Not documented — **UNVERIFIED** |

Socket follows the Standard Webhooks payload shape: `type`, `eventId`, `schemaType`, `data`, `timestamp` [S6]. Accepted types:

| Type | Creates a task | Notes |
|---|---|---|
| `alert:created` | Yes | Primary trigger; `data.alert` and `data.organization` |
| `alert:updated` | No | Update evidence only; never a second task for the same alert |
| `alert:cleared` | No | Never closes or deletes a platform task automatically |
| `pull-request:scan` | Optional | Only if the user wants PR-level tasks; otherwise ignore |
| `threat-feed:*`, `campaign:*` | No by default | Entitlement-gated; treat as intelligence, not a repository task |

The signature scheme is the Standard Webhooks scheme, but Socket's own header name and encoding are not identical to the generic `webhook-signature` draft, so implement it from the vendor example, not from a library default. Verify the header shape strictly: one `t`, one `s`, decimal timestamp, base64 signature; reject duplicates and unknown fields. No timestamp means no replay protection on this route, hence the 300-second window.

## 5. Read-only context

Base `https://api.socket.dev/v0`, scope `alerts:list`.

| # | Need | Endpoint | Fields / notes | Source |
|---|---|---|---|---|
| 1 | Latest alerts | `GET /orgs/{org_slug}/alerts?per_page=100&filters.alertStatus=open` | Beta. `per_page` max 5000, default 1000; cursor `startAfterCursor`; keep paging until `endCursor` is `null` | [S1] |
| 2 | Alert detail by filters | Same endpoint with `filters.repoFullName`, `filters.alertSeverity`, `filters.alertType` | No separate detail endpoint documented; filter narrowly | [S1] |
| 3 | Historical alerts | `GET /orgs/{org_slug}/historical/alerts?date=...&range=...` | 10 quota units per call; use only for backfill, not per task | [S7] |

Allowlisted alert fields: `id`, `type`, `severity`, `title`, `package`/`purl`, `version`, `repository`/`repoSlug`, `createdAt`, `updatedAt`, `clearedAt`, `action`, `fix`/recommended version if present. The exact response schema is beta and may change; parse with a strict schema and reject unknown fields rather than storing the raw object.

Fixed plan: 1 list call per task (2 with a historical backfill), one page, 10 s timeout, 256 KiB response cap, 100 items, 4,000 characters per excerpt, 256 KiB total. A `429` fails the bundle with `RATE_LIMITED`; a partial response is not acceptable for an alert list because the missing page may contain the triggering alert.

Never fetch the package tarball, install scripts, dependency source, repository archive, or the package's npm/GitHub page. Socket's own detail page is a link for a human, not a fetch target.

## 6. Framework fit

Module `packages/integrations/src/socket/`. Add `"socket"` to `INCIDENT_SOURCES` in a contract commit **before** the adapter; no migration is needed for the value.

| Function | Purpose | Risk |
|---|---|---|
| `verifySocketWebhook` | Parse `t`/`s`, HMAC over `${t}.${body}`, 5-minute window, 64 KiB cap | `read_only` transport |
| `normalizeSocketAlert` | `alert:created` -> `IncidentSignal`; severity/type and fingerprint | `read_only` |
| `fetchSocketIncidentContext` | One filtered alert list -> `ContextBundle` | `read_only` |
| `socket.resolve_alert` | Resolve/triage one alert | `scoped_write`, not proposed |

The free-tier design must include a **polling loader** as the primary path and the webhook as an optional paid path behind the same normalizer. Do not make the reader depend on a webhook that Free cannot receive. Installing or quarantining a package, and any deploy action, is `sensitive` and is denied to the connector; only alert triage could ever be `scoped_write`.

Environment names:

```
SOCKET_API_TOKEN=
SOCKET_API_BASE_URL=
SOCKET_ORG_SLUG=
SOCKET_WEBHOOK_SECRET=
```

Sandbox implications: server-side only; the sandbox never installs the flagged package and never receives the Socket token; sandbox egress deny regardless, because resolving a malicious package by fetching it is exactly the wrong action. Tests: signature valid/tampered/old timestamp/malformed header; alert created/updated/cleared; severity override for malware; fingerprint replay; cursor termination including an empty page with a non-null `endCursor`; quota/`429`; no token or package source in output.

## 7. Operator setup checklist

1. Choose Free (poll-only) or a paid plan if the inbound webhook is required; confirm the webhook entitlement in the dashboard, not from the marketing table.
2. Create one organization API token with only `alerts:list`; copy it once.
3. Record the organization slug and the API base URL.
4. If webhooks are included: create the endpoint, copy the `whsec_` signing key, subscribe to `alert:created` (and optionally PR scans), and note that `alert:updated`/`alert:cleared` are ignored for task creation.
5. Confirm one existing alert to read; do not introduce a malicious package to test.
6. Set the tenant binding used by the intake and map the Socket repository slug to the bound platform repository.
7. Add the variables below and restart; never paste a value into a prompt, ticket or fixture.
8. Poll once with `per_page=100`, then verify one signal and one task; if webhooks are enabled, redeliver once and verify dedupe.

```
SOCKET_API_TOKEN=
SOCKET_API_BASE_URL=
SOCKET_ORG_SLUG=
SOCKET_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Signature over `${timestamp}.${raw body}` with base64 key; tampered body, stale timestamp and malformed header rejected.
- [ ] `alert:created` maps; `alert:updated`/`alert:cleared` create nothing; `alert:cleared` does not close a task.
- [ ] Malware severity override and fingerprint stability; replay dedupes.
- [ ] Cursor loop stops at `endCursor=null`, including the empty-page-with-more-results case.
- [ ] `429`, timeout, strict-schema rejection; no token or package source in output.

Live (explicit authorization, one bounded call):

- [ ] One alert list request with `per_page=100` and a repository filter, once, no retry.
- [ ] Record alert id, type and severity; confirm the response contains metadata only.
- [ ] Do not install, download or execute any package.

## 9. Risks and what must never enter model context

- Package tarballs, install scripts (`preinstall`/`postinstall`), obfuscated source, binaries and repository archives.
- Socket tokens, signing keys, organization membership and billing data.
- Full alert descriptions and threat-feed prose; use structured type/severity/package fields and cap any message.
- Maintainer identities and emails; package maintainer handles are public metadata but still untrusted.
- The agent must never run `npm install`, `pip install`, `bun add` or any package-manager command to "verify" a Socket finding.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Socket API: latest alerts](https://docs.socket.dev/reference/alertslist) |
| S2 | [Socket pricing](https://socket.dev/pricing) |
| S3 | [Free Business upgrades for open source](https://socket.dev/blog/free-business-plan-upgrades-for-open-source) |
| S4 | [Socket API token](https://docs.socket.dev/docs/api-keys) |
| S5 | [Socket OpenAPI description](https://api.socket.dev/v0/openapi.json) |
| S6 | [Socket webhooks](https://docs.socket.dev/docs/webhooks) |
| S7 | [Socket historical alerts](https://docs.socket.dev/reference/historicalalertslist) |
