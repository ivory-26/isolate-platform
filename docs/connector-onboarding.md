# Connector onboarding — how a user connects a tool and the agent uses it

| Field | Value |
|---|---|
| Status | **Design only — nothing in this page is implemented** |
| Audience | Product, web, worker and connector authors building the user-connect flow |
| Date | 2026-10-31 |
| Architecture of record | [`docs/connector-usage.md`](connector-usage.md) — this page builds on it and does not replace it |
| Security boundaries | [`ARCHITECTURE.md`](../ARCHITECTURE.md) §7–§11 |
| Vendor facts | Per-connector pages under [`docs/connectors/`](connectors/); free-tier matrix in [`free-tier-catalog.md`](connectors/free-tier-catalog.md) |
| Implemented today | Generic signed webhook intake; GitHub trigger, read-only context and two scoped-write functions (not agent-callable). No credential table, no broker, no connector tool |

## 0. The product rule this page exists to enforce

The platform does **not** operate the vendors on the user's behalf. The user
connects **their own** account — a free plan, a self-hosted instance, or a paid
plan they already own. The agent inside the sandbox then uses that connection.
That must be possible at zero platform cost.

Four consequences, all binding:

1. **No platform-owned provider read keys.** Every metered read uses the
   organization's credential row. The only platform-held identities are the
   GitHub App private key, inbound webhook HMAC secrets and the credential
   encryption key; none of them is a metered vendor API key.
2. **A missing user credential is not an error to paper over.** It fails closed
   as `INTEGRATION_UNAVAILABLE`; there is no environment-variable fallback, no
   shared demo key and no "try ours" path.
3. **Free is a hard budget, not a suggestion.** Each connector declares a
   verified free-tier profile; the platform stops at about 80% of the provider
   limit and reports the stop. It never silently overages and never upgrades a
   plan.
4. **The sandbox never holds the credential.** Tools execute server-side in the
   worker; sandbox egress stays `deny`. The sandbox sees a bounded, redacted,
   untrusted result and nothing else.

## 1. User journey

```text
catalog ─► connect ─► verify (one cheap read) ─► choose tools ─► run task
   ▲                                                                │
   └──────────────── disconnect ◄── revoke/expire ◄─────────────────┘
```

| Step | User sees | Server does | Record written |
|---|---|---|---|
| 1. Catalog | Connectors with a free/paid/self-host badge and the verified free limits | Serves the static catalog metadata; no vendor call | None |
| 2. Choose | Credential form for the connector's kind, or a "Connect with OAuth" button | Builds the form descriptor; never accepts a secret in a query string | None |
| 3. Connect | A single-submit form with password-type fields | Resolves caller scope, checks capability, validates shape, encrypts and stores `pending_validation` | `connector_credentials`, `audit_events` |
| 4. Verify | "Checking your connection…" | Exactly one cheap read with the submitted credential; maps the status | `status`, `last_validated_at`, `secret.rotate` audit |
| 5. Enable tools | A list of tool names with risk bands; read tools preselected | Persists the enabled set for that credential row | `metadata.enabled_tools`, `config.change` audit |
| 6. Run task | Task timeline shows tool activity per call | Builds the task tool registry from active rows, executes calls server-side | `tool_invocations`, `audit_events`, `connector_usage_ledger` |
| 7. Disconnect | "Disconnected; history kept" | Clears ciphertext, marks `revoked`, purges cached tokens | `secret.rotate` audit with outcome `revoked` |

### 1.1 UI states to build later (no UI code in this wave)

| State id | Trigger | What renders | Allowed next action |
|---|---|---|---|
| `catalog_loading` | First paint | Skeletons | None |
| `catalog_ready` | Catalog served | Cards grouped by category, free-tier badge, "requires paid plan" label | Open a connector |
| `catalog_unavailable` | Catalog read failed | Bounded error, no retry loop | Reload |
| `connect_forbidden` | Role lacks `connector:manage` | "Ask an owner or admin" | Back |
| `connect_form` | Capability ok | Fields for the credential kind; `autocomplete="off"` | Submit |
| `connect_oauth_waiting` | Authorization-code start | "Waiting for the provider…" with a cancel link | Cancel |
| `connect_validating` | Submit accepted | One bounded spinner, no progress theatre | Wait |
| `connect_invalid` | Provider `401`/`403` | "The provider rejected this credential" with the connector's scope hint | Retry |
| `connect_unreachable` | Timeout / `5xx` | "Provider unreachable; nothing was saved" | Retry later |
| `connect_budget_blocked` | Free-tier guard would be exceeded by validation | "This month's free budget is spent" | Disconnect or wait |
| `connect_connected` | Verify succeeded | Credential name, plan badge, last verified time, enabled tools | Choose tools / run task |
| `tools_disabled` | No tool enabled | Empty selection, "read tools only" note | Enable read tools |
| `tools_update_failed` | Persist failed | Previous selection preserved | Retry |
| `tool_running` | Agent emitted a call | Tool name and risk band only | None |
| `tool_succeeded` | Result returned | Item and byte counts, `truncated` flag | None |
| `tool_denied` | Policy denied | Bounded reason (for example `POLICY_DENIED`) | None |
| `tool_budget_exhausted` | Task or free-tier budget hit | `BUDGET_EXCEEDED` with the period and reset time | Wait / disconnect |
| `tool_provider_unavailable` | `5xx`, timeout or open circuit | "Provider unavailable; task continues without it" | Retry task later |
| `credential_expiring` | OAuth expiry within 24 h | Owner/admin warning | Rotate |
| `credential_expired` | Refresh failed or key expired | Tools disabled for that row | Rotate |
| `disconnecting` / `disconnected` | Revoke submitted / done | Payload cleared, row kept | Reconnect |

Every state is server-derived. The browser never receives a secret, a ciphertext
fragment, a token expiry refresh value or a provider error body.

### 1.2 Server actions to build later

All actions are TanStack `createServerFn` handlers in a new
`apps/web/src/features/connectors/connectors.functions.ts`, in the style of
`apps/web/src/features/tasks/tasks.functions.ts`. Each resolves the caller
scope server-side (`resolveCallerScope`), checks a capability before touching
storage, sets `Cache-Control: private, no-store`, and returns a bounded
`ServiceResult`.

| Action | Method | Capability | Input (bounded) | Output |
|---|---|---|---|---|
| `listConnectorCatalog` | GET | `connector:read` | none | Catalog entries with free-tier profile |
| `getConnectorInstance` | GET | `connector:read` | `{ connector, endpointId }` | Status summary, enabled tools, usage counters; never ciphertext |
| `startConnectorConnect` | POST | `connector:manage` | `{ connector, credentialKind, displayName, baseUrl? }` | Form descriptor or OAuth authorize URL |
| `submitConnectorCredential` | POST | `connector:manage` | `{ connector, displayName, fields }` | `{ status, displayName }` only |
| `completeConnectorOAuth` | POST | `connector:manage` | `{ state, code }` | `{ status }`; exchange stays server-side |
| `verifyConnectorCredential` | POST | `connector:manage` | `{ credentialId }` | `{ status, reasonCode }` |
| `updateConnectorTools` | POST | `connector:manage` | `{ credentialId, tools[] }` | `{ enabledTools }` |
| `rotateConnectorCredential` | POST | `connector:manage` | `{ credentialId, fields }` | `{ status }` |
| `revokeConnectorCredential` | POST | `connector:manage` | `{ credentialId }` | `{ status: "revoked" }` |
| `listConnectorUsage` | GET | `connector:read` | `{ connector }` | Ledger counters and budgets |

A `connectorId` is a closed union, not free text. A `baseUrl` is only accepted
for self-hosted kinds, is https-only, has no userinfo, query or fragment, and
must match the connector's host allowlist (or the operator's pinned host). A
display name is 1–80 characters and is not a secret.

## 2. Credential intake and storage

### 2.1 Credential kinds

| Kind | Fields | Verification read | Storage notes |
|---|---|---|---|
| `api_key` | key; optional base URL | One list/get on a fixed path | Key in the encrypted payload; base URL in `base_url` |
| `oauth2_client_credentials` | client id, secret, token URL, scopes | One token exchange + one read | Token URL must be allowlisted; client secret encrypted |
| `oauth2_authorization_code` | client id, optional secret, PKCE | Code exchange + one read | Access and refresh tokens encrypted; state is single-use |
| `service_account_json` | JSON blob (≤16 KiB), project id | One read with a minted token | Private key never logged; JSON stored only encrypted |
| `bot_token` | token, workspace id | One identity/workspace read | Bot token encrypted; no user scopes |
| `webhook_hmac` | secret (≥32 chars), optional timestamp header | Sign a local test vector; no provider call | Verification-only secret; never sent to a provider |
| `self_host_url_token` | base URL, token, optional CA PEM | One read against the pinned host | https only, no redirects, host allowlist |
| `github_app` | app id, installation id, private key (GHES only) | One installation-token mint + read | Platform App key never comes from a user; GHES key is per-org |
| `sasl_scram` | brokers, username, password, mechanism | One metadata request | Broker list allowlisted; password encrypted |
| `mtls` | base URL, client cert, client key | One read over the client certificate | Cert and key encrypted; key never leaves the broker |

Slack is notify-only and is not a context source; it is not part of the first onboarding wave.

### 2.2 Proposed migration `0010_connectors.sql` (design)

This refines §4.2 of [`connector-usage.md`](connector-usage.md): the table name,
the AEAD output triple and the unique key stay; the added columns are the ones
this flow needs. Additive and idempotent, in the style of
`packages/db/migrations/0009_incidents.sql`. Application is coordinator-owned
(`scripts/apply-migration.ts`); no connector applies SQL.

```sql
CREATE TABLE IF NOT EXISTS connector_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  connector text NOT NULL CHECK (char_length(connector) BETWEEN 1 AND 32),
  endpoint_id text NOT NULL DEFAULT 'default'
    CHECK (endpoint_id ~ '^[a-z0-9-]{1,40}$'),
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 80),
  auth_kind text NOT NULL CHECK (auth_kind IN
    ('webhook_hmac','api_key','sasl_scram','mtls','oauth_client_credentials',
     'oauth_authorization_code','github_app','service_account_json',
     'bot_token','self_host_url_token')),
  scopes text[] NOT NULL DEFAULT '{}',
  base_url text NULL CHECK (base_url IS NULL OR
    (base_url ~ '^https://' AND char_length(base_url) <= 300)),
  -- AES-256-GCM output; one row's DEK wraps this payload (see §2.3).
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  status text NOT NULL DEFAULT 'pending_validation' CHECK (status IN
    ('pending_validation','active','invalid','expired','revoked')),
  free_tier_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at timestamptz NULL,
  last_used_at timestamptz NULL,
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, connector, endpoint_id),
  UNIQUE (organization_id, connector, display_name)
);
CREATE INDEX IF NOT EXISTS connector_credentials_org_status_idx
  ON connector_credentials (organization_id, connector, status);

CREATE TABLE IF NOT EXISTS connector_usage_ledger (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  connector text NOT NULL,
  endpoint_id text NOT NULL DEFAULT 'default',
  metric text NOT NULL CHECK (metric IN ('requests','events','bytes','queries')),
  window_kind text NOT NULL CHECK (window_kind IN ('minute','day','month')),
  window_start timestamptz NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  budget bigint NOT NULL CHECK (budget > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, connector, endpoint_id, metric,
               window_kind, window_start)
);
CREATE INDEX IF NOT EXISTS connector_usage_ledger_org_window_idx
  ON connector_usage_ledger (organization_id, window_start);
```

`connector_endpoints` and `connector_rate_limits` from §4.2 remain as designed:
endpoints route inbound webhooks; rate limits hold the short-window token
bucket. The ledger holds the durable per-day and per-month free-tier counters.
`metric = 'bytes'` covers ingest/egress where a provider limits volume rather
than calls.

**Mapping to the requested columns.** `connector_id` is the existing
`connector` token (for vendor connectors it is also the incident `source`); no
second discriminator is needed. `encrypted_payload` is the §4.2 triple
`secret_ciphertext`, `secret_nonce`, `secret_tag`, kept split so the AES-GCM
parameters are explicit.
`credential_kind` is `auth_kind`, widened from §4.2's `oauth` into the two
OAuth flows and from `service_account` into `service_account_json`, plus
`bot_token` and `self_host_url_token`; adding a value is a CHECK change, not a
new table. `metadata.oauthFlow` is redundant with the kind and is not used.
`created_by` references `users(id)` and is nullable for system-created rows.
`free_tier_profile` is a server-side copy of the catalog entry at connect time,
never client input.

**Tenant FK and RLS.** `organization_id` is a real FK on every row. No table in
this repository enables row-level security today; isolation is enforced by every
query carrying `organization_id` and by tenant-scoped repositories. This
migration does not add RLS, because a half-enabled policy on one table would
imply a guarantee the rest of the schema does not provide. If RLS is adopted it
is a platform-wide change (a non-bypass application role plus a policy reading
`current_setting('app.organization_id')`), and until then the application
predicate is the control. Do not describe this table as RLS-protected.

### 2.3 Encryption: AES-256-GCM with a key-encryption key

- `CONNECTOR_CREDENTIAL_KEY` is 32 random bytes, base64, held in the deployment
  secret manager. `CONNECTOR_CREDENTIAL_KEY_VERSION` is a positive integer.
  Neither value is in the database, the repository, a log or a fixture.
- Envelope encryption: each credential row gets a random 32-byte data key (DEK).
  The JSON payload is encrypted with AES-256-GCM under the DEK; the DEK is
  wrapped with the KEK. `secret_ciphertext`/`nonce`/`tag` are the payload AEAD
  output; `wrapped_dek` is the wrapped DEK.
- AAD is exactly `<organizationId>:<connector>:<endpointId>` as §4.2 specifies,
  so a ciphertext moved to another tenant or endpoint fails authentication.
  `key_version` selects the KEK; rotating the KEK re-wraps DEKs without
  re-encrypting payloads. Retiring an old KEK is allowed only after every row's
  `wrapped_dek` has been re-wrapped.
- Decryption happens only in `ConnectorCredentialBroker.resolve()`. The
  repository's summary select list excludes all ciphertext, nonce, tag, wrapped
  DEK and plaintext. The admin path is write-only.
- The broker cache key is
  `org:<id>:connector:<id>:endpoint:<id>:scope:<scope>`, in-process,
  tenant-isolated and single-flight, expiring at
  `min(expires_at − 300 s, 5 min)`. A cached plaintext is never serialized.
- A failed decrypt, missing key, wrong tenant AAD or revoked row is
  `INTEGRATION_UNAVAILABLE`. The error message names the connector and the
  bounded reason code only.

### 2.4 Rotation, revocation and audit

- **Connect** writes one row as `pending_validation`, performs exactly one
  cheap read, then flips to `active` or `invalid`. The submitted secret is held
  in memory for that call only.
- **Rotate** validates the new secret in memory first, then overwrites the
  ciphertext triple and `wrapped_dek` in one transaction. There is no
  long-lived two-secret overlap and no secret history table. OAuth refresh is
  the same write path, performed by the broker, never by the browser.
- **Revoke** clears `secret_ciphertext`, `secret_nonce`, `secret_tag` and
  `wrapped_dek` to zero-length bytea, sets `status = 'revoked'`,
  `revoked_at = now()` and keeps the row for provenance. Reconnecting with the
  same display name reuses the row and writes a new payload, so the unique name
  does not become a dead end.
- **Audit** uses the existing closed vocabulary: `secret.rotate` for connect,
  rotate, revoke and OAuth refresh; `config.change` for enabling or disabling
  tools; `tool.execute` for each connector call. `details` carries
  `{ connector, endpointId, keyVersion, outcome, reasonCode }` and never a
  secret, fingerprint, provider message or request header. A new
  `connector.*` action would require an `audit_events` CHECK migration and is
  deliberately avoided.

## 3. Capability gating

New capabilities in `packages/db/src/roles.ts`:

| Capability | owner | admin | member | viewer |
|---|---|---|---|---|
| `connector:read` | yes | yes | yes | yes |
| `connector:use` | yes | yes | yes | no |
| `connector:manage` | yes | yes | no | no |

- Only `connector:manage` may connect, verify, rotate, revoke or change the
  enabled tool set.
- `connector:use` is checked at task submission and again when the worker builds
  the registry; a member may use enabled **read** tools. `scoped_write` stays
  owner/admin-only by credential policy, even if the role could submit a task.
- A viewer may see connector status and usage but cannot submit a task, so it
  can never trigger a connector call.
- The role comes from the membership row, never from a request field. The route
  organization id is a *selection* among the caller's memberships and is
  validated by `resolveCallerScope`; it can never grant one.
- **Re-check membership inside the transaction** that writes a credential or
  changes tools, using the same `authorizeMembership` pattern as workflow
  compilation (`ARCHITECTURE.md` §11). A role revoked between page load and
  submit must fail the write, not the next read.
- The task's organization must equal the credential's organization, checked in
  SQL, not in TypeScript after the read. A cross-tenant id is `FORBIDDEN`, never
  `NOT_FOUND` with detail.

## 4. How the sandbox agent uses a connection

The sandbox does not call the provider. The worker does.

```text
task claimed
  └─► build registry from active credentials + enabled tools (org-scoped)
        └─► agent turn ─► tool call ─► strict Zod args
              └─► policy band ─► broker.resolve(scope) ─► fixed URL template
                    └─► provider (timeout, no redirects)
                          └─► allowlist parse → redact → cap → hash
                                └─► untrusted result → model
                                      └─► tool_invocations + audit + ledger
```

- **Per-task registry.** `createConnectorToolRegistry({ organizationId,
  taskId, credentials })` returns only tools whose credential is `active` and
  whose tool is enabled. A connector with no credential contributes no tool; it
  does not contribute a tool that fails later. The registry is built after the
  task is claimed and is immutable for the run.
- **Typed schemas.** Every tool has a strict Zod input schema in trusted code.
  Identifiers are typed (repository full name, issue id, time window enum); there
  is no URL, host, query or path parameter authored by the model.
- **Risk bands** follow `packages/mastra/src/tools/policy.ts`:
  `read_only` executes and is audited; `scoped_write` executes and is audited
  with `details.risk`; `sensitive` returns `APPROVAL_REQUIRED` and uses the
  persisted, payload-bound approval; `destructive` and unlisted tools are
  `POLICY_DENIED`. The connector does not get a private policy table.
- **Bounded results.** Per call: 4 provider requests maximum, 16 KiB result,
  50 items, 4,000 characters per item, 10 s timeout. Redact before truncation;
  hash the redacted, truncated result; mark `truncated` and return it under the
  untrusted-data heading. A result never contains a credential, a raw log body,
  a full page of provider JSON or a signed download URL.
- **Audit.** `tool_invocations` records tool name, decision, denial reason,
  argument SHA-256 and duration; never arguments or provider text. The worker
  writes `audit_events` with `action = 'tool.execute'` and bounded `details`.
- **Budgets.** Existing task budgets (turns, tokens, cost, sandbox wall time)
  still apply. New per-task connector caps:
  `MAX_CONNECTOR_TOOL_CALLS_PER_TASK` (default 12),
  `MAX_CONNECTOR_REQUESTS_PER_TASK` (default 24, context and tools combined),
  `MAX_CONNECTOR_CALLS_PER_TOOL` (default 1, no loops). Hitting a cap stops
  that tool path with `BUDGET_EXCEEDED`; it does not fail the whole task unless
  the task's own turn budget is spent.
- **Egress.** Sandbox egress stays `deny`. The GitHub clone allowlist is the
  only create-time exception and is unrelated to connector reads. A tool never
  receives the sandbox handle.

## 5. Free-by-design guardrails

### 5.1 Free-tier profile

Each catalog entry carries a server-side profile, copied from the verified
connector page, never from the user session:

```json
{
  "availability": "free_forever",
  "verifiedOn": "2026-10-31",
  "source": "docs/connectors/sentry.md",
  "requestsPerMinute": null,
  "requestsPerDay": null,
  "eventsPerMonth": 5000,
  "bytesPerMonth": null,
  "retentionDays": 30,
  "trialDays": null
}
```

`availability` is one of `free_forever`, `free_tier_limited`, `oss_only`,
`trial_only`, `paid_only`. A null number means "not verified" and is not
treated as unlimited. A profile change is a reviewed catalog edit with the
source page and date.

### 5.2 Hard platform budget at about 80%

For every numeric provider limit, the platform budget is
`floor(0.8 × providerLimit)`. It is computed at read time from the profile and
stored on the ledger row, so a profile change applies to the next window and
never rewrites history. The UI shows both numbers and says which is the
provider's. The guard applies to validation reads, context reads and tool calls
alike; a validation call spends budget like any other.

### 5.3 Ledger and atomic consumption

The ledger is the source of truth, not an in-process counter. One statement
both increments and refuses an overage:

```sql
INSERT INTO connector_usage_ledger
  (organization_id, connector, endpoint_id, metric, window_kind,
   window_start, used, budget)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (organization_id, connector, endpoint_id, metric,
             window_kind, window_start)
DO UPDATE SET used = connector_usage_ledger.used + EXCLUDED.used,
              updated_at = now()
WHERE connector_usage_ledger.used + EXCLUDED.used
      <= connector_usage_ledger.budget
RETURNING used, budget;
```

No returned row means the budget is exhausted. The caller checks the amount
against the budget before a first insert, because the `WHERE` only applies to
the conflict path. Reserved budget is charged before the provider call and
refunded only for a transport failure that provably did not reach the provider;
a timeout is charged.

The check order is: per-minute token bucket → per-day ledger → per-month ledger.
The lowest available headroom wins. A rejection is `BUDGET_EXCEEDED`, mapped to
HTTP `429` with `Retry-After` for a browser or a bounded tool result for the
agent.

### 5.4 Fail closed, never upgrade

- No silent overage, no retry loop, no second credential used to "spread" the
  load, no fallback to a platform key.
- No billing integration, no card entry, no plan change. The platform cannot
  upgrade a user's vendor plan and must never try.
- The error is explicit: connector, metric, period, reset time, and the
  provider limit versus the platform guard. The task continues with the
  evidence it already has and marks the bundle or tool result `truncated`.
- Trial-only vendors are labelled "trial only — will bill after N days" and are
  **disabled by default**. Enabling one requires an explicit per-connector
  acknowledgement and an operator flag; the user pays the vendor directly.
- Where a SaaS is trial-only, the catalog recommends the self-hosted OSS path
  first (Elastic Basic, SigNoz Community, Prometheus, Grafana OSS, Kafka OSS).

## 6. Multi-connector routing

Builds on [`connector-usage.md`](connector-usage.md) §5; no new routing model.

- **Per-organization instances.** A connector is not global. Each row in
  `connector_credentials` belongs to one organization and one endpoint. Two
  teams on one deployment can connect the same vendor with different accounts.
- **Path routing.** `POST /api/webhooks/{connector}/{endpointId}`; both segments
  are validated against closed patterns. An unknown pair is `404` with no
  distinction between "unknown" and "another tenant's".
- **Organization from the endpoint row.** The webhook body, query string and
  headers never supply the tenant. The endpoint row supplies it.
- **Per-connector secret.** The `webhook_hmac` credential for that endpoint is
  resolved from the broker and verified with the connector's verifier. Missing
  is `503`, wrong is `401`; never downgrade to another connector's secret.
- **Dedupe.** `(organization, connector, fingerprint)` for 30 minutes,
  independent of endpoint, so a second endpoint cannot open a duplicate task.
- **One deployment, many orgs.** `CONNECTOR_ROUTING_MODE=path` enables the
  target; `legacy-single-binding` keeps today's env-bound behavior for an
  existing deployment until it is migrated. Both modes never run for the same
  endpoint.
- **No shared counters.** Quotas are per `(organization, connector)`. A second
  endpoint does not get a second free budget; it shares the org's ledger row
  for that connector.

## 7. Failure and security semantics

| Condition | Platform behavior | Tool/context result | User-visible status |
|---|---|---|---|
| `401` invalid or expired key | No retry; mark row `invalid` (or refresh once for OAuth) | `INTEGRATION_UNAVAILABLE` | `credential_expired`, owner/admin prompted to rotate |
| `403` scope or ACL | `POLICY_DENIED`; drop an optional item; never widen scope | Bounded denial reason | `tool_denied` with the connector's scope hint |
| `404` resource gone | Omit the item; `truncated = true`; no retry | Partial result | `tool_succeeded` with truncation |
| `429` rate limited | Honor `Retry-After`; at most one retry, only for a read | Degraded or `RATE_LIMITED` | `tool_budget_exhausted` or `tool_provider_unavailable` |
| `5xx`, timeout, transport | No retry inside the call; open the circuit | `INTEGRATION_UNAVAILABLE` | `tool_provider_unavailable` |
| Schema/parse drift | Drop the item; count a metric; never pass raw text | `truncated = true` | `tool_succeeded` with truncation |
| Free-tier budget spent | Refuse before the call | `BUDGET_EXCEEDED` | `tool_budget_exhausted` with reset time |
| Circuit open | Skip the call for 60 s; one half-open probe | `INTEGRATION_UNAVAILABLE` | `tool_provider_unavailable` |
| Credential revoked | No call | `INTEGRATION_UNAVAILABLE` | `credential_revoked` |
| Missing credential | No tool registered | Tool absent | Connector shows "not connected" |

- **No retry storms.** A webhook is never retried by the platform. A read gets
  at most one retry, only after a provider hint. A write is never retried
  automatically; the caller dedupes by delivery id where the provider offers no
  idempotency key.
- **Circuit breaker.** Per `(organization, connector, endpoint)`: open after 5
  consecutive failures in 60 s, stay open for 60 s, allow one half-open probe.
  Open state is process-local and resets on restart; the ledger and status
  columns are durable.
- **Partial context is valid.** A missing optional resource never fails a task.
  An empty bundle is absent evidence, never "no problem found".
- **Status is part of the product.** Every degraded path records a bounded code
  on the run timeline and shows the state in the connector page.

## 8. Implementation plan

One connector per wave; contracts first. Each PR is offline-only: fakes, no
network, `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`.

| PR | Scope | Tests | Exit criterion |
|---|---|---|---|
| 1 | Contracts: catalog metadata, `authKind`, `freeTierProfileSchema`, new `ToolName` entries and risk bands, `BUDGET_EXCEEDED` mapping | Strict-schema rejects unknown fields; no credential field in any shared type; catalog rows match pages | `tsc`, shared/mastra tests green |
| 2 | Migration `0010`, `PostgresConnectorCredentialRepository`, `ConnectorCredentialBroker`, ledger repository, in-memory fakes | AES-GCM roundtrip; AAD tenant mismatch fails; summary has no ciphertext; rotate/revoke; atomic ledger refuses overage; concurrent consume | Repository + broker tests green |
| 3 | First adapter: **Sentry** (signed webhook, fixed context plan, `sentry.issue_context` `read_only`) | Fixture signatures; `401/403/429/5xx` mapping; redaction; caps; no network | Integrations tests green |
| 4 | Tool registry binding in the worker: per-task registry, policy, caps, `tool_invocations`, audit, ledger | Denied/unlisted tool; missing credential; budget exhaustion; result truncation; registry immutability | Worker tests green, `acceptance:offline` green |
| 5 | Web server actions and states: catalog, connect, verify, rotate, revoke, tools, usage | Owner/admin/member/viewer matrix; cross-tenant id; membership re-check in transaction; no secret in response | Web tests green |
| 6 | Second adapter: **PagerDuty** (signed webhook, incident read tools). Grafana/Prometheus follow only after the one-metrics-vendor rule is satisfied | Same suite as PR 3 plus `ack` band decision | Integrations tests green |
| 7 | Hardening: OAuth refresh, circuit breaker, trial acknowledgement, catalog page | Refresh once; open/half-open; trial disabled by default | Full suite green twice |

Sentry precedes PagerDuty because it answers "what failed, where" without a
paid paging account. PagerDuty is not built in the same wave
(`connector-usage.md` §8). The GitHub App flow stays deployment-level until its
installation id is stored per organization; that migration is a separate PR and
must not change the webhook contract.

### 8.1 What remains is only `.env` and one migration

No metered provider read key is added to the environment. User credentials are rows.

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | web, worker | Existing; the credential and ledger tables live here |
| `CONNECTOR_CREDENTIAL_KEY` | web, worker | 32-byte base64 KEK; never in the repository |
| `CONNECTOR_CREDENTIAL_KEY_VERSION` | web, worker | Positive integer selecting the KEK |
| `CONNECTOR_ROUTING_MODE` | web | `path` or `legacy-single-binding` |
| `CONNECTOR_OAUTH_STATE_SECRET` | web | HMAC key for single-use OAuth state |
| `CONNECTOR_OAUTH_REDIRECT_URL` | web | Absolute https callback; must match the registered redirect |
| `CONNECTOR_BUDGET_PERCENT` | web, worker | Default `80`; may only be lowered per connector |
| `CONNECTOR_MAX_TOOL_CALLS_PER_TASK` | worker | Default `12` |
| `CONNECTOR_MAX_REQUESTS_PER_TASK` | worker | Default `24` |
| `CONNECTOR_REQUEST_TIMEOUT_MS` | worker | Default `10000` |
| `CONNECTOR_ALLOW_TRIAL` | web | Default `false`; trial connectors stay disabled |
| `WEBHOOK_MAX_BODY_BYTES` | web | Existing; 64 KiB body cap |
| `WEBHOOK_SIGNING_SECRET` | web | Existing generic-mode HMAC (legacy) |
| `WEBHOOK_GITHUB_SECRET` | web | Existing GitHub-mode HMAC (legacy) |
| `WEBHOOK_ORGANIZATION_ID` | web | Legacy single binding only |
| `WEBHOOK_ACTOR_ID`, `WEBHOOK_ACTOR_ROLE` | web | Legacy single binding only |
| `WEBHOOK_REPOSITORY_ID`, `WEBHOOK_BRANCH` | web | Legacy single binding only |
| `WEBHOOK_WORKFLOW_DEFINITION_ID`, `WEBHOOK_WORKFLOW_VERSION` | web | Legacy single binding only |
| `WEBHOOK_FILE_OWNERSHIP`, `WEBHOOK_SERVICE` | web | Legacy single binding only |
| `WEBHOOK_MAX_AGENT_TURNS` | web | Legacy single binding only |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` | worker | Existing GitHub App identity |
| `GITHUB_APP_PRIVATE_KEY_PATH` | worker | Existing platform App key path |
| `GITHUB_API_BASE_URL` | worker | Existing; default `https://api.github.com` |

Connector-specific names on each page §7 (`SENTRY_API_KEY`,
`PAGERDUTY_API_KEY`, `GRAFANA_TOKEN`, `KAFKA_BRIDGE_*`, and so on) are
**bridge and deployment configuration, never a tenant credential fallback**.
The onboarding code must read none of them; a code search in CI proves zero
reads outside the legacy bridge. This is the mechanism that keeps the product
free: the tenant's row is the only credential.

Checklist before calling the work done:

- [ ] Migration `0010_connectors.sql` applied by the coordinator; tables,
      indexes, FKs and CHECKs verified by `\d+`.
- [ ] `CONNECTOR_CREDENTIAL_KEY` and `..._VERSION` present in the secret
      manager; a write-only roundtrip proven; no ciphertext in any log.
- [ ] `audit_events` vocabulary unchanged; `tool_invocations` records a digest,
      never arguments.
- [ ] Catalog matches [`free-tier-catalog.md`](connectors/free-tier-catalog.md);
      every `UNVERIFIED` mark carried through.
- [ ] No `.env` value, key, token or ciphertext in the repository, fixtures,
      docs, logs or screenshots.
- [ ] Offline gates and acceptance run twice, with providers disabled.
- [ ] No live provider call in CI; a live acceptance is separate, bounded and
      explicitly authorized.

```bash
bunx biome check docs packages/integrations/src apps/web/src apps/worker/src packages/mastra/src packages/db/src
bunx tsc --noEmit
bun test packages/integrations packages/shared packages/mastra packages/db apps/web apps/worker
bun test packages/integrations packages/shared packages/mastra packages/db apps/web apps/worker
bun run acceptance:offline
```

## 9. Threat model

| Threat | Vector | Control | Residual |
|---|---|---|---|
| Credential exfiltration via prompt | Model asks the user or a file for a key | Keys never enter a prompt, task goal or tool schema; no tool returns a credential | A user can still paste a key into a task goal; the redactor and the "never paste secrets" notice are the only defense |
| Exfiltration via tool result | Provider echoes an `Authorization` header or a config dump | Allowlist parse, shared redactor, caps, no raw body | A provider-specific field not on the allowlist is dropped, not shown |
| Exfiltration via logs/audit | Error includes a URL with a token | Fixed error text; audit `details` is a closed set; no request headers | A new code path can regress; tests assert no secret in serialized output |
| SSRF via base URL | User supplies `http://169.254.169.254`, a private IP, or a URL with userinfo | https only, no userinfo/query/fragment, host allowlist, no redirects, DNS/IP check, connect timeout | A compromised DNS or a provider-side redirect; redirects are disabled |
| Webhook spoofing | Forged delivery to a known endpoint | HMAC over raw bytes, constant-time compare, timestamp window, per-endpoint secret, 64 KiB cap | A leaked endpoint secret; rotation is the only remedy |
| Tenant cross-read | Guessing another org's credential or endpoint id | Every query carries `organization_id`; FK; membership re-check in the write transaction; cross-tenant id is `FORBIDDEN` | A missing predicate in a new query; repository tests assert the scope |
| Replay | Re-sending a valid webhook or OAuth code | 30-minute dedupe by fingerprint; single-use OAuth state and code; `202` is idempotent | A replay inside the window is deduped, not rejected |
| Quota exhaustion | A flapping alert or an agent loop | Fingerprint dedupe, two-active-task cap, per-task tool caps, 80% ledger budget, `429` with `Retry-After` | A distributed burst across orgs is still provider-visible; the platform stays within its own budget |
| Confused deputy | A member uses an admin's connection | Capability per action; `connector:use` only for enabled read tools; `scoped_write` owner/admin | A misconfigured enabled set; the UI shows every enabled tool |
| OAuth CSRF / mix-up | Attacker-supplied `state` or code | State bound to session, org, connector and a server nonce; PKCE; exact redirect URI | A stolen browser session; the state is single-use |
| Model-authored URL or query | Prompt injection asks for a different host or a wider window | No URL parameter in any tool; fixed templates; typed ids; window enums | A provider id that resolves to another tenant's object; provider ACL is the backstop |

## 10. Relationship to the architecture of record

This page does not change the three planes, the adapter contract, the policy
bands, the context caps or the failure table in
[`connector-usage.md`](connector-usage.md). It adds the user-facing intake, the
credential row shape, the capability split, the free-tier ledger and the
onboarding plan. Where this page is more specific, it is additive:

- `connector_credentials` gains `display_name`, `scopes`, `status`, `base_url`,
  `wrapped_dek`, `free_tier_profile`, `last_validated_at`, `last_used_at` and
  `created_by`; its AEAD triple, key version, tenant FK and endpoint uniqueness
  are unchanged.
- `connector_usage_ledger` is new and complements, not replaces,
  `connector_rate_limits`.
- The tool caps are new; the existing turn, token, cost and sandbox budgets are
  unchanged.
- One divergence to reconcile: §4.3 describes rotation as revoking the old row
  and deleting it, which assumes a second version row. With one row per endpoint
  this design overwrites the ciphertext after in-memory validation, destroys the
  old secret and records `secret.rotate`; §4.3 should be read that way.
- GitHub remains deployment-level in this plan. The target per-organization
  GitHub installation is a separate, later change and is not claimed here.

Nothing in this page is implemented. The only code that exists today is the
GitHub and generic-webhook path described in
[`connectors/README.md`](connectors/README.md).
