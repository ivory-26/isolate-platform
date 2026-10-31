# Connector onboarding — how a user connects a tool and the agent uses it

| Field | Value |
|---|---|
| Status | **Design of record; credential foundation implemented, connect UI and device transport pending** |
| Audience | Product, web, worker and connector authors building the user-connect flow |
| Date | 2026-11-01 |
| Architecture of record | [`docs/connector-usage.md`](connector-usage.md) — this page builds on it and does not replace it |
| Security boundaries | [`ARCHITECTURE.md`](../ARCHITECTURE.md) §7–§11 |
| Vendor facts | Per-connector pages under [`docs/connectors/`](connectors/); free-tier matrix in [`free-tier-catalog.md`](connectors/free-tier-catalog.md) |
| Implemented today | Generic signed webhook intake; GitHub trigger, read-only context and two scoped-write functions (not agent-callable). Wave 17 added migration `0010_connectors.sql` (device registry, credential metadata, usage ledger), tenant-scoped repositories and fakes, and device token/proxy/broker contracts. The connect UI and the device-daemon poll transport are not wired |

## 0. The product rule this page exists to enforce

The platform does **not** operate the vendors on the user's behalf. The user
connects **their own** account — a free plan, a self-hosted instance, or a paid
plan they already own. The agent inside the sandbox then uses that connection.
That must be possible at zero platform cost.

Four consequences, all binding:

1. **No platform-held provider keys.** Every metered read uses a credential
   that stays on the organization's device. The server stores a device-token
   hash and connector metadata, never a provider key. The only platform-held
   identities are the GitHub App private key (the platform's own App, not a
   user's provider key), inbound webhook HMAC secrets and the database URL;
   none of them is a metered vendor API key.
2. **A missing user credential is not an error to paper over.** It fails closed
   as `INTEGRATION_UNAVAILABLE`; there is no environment-variable fallback for
   a tenant, no shared demo key and no "try ours" path.
3. **Free is a hard budget, not a suggestion.** Each connector declares a
   verified free-tier profile; the platform stops at about 80% of the provider
   limit and reports the stop. It never silently overages and never upgrades a
   plan.
4. **Neither the sandbox nor the server holds the credential.** The worker
   sends a typed request to the user's device, which holds the secret and calls
   the provider; sandbox egress stays `deny`. The sandbox sees a bounded,
   redacted, untrusted result and nothing else.

## 1. User journey

```text
install daemon ─► register device ─► activate ─► catalog ─► connect metadata
                                                              │
   ┌──────────────── run task ◄── verify (one cheap read on device)
   │                                                          │
   └────────────── disconnect ◄── revoke credential/device ◄──┘
```

| Step | User sees | Server does | Record written |
|---|---|---|---|
| 1. Install daemon | Install command and a one-time device name | Serves the daemon download metadata; no vendor call | None |
| 2. Register device | A pending device with its display name | Accepts `sha256(token)` only; never the token | `connector_devices` (`pending`), `audit_events` |
| 3. Activate device | "Device active" after owner/admin approval | Flips status to `active`; capability-checked | `connector_devices.status`, `audit_events` |
| 4. Catalog | Connectors with a free/paid/self-host badge and verified limits | Serves static catalog metadata; no vendor call | None |
| 5. Choose | Credential form for the connector's kind, or a device-side OAuth start | Builds the form descriptor; never accepts a provider secret in a request | None |
| 6. Connect | "Saved on this device" | Writes metadata (`credential_ref`, kind, scopes) as `pending_validation`; the secret goes to the device keychain | `connector_credentials`, `audit_events` |
| 7. Verify | "Checking your connection…" | Enqueues exactly one cheap typed read; the device executes it; maps the bounded result to a status | `status`, `last_validated_at`, `secret.rotate` audit |
| 8. Enable tools | Tool names with risk bands; read tools preselected | Persists the enabled set in `metadata.enabled_tools` | `config.change` audit |
| 9. Run task | Task timeline shows tool activity per call | Device broker resolves the device; the worker enqueues typed calls; the device executes them | `tool_invocations`, `audit_events`, `connector_usage_ledger` |
| 10. Disconnect | "Disconnected; history kept" | Marks the credential `revoked`; optionally revokes the device token hash | `secret.rotate` audit with outcome `revoked` |

### 1.1 UI states to build later (no UI code in this wave)

| State id | Trigger | What renders | Allowed next action |
|---|---|---|---|
| `catalog_loading` | First paint | Skeletons | None |
| `catalog_ready` | Catalog served | Cards grouped by category, free-tier badge, "requires paid plan" label | Open a connector |
| `catalog_unavailable` | Catalog read failed | Bounded error, no retry loop | Reload |
| `device_missing` | No active device for the organization | "Install the connector daemon" | Install |
| `device_pending` | Device registered, not yet active | "Waiting for an owner or admin" | Cancel |
| `device_offline` | Active device is not polling | "Device offline; connector calls will pause" | Retry later |
| `device_revoked` | Device token hash revoked | "Device disconnected; register again" | Register |
| `connect_forbidden` | Role lacks `connector:manage` | "Ask an owner or admin" | Back |
| `connect_form` | Capability ok | Fields for the credential kind; `autocomplete="off"` | Submit |
| `connect_oauth_waiting` | Authorization-code start | "Waiting for the provider…" with a cancel link | Cancel |
| `connect_validating` | Submit accepted | One bounded spinner, no progress theatre | Wait |
| `connect_invalid` | Provider `401`/`403` | "The provider rejected this credential" with the connector's scope hint | Retry |
| `connect_unreachable` | Timeout / `5xx` from the device or provider | "Device unreachable; the credential stays on the device" | Retry later |
| `connect_budget_blocked` | Free-tier guard would be exceeded by validation | "This month's free budget is spent" | Disconnect or wait |
| `connect_connected` | Verify succeeded | Credential name, plan badge, last verified time, enabled tools | Choose tools / run task |
| `tools_disabled` | No tool enabled | Empty selection, "read tools only" note | Enable read tools |
| `tools_update_failed` | Persist failed | Previous selection preserved | Retry |
| `tool_running` | Agent emitted a call | Tool name and risk band only | None |
| `tool_succeeded` | Result returned | Item and byte counts, `truncated` flag | None |
| `tool_denied` | Policy denied | Bounded reason (for example `POLICY_DENIED`) | None |
| `tool_budget_exhausted` | Task or free-tier budget hit | `BUDGET_EXCEEDED` with the period and reset time | Wait / disconnect |
| `tool_provider_unavailable` | `5xx`, timeout or device offline | "Provider or device unavailable; task continues without it" | Retry task later |
| `credential_expiring` | OAuth expiry within 24 h (device-side refresh failed) | Owner/admin warning | Rotate |
| `credential_expired` | Refresh failed or key expired | Tools disabled for that row | Rotate |
| `disconnecting` / `disconnected` | Revoke submitted / done | Metadata marked `revoked`; the device deletes its keychain item | Reconnect |

Every state is server-derived. Neither the browser nor the server receives a
provider secret, a ciphertext fragment, a token expiry refresh value or a
provider error body; only the device holds the secret.

### 1.2 Server actions to build later

All actions are TanStack `createServerFn` handlers in a new
`apps/web/src/features/connectors/connectors.functions.ts`, in the style of
`apps/web/src/features/tasks/tasks.functions.ts`. Each resolves the caller
scope server-side (`resolveCallerScope`), checks a capability before touching
storage, sets `Cache-Control: private, no-store`, and returns a bounded
`ServiceResult`.

| Action | Method | Capability | Input (bounded) | Output |
|---|---|---|---|---|
| `listConnectorDevices` | GET | `connector:read` | none | Device summaries with `lastSeenAt`, status; never a token hash |
| `registerConnectorDevice` | POST | `connector:manage` | `{ displayName, tokenHash }` | `{ deviceId, status: "pending" }` |
| `activateConnectorDevice` | POST | `connector:manage` | `{ deviceId }` | `{ status: "active" }` |
| `revokeConnectorDevice` | POST | `connector:manage` | `{ deviceId }` | `{ status: "revoked" }` |
| `listConnectorCatalog` | GET | `connector:read` | none | Catalog entries with free-tier profile |
| `getConnectorInstance` | GET | `connector:read` | `{ connector }` | Status summary, enabled tools, usage counters; never a secret (the server has none) |
| `startConnectorConnect` | POST | `connector:manage` | `{ connector, credentialKind, displayName, baseUrl? }` | Form descriptor or a device-side OAuth start descriptor |
| `submitConnectorCredential` | POST | `connector:manage` | `{ connector, deviceId, displayName, authKind, credentialRef, scopes[] }` | `{ status, displayName }`; there is no secret field |
| `completeConnectorOAuth` | POST | `connector:manage` | `{ state, credentialRef }` | `{ status }`; the code exchange runs on the device (design) |
| `verifyConnectorCredential` | POST | `connector:manage` | `{ credentialId }` | `{ status, reasonCode }` |
| `updateConnectorTools` | POST | `connector:manage` | `{ credentialId, tools[] }` | `{ enabledTools }` |
| `rotateConnectorCredential` | POST | `connector:manage` | `{ credentialId, credentialRef }` | `{ status }` |
| `revokeConnectorCredential` | POST | `connector:manage` | `{ credentialId }` | `{ status: "revoked" }` |
| `listConnectorUsage` | GET | `connector:read` | `{ connector }` | Ledger counters and budgets |

`tokenHash` is exactly 64 lowercase hex characters; the server hashes and
validates, and can never recover the token. The daemon poll endpoint
(`POST /api/connector-devices/poll`, design) is not a `createServerFn`: it is a
device-authenticated route that accepts a bearer token, verifies its sha256
hash in constant time, updates `last_seen_at` and returns bounded queued
requests. No browser session is involved.

A `connectorId` is a closed union, not free text. A `baseUrl` is only accepted
for self-hosted kinds, is https-only, has no userinfo, query or fragment, and
must match the connector's host allowlist (or the operator's pinned host). A
display name is 1–100 characters and is not a secret. A `credentialRef` is
1–200 characters naming a device keychain item; it is not a secret either.

## 2. Credential intake and storage

### 2.1 Credential kinds

| Kind | Fields | Verification read | Storage notes |
|---|---|---|---|
| `api_key` | key; optional base URL | One list/get on a fixed path | Key in the device keychain; server stores `credential_ref` and base URL metadata |
| `oauth_client_credentials` | client id, secret, token URL, scopes | One token exchange + one read | Client secret stays on the device; token URL must be allowlisted |
| `oauth_authorization_code` | client id, optional secret, PKCE | Code exchange + one read | Access and refresh tokens device-held; state is single-use server-side |
| `service_account_json` | JSON blob (≤16 KiB), project id | One read with a minted token | JSON blob device-held; server stores project id metadata only |
| `bot_token` | token, workspace id | One identity/workspace read | Bot token device-held; no user scopes |
| `webhook_hmac` | secret (≥32 chars), optional timestamp header | Sign a local test vector; no provider call | Inbound verification secret, platform-held by design; not stored in `connector_credentials` |
| `self_host_url_token` | base URL, token, optional CA PEM | One read against the pinned host | URL metadata only; token and CA stay on the device; https only, no redirects |
| `github_app` | app id, installation id, private key (GHES only) | One installation-token mint + read | Platform App key is server-held (it is the platform's App); no credential row |
| `sasl_scram` | brokers, username, password, mechanism | One metadata request | Username in metadata; password device-held; no `auth_kind` value yet |
| `mtls` | base URL, client cert, client key | One read over the client certificate | Cert and key device-held; no `auth_kind` value yet |

The applied CHECK allows six kinds: `api_key`, `oauth_client_credentials`,
`oauth_authorization_code`, `service_account_json`, `bot_token` and
`self_host_url_token`. `webhook_hmac`, `github_app`, `sasl_scram` and `mtls`
have no stored credential row yet; adding one is a CHECK migration, not a
documentation change.

Slack is notify-only and is not a context source; it is not part of the first onboarding wave.

### 2.2 Applied schema `0010_connectors.sql`

The schema is `packages/db/migrations/0010_connectors.sql`; read it before
changing this section. It is additive and idempotent, and application is
coordinator-owned (`scripts/apply-migration.ts`); no connector applies SQL.

```sql
CREATE TABLE IF NOT EXISTS connector_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  -- sha256 hex of the device auth token; the token itself never reaches the DB.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','revoked')),
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, display_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_devices_token_hash_unique
  ON connector_devices (token_hash);

CREATE TABLE IF NOT EXISTS connector_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES connector_devices(id) ON DELETE CASCADE,
  connector_id text NOT NULL CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  auth_kind text NOT NULL CHECK (auth_kind IN
    ('api_key','oauth_client_credentials','oauth_authorization_code',
     'service_account_json','bot_token','self_host_url_token')),
  -- Opaque device-side keychain item name, never a secret.
  credential_ref text NOT NULL CHECK (char_length(credential_ref) BETWEEN 1 AND 200),
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending_validation'
    CHECK (status IN ('pending_validation','active','invalid','revoked')),
  free_tier_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at timestamptz NULL,
  last_used_at timestamptz NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, connector_id, display_name),
  UNIQUE (device_id, connector_id, credential_ref)
);

CREATE TABLE IF NOT EXISTS connector_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  credential_id uuid NOT NULL REFERENCES connector_credentials(id) ON DELETE CASCADE,
  connector_id text NOT NULL CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  period date NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credential_id, period)
);
```

**What each table holds.** `connector_devices` holds one row per registered
device, its display name, status and `last_seen_at`; the only authentication
material is the sha256 token hash, which cannot be reversed. There is no
rotate-in-place method yet, so rotation means register a new device and revoke
the old one. `connector_credentials` holds metadata only: the owning device,
`credential_ref`, auth kind, scopes, status, a verified `free_tier_profile` and
bounded `metadata`. `connector_usage_ledger` holds the durable per-credential,
per-UTC-date free-tier counter.

**Removed from the earlier design.** `secret_ciphertext`, `secret_nonce`,
`secret_tag`, `wrapped_dek`, `key_version`, `encrypted_payload`,
`base_url`/`endpoint_id` columns and the operator key `CONNECTOR_CREDENTIAL_KEY`
do not exist. The old `credential-crypto.ts` and `credential-broker.ts` modules
were deleted; `device-token.ts`, `device-proxy.ts` and `device-broker.ts` replace
them. `connector_endpoints` and `connector_rate_limits` remain design-only and
are not part of 0010.

**Tenant FK and RLS.** `organization_id` is a real FK on every row. No table in
this repository enables row-level security today; isolation is enforced by every
query carrying `organization_id` and by tenant-scoped repositories. This
migration does not add RLS, because a half-enabled policy on one table would
imply a guarantee the rest of the schema does not provide. If RLS is adopted it
is a platform-wide change (a non-bypass application role plus a policy reading
`current_setting('app.organization_id')`), and until then the application
predicate is the control. Do not describe these tables as RLS-protected.

### 2.3 Where the secret lives: no server-side encryption

There is no KEK, DEK, AES-256-GCM envelope, `CONNECTOR_CREDENTIAL_KEY`,
`getSecret` or "the server can decrypt" path. The server never receives a
provider key, so it has nothing to encrypt or decrypt.

- **Device token.** The daemon generates 256 random bits and encodes them as
  43 base64url characters (`generateConnectorDeviceToken`). It sends only the
  sha256 hex digest to the server; `connector_devices.token_hash` is the sole
  authentication material. Verification recomputes the digest and compares in
  constant time; malformed input is a non-match, never an error.
- **`credential_ref`.** A 1–200 character opaque name for the device-side
  keychain item (for example an OS keychain label). It names the secret and is
  never the secret. It may appear in a summary or a fixed error; a token may not.
- **Provider secret.** It lives in the user's OS keychain or protected browser
  storage and is read only by the daemon at call time. It is never sent to the
  server, a prompt, a tool argument, a log or an audit row.
- **Stolen database.** A dump yields connector metadata, device names,
  `last_seen_at`, usage counters and sha256 token hashes. It yields no provider
  key; guessing a 256-bit token from its hash is infeasible.

**Device daemon poll flow (design; transport not wired).**

```text
1 register   device token generated locally → only sha256 hex sent
             └─► connector_devices (pending, token_hash)
2 activate   owner/admin sets active; revoke sets revoked
3 connect    browser/device writes the secret to the keychain;
             server stores connector_credentials metadata (credential_ref)
4 call       worker validates a typed request:
             { connectorId, credentialRef, operation, params <= 16 KiB, timeoutMs }
5 poll       daemon presents its bearer token → server hashes →
             verifyByTokenHash (constant time) → touchSeen → pending request
6 execute    daemon reads the keychain item by credentialRef, calls the provider,
             returns a bounded result <= 16 KiB or a fixed error code
7 enforce    worker bounds/redacts/caps, runs policy, audits, consumes the ledger
```

The typed request is `normalizeConnectorDeviceProxyRequest`: a closed connector
id, opaque `credential_ref`, an operation from a closed per-connector
vocabulary, JSON params capped at 16 KiB / depth 5 / 64 keys / 256 array items,
and a timeout clamped to 250–30,000 ms (default 10,000). The result is
re-checked by `deviceProxySuccess`; failures are limited to
`INTEGRATION_UNAVAILABLE`, `RATE_LIMITED`, `POLICY_DENIED`,
`VALIDATION_FAILED`, `NOT_FOUND` and `INTERNAL` with fixed text.

**Current limitation.** No durable connector call-queue table exists, no poll
endpoint is deployed and the worker does not bind the broker. Until a queue
migration lands, the transport is designed only, a single worker process is
assumed, and `NullDeviceProxy` fails every call closed as
`INTEGRATION_UNAVAILABLE`. Do not describe the poll path as available.

### 2.4 Device registration, rotation, revocation and audit

- **Register** writes one `connector_devices` row as `pending` with only the
  token hash. A display name is 1–100 characters and unique per organization.
- **Activate** is a capability-checked status change. `verifyByTokenHash`
  accepts only an `active` row; `pending` and `revoked` devices cannot poll.
- **Connect** writes `connector_credentials` as `pending_validation`, performs
  exactly one cheap read through the device, then flips to `active` or
  `invalid`. The secret is written on the device and never submitted to the
  server.
- **Rotate a credential** replaces the keychain item and updates
  `credential_ref`/`status` on the server (design). There is no ciphertext to
  overwrite and no secret history table. OAuth refresh runs on the device, not
  in the browser and not on the server.
- **Rotate a device token** means register a new device and revoke the old one:
  the repository has no rotate-in-place method. Revocation flips status and is
  immediate for new polls; it cannot recall a call already in flight.
- **Revoke a credential** sets `status = 'revoked'` and keeps the metadata row
  for provenance. The secret remains in the device keychain until the daemon
  deletes it (design); the UI must say so, because the server cannot delete it.
- **Audit** keeps the existing closed vocabulary: `secret.rotate` for connect,
  rotate, revoke and OAuth refresh; `config.change` for device activation and
  tool changes; `tool.execute` for each connector call. `details` carries
  `{ connector, deviceId, outcome, reasonCode }` and never a secret, token,
  token hash, key version, provider message or request header. A new
  `connector.*` action would require an `audit_events` CHECK migration and is
  deliberately avoided.

## 3. Capability gating

New capabilities in `packages/db/src/roles.ts`:

| Capability | owner | admin | member | viewer |
|---|---|---|---|---|
| `connector:read` | yes | yes | yes | yes |
| `connector:use` | yes | yes | yes | no |
| `connector:manage` | yes | yes | no | no |

- Only `connector:manage` may register, activate or revoke a device, or connect,
  verify, rotate, revoke or change the enabled tool set. A device authenticates
  to the poll route with its own token, not with a user session or role.
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

The sandbox does not call the provider. The user's device does; the worker
orchestrates and enforces.

```text
task claimed
  └─► build registry from active devices + active credential metadata
        └─► agent turn ─► tool call ─► strict Zod args
              └─► policy band ─► device broker.resolve(org, connector)
                    └─► typed request (credential_ref, operation, capped params)
                          └─► device daemon poll → keychain secret → provider
                                └─► bounded result → allowlist → redact → cap → hash
                                      └─► untrusted result → model
                                            └─► tool_invocations + audit + ledger
```

- **Per-task registry.** `createConnectorToolRegistry({ organizationId,
  taskId, credentials })` returns only tools whose credential is `active` on an
  `active` device and whose tool is enabled. A connector with no device or no
  credential contributes no tool; it does not contribute a tool that fails
  later. The registry is built after the task is claimed and is immutable for
  the run.
- **Typed schemas.** Every tool has a strict Zod input schema in trusted code.
  Identifiers are typed (repository full name, issue id, time window enum); there
  is no URL, host, query or path parameter authored by the model.
- **Risk bands** follow `packages/mastra/src/tools/policy.ts`:
  `read_only` executes and is audited; `scoped_write` executes and is audited
  with `details.risk`; `sensitive` returns `APPROVAL_REQUIRED` and uses the
  persisted, payload-bound approval; `destructive` and unlisted tools are
  `POLICY_DENIED`. The connector does not get a private policy table.
- **Bounded results.** Per call: 4 provider requests maximum, 16 KiB result,
  50 items, 4,000 characters per item, 10 s timeout. The device response is
  already capped at 16 KiB before parsing; redact before truncation; hash the
  redacted, truncated result; mark `truncated` and return it under the
  untrusted-data heading. A result never contains a credential, a raw log body,
  a full page of provider JSON or a signed download URL.
- **Offline device.** A missing poll response fails the call as
  `INTEGRATION_UNAVAILABLE`; the task continues with the evidence it has, and
  there is no fallback to a server key or another device. A removed device
  contributes no tool at the next registry build.
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
  "requestsPerMinute": null,
  "requestsPerDay": null,
  "eventsPerMonth": 5000,
  "retentionDays": 30
}
```

`freeTierProfileSchema` stores only these four verified numbers; catalog-only
fields (`availability`, `verifiedOn`, `source`, `bytesPerMonth`, `trialDays`)
live on the catalog row and are not copied into the credential. A null number
means "not verified" and is not treated as unlimited. A profile change is a
reviewed catalog edit with the source page and date.

### 5.2 Hard platform budget at about 80%

For every numeric provider limit, the platform budget is
`floor(0.8 × providerLimit)`. It is computed at read time from the profile and
stored on the ledger row, so a profile change applies to the next window and
never rewrites history. The UI shows both numbers and says which is the
provider's. The guard applies to validation reads, context reads and tool calls
alike; a validation call spends budget like any other.

### 5.3 Ledger and atomic consumption

The ledger is the source of truth, not an in-process counter.
`PostgresConnectorUsageLedgerRepository.consume(credentialId, {
limitPerPeriod, period })` both increments and refuses an overage in one
statement:

```sql
INSERT INTO connector_usage_ledger
  (organization_id, credential_id, connector_id, period, request_count,
   error_count, updated_at)
SELECT cc.organization_id, cc.id, cc.connector_id, $2::date, 1, 0, now()
FROM connector_credentials cc
WHERE cc.id = $1
ON CONFLICT (credential_id, period) DO UPDATE
SET request_count = connector_usage_ledger.request_count + 1,
    updated_at = now()
WHERE connector_usage_ledger.request_count < $3::integer
RETURNING request_count;
```

No returned row means the period limit is spent (or the credential row does not
exist); the repository then returns the current count and `consumed: false`.
Two concurrent calls serialize on the unique `(credential_id, period)` row, so
the limit is never exceeded in application memory. `limitPerPeriod` is the
platform guard `floor(0.8 × verified provider limit)` computed by the caller
from the credential's `free_tier_profile`; `period` is a UTC calendar date
(`YYYY-MM-DD`). `error_count` exists but no method increments it yet.

The ledger is per credential, not per organization or endpoint, so reconnecting
a device or adding an endpoint never grants a fresh budget. The per-minute
token bucket and per-day window remain design-only; the implemented repository
counts one UTC day at a time. The worker call site is not wired, so whether a
call is charged before or after the device responds is still a design choice;
there is no refund method. A rejection is `BUDGET_EXCEEDED`, mapped to HTTP
`429` with `Retry-After` for a browser or a bounded tool result for the agent.

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
  `connector_credentials` belongs to one organization and one device. Two teams
  on one deployment can connect the same vendor with different accounts.
- **Path routing.** `POST /api/webhooks/{connector}/{endpointId}`; both segments
  are validated against closed patterns. An unknown pair is `404` with no
  distinction between "unknown" and "another tenant's".
- **Organization from the endpoint row.** The webhook body, query string and
  headers never supply the tenant. The endpoint row supplies it.
- **Per-connector secret.** The endpoint's `webhook_hmac` inbound verification
  secret is platform-held deployment config, not a user provider key. Missing
  is `503`, wrong is `401`; never downgrade to another connector's secret.
- **Dedupe.** `(organization, connector, fingerprint)` for 30 minutes,
  independent of endpoint, so a second endpoint cannot open a duplicate task.
- **One deployment, many orgs.** `CONNECTOR_ROUTING_MODE=path` enables the
  target; `legacy-single-binding` keeps today's env-bound behavior for an
  existing deployment until it is migrated. Both modes never run for the same
  endpoint.
- **No shared counters.** The usage ledger is per credential. Two credentials
  for the same connector do not share a row, and a second device does not
  inherit the first device's budget.

## 7. Failure and security semantics

| Condition | Platform behavior | Tool/context result | User-visible status |
|---|---|---|---|
| `401` invalid or expired key | No retry; mark row `invalid` (the device may refresh OAuth once) | `INTEGRATION_UNAVAILABLE` | `credential_expired`, owner/admin prompted to rotate |
| `403` scope or ACL | `POLICY_DENIED`; drop an optional item; never widen scope | Bounded denial reason | `tool_denied` with the connector's scope hint |
| `404` resource gone | Omit the item; `truncated = true`; no retry | Partial result | `tool_succeeded` with truncation |
| `429` rate limited | Honor `Retry-After`; at most one retry, only for a read | Degraded or `RATE_LIMITED` | `tool_budget_exhausted` or `tool_provider_unavailable` |
| `5xx`, timeout, transport | No retry inside the call; open the circuit | `INTEGRATION_UNAVAILABLE` | `tool_provider_unavailable` |
| Schema/parse drift | Drop the item; count a metric; never pass raw text | `truncated = true` | `tool_succeeded` with truncation |
| Free-tier budget spent | The ledger `consume` returns no row; refuse (call site not wired) | `BUDGET_EXCEEDED` | `tool_budget_exhausted` with reset time |
| Circuit open | Skip the call for 60 s; one half-open probe | `INTEGRATION_UNAVAILABLE` | `tool_provider_unavailable` |
| Credential revoked | No call | `INTEGRATION_UNAVAILABLE` | `credential_revoked` |
| Missing credential | No tool registered | Tool absent | Connector shows "not connected" |
| Device pending or revoked | `verifyByTokenHash` returns null; no call | `INTEGRATION_UNAVAILABLE` | `device_pending` / `device_revoked` |
| Device offline | Queue deadline expires; no server-key fallback | `INTEGRATION_UNAVAILABLE` | `device_offline` |
| Invalid device token | Constant-time mismatch on poll; request refused | No request delivered | `device_revoked` (no token echo) |
| Keychain item missing on device | Device returns a fixed `NOT_FOUND`/`INTERNAL` code | `INTEGRATION_UNAVAILABLE` | `credential_invalid` |

- **No retry storms.** A webhook is never retried by the platform. A read gets
  at most one retry, only after a provider hint. A write is never retried
  automatically; the caller dedupes by delivery id where the provider offers no
  idempotency key.
- **Circuit breaker.** Per `(organization, connector, device)`: open after 5
  consecutive failures in 60 s, stay open for 60 s, allow one half-open probe.
  Open state is process-local and resets on restart; the ledger and status
  columns are durable, and a revoked device is never retried.
- **Partial context is valid.** A missing optional resource never fails a task.
  An empty bundle is absent evidence, never "no problem found".
- **Status is part of the product.** Every degraded path records a bounded code
  on the run timeline and shows the state in the connector page.

## 8. Implementation plan

One connector per wave; contracts first. Each PR is offline-only: fakes, no
network, `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`.

| PR | Scope | Tests | Exit criterion |
|---|---|---|---|
| 1 | Contracts: catalog metadata, `authKind`, `freeTierProfileSchema`, device token/proxy/broker types, new `ToolName` entries and risk bands, `BUDGET_EXCEEDED` mapping | Strict-schema rejects unknown fields; no secret field in any shared type; token is 43 chars, hash is 64 hex; catalog rows match pages | `tsc`, shared/mastra tests green |
| 2 | Migration `0010`; `PostgresConnectorDeviceRepository`, `PostgresConnectorCredentialRepository`, usage-ledger repository, in-memory fakes; `device-token.ts`, `device-proxy.ts`, `device-broker.ts` | Constant-time token verify; pending/revoked device rejected; broker picks an active device+credential; proxy request/response caps; atomic ledger refuses overage; concurrent consume | Repository + integration tests green |
| 2b | Device daemon poll transport and a durable call-queue table (**design; not implemented**) | Fake daemon poll; duplicate request id rejected; queue deadline → `INTEGRATION_UNAVAILABLE`; worker restart keeps queued calls | Only after the queue migration is applied |
| 3 | First adapter: **Sentry** (signed webhook, fixed context plan, `sentry.issue_context` `read_only`) | Fixture signatures; `401/403/429/5xx` mapping; redaction; caps; no network | Integrations tests green |
| 4 | Tool registry binding in the worker: per-task registry, policy, caps, `tool_invocations`, audit, ledger | Denied/unlisted tool; missing/offline device; budget exhaustion; result truncation; registry immutability | Worker tests green, `acceptance:offline` green |
| 5 | Web server actions and states: device registration/activation/revocation, catalog, connect, verify, rotate, revoke, tools, usage | Owner/admin/member/viewer matrix; cross-tenant id; membership re-check in transaction; no secret accepted or returned | Web tests green |
| 6 | Second adapter: **PagerDuty** (signed webhook, incident read tools). Grafana/Prometheus follow only after the one-metrics-vendor rule is satisfied | Same suite as PR 3 plus `ack` band decision | Integrations tests green |
| 7 | Hardening: OAuth refresh on device, circuit breaker, device token rotation, replay protection, trial acknowledgement, catalog page | Refresh once; open/half-open; replayed request dropped; trial disabled by default | Full suite green twice |

Sentry precedes PagerDuty because it answers "what failed, where" without a
paid paging account. PagerDuty is not built in the same wave
(`connector-usage.md` §8). The GitHub App flow stays deployment-level until its
installation id is stored per organization; that migration is a separate PR and
must not change the webhook contract.

### 8.1 What remains is only device registration and one migration

No metered provider read key is added to the environment, because no provider
key reaches the server at all. A tenant credential is a device-held secret plus
a metadata row.

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | web, worker | Existing; the device, credential-metadata and ledger tables live here |
| *device token* | user device only | Generated on the device; only its sha256 hash is stored; never an env value |
| `CONNECTOR_ROUTING_MODE` | web | `path` or `legacy-single-binding` |
| `CONNECTOR_OAUTH_STATE_SECRET` | web | HMAC key for single-use OAuth state, not a provider credential |
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
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` | worker | Existing platform GitHub App identity (server-held by design) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | worker | Existing platform App key path (not a user provider key) |
| `GITHUB_API_BASE_URL` | worker | Existing; default `https://api.github.com` |

Connector-specific names on each page §7 (`SENTRY_API_KEY`,
`PAGERDUTY_API_KEY`, `GRAFANA_TOKEN`, `KAFKA_BRIDGE_*`, and so on) are
**bridge and deployment configuration for a single-tenant operator, never a
tenant credential fallback**. The onboarding code must read none of them; a
code search in CI proves zero reads outside the legacy bridge. This is the
mechanism that keeps the product free: the device's credential is the only one.

Checklist before calling the work done:

- [ ] Migration `0010_connectors.sql` applied by the coordinator; three tables,
      indexes, FKs and CHECKs verified by `\d+`.
- [ ] No secret, ciphertext or key-version column exists; a device token is
      stored only as a sha256 hash and verified in constant time.
- [ ] A durable connector call-queue table exists before the poll transport is
      called production-ready (not implemented).
- [ ] `audit_events` vocabulary unchanged; `tool_invocations` records a digest,
      never arguments or a token.
- [ ] Catalog matches [`free-tier-catalog.md`](connectors/free-tier-catalog.md);
      every `UNVERIFIED` mark carried through.
- [ ] No `.env` value, key, token, token hash or provider secret in the
      repository, fixtures, docs, logs or screenshots.
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
| **Stolen server database** | Dump of `connector_*` tables | No provider secret exists server-side; only metadata, usage counters and sha256 device-token hashes are stored; 256-bit tokens cannot be reversed from a hash | Device names, connector ids and usage metadata leak; no provider key does |
| **Device compromise (critical)** | Malware or a stolen laptop reads the OS keychain | The device is the only secret holder. Least-privilege scopes, OS keychain, short-lived OAuth tokens, immediate device revocation, server never holds a key | An exfiltrated provider secret stays valid until the provider revokes or rotates it; the platform cannot revoke a vendor key it never held |
| Credential exfiltration via prompt | Model asks the user or a file for a key | Provider keys never enter the server, a prompt, task goal or tool schema; no tool returns a credential | A user can still paste a key into a task goal; the redactor and the "never paste secrets" notice are the only defense |
| Exfiltration via tool result | Provider echoes an `Authorization` header or a config dump | Device result capped at 16 KiB; allowlist parse, shared redactor, caps, no raw body | A provider-specific field not on the allowlist is dropped, not shown |
| Exfiltration via logs/audit | Error includes a URL with a token | Fixed error text; audit `details` is a closed set; no request headers, token or token hash | A new code path can regress; tests assert no secret in serialized output |
| Device-token theft and replay | An attacker copies the bearer token from a device | Token is 256 random bits; only its sha256 hash is stored; constant-time compare; revoke flips status and rejects new polls; rotation means register-new/revoke-old | Replay before revocation succeeds; there is no per-request nonce or binding to a client certificate yet |
| Request authenticity / queue poisoning | A compromised or buggy producer enqueues a provider call for a device | Worker-only enqueue; typed request schema; closed operation vocabulary; opaque `credential_ref`; 16 KiB params cap; ledger and audit per call; deterministic device/credential resolution | The proxy model inherently lets the server ask a device to perform allowed operations; request signing and per-request ids are design-only |
| Offline device | Daemon not running, laptop closed, network loss | Fail closed as `INTEGRATION_UNAVAILABLE` after the queue deadline; no server-key or shared-key fallback; task continues with partial evidence | The task loses that connector's evidence until the device returns |
| SSRF via base URL | A self-hosted URL points at a private IP or metadata service | The **device** fetches, not the server; https only, no userinfo/query/fragment, host allowlist, no redirects, connect timeout | A compromised DNS or a provider-side redirect; the device's network position is the new trust boundary |
| Webhook spoofing | Forged delivery to a known endpoint | HMAC over raw bytes, constant-time compare, timestamp window, per-endpoint platform secret, 64 KiB cap | A leaked endpoint secret; rotation is the only remedy |
| Tenant cross-read | Guessing another org's device, credential or endpoint id | Every query carries `organization_id`; FK; membership re-check in the write transaction; cross-tenant id is `FORBIDDEN`; broker checks `device_id` membership | A missing predicate in a new query; repository tests assert the scope |
| Replay | Re-sending a valid webhook, OAuth code or device request | 30-minute dedupe by fingerprint; single-use OAuth state and code; `202` is idempotent; short request expiry (design) | A replay inside the window is deduped, not rejected; device request ids are design-only |
| Quota exhaustion | A flapping alert or an agent loop | Fingerprint dedupe, two-active-task cap, per-task tool caps, 80% ledger budget, `429` with `Retry-After` | A distributed burst across orgs is still provider-visible; the platform stays within its own budget |
| Confused deputy | A member uses an admin's connection | Capability per action; `connector:use` only for enabled read tools; `scoped_write` owner/admin | A misconfigured enabled set; the UI shows every enabled tool |
| OAuth CSRF / mix-up | Attacker-supplied `state` or code | State bound to session, org, connector and a server nonce; PKCE; exact redirect URI; exchange runs on the device | A stolen browser session; the state is single-use |
| Model-authored URL or query | Prompt injection asks for a different host or a wider window | No URL parameter in any tool; closed operations; typed ids; window enums; device-side host allowlist | A provider id that resolves to another tenant's object; provider ACL is the backstop |

**Device token rotation and revocation.** Revocation is a status flip on
`connector_devices` and is checked on every poll; it does not recall an
in-flight call. There is no rotate-in-place method, so rotation registers a new
device and revokes the old one, and the user deletes the old keychain items on
that device. The server cannot delete a secret it never held.

## 10. Relationship to the architecture of record

This page does not change the three planes, the adapter contract, the policy
bands, the context caps or the failure table in
[`connector-usage.md`](connector-usage.md). It adds the user-facing intake, the
credential row shape, the capability split, the free-tier ledger and the
onboarding plan. Where this page is more specific, it is additive:

- `connector_credentials` holds `device_id`, `credential_ref`, `connector_id`,
  `display_name`, `scopes`, `status`, `free_tier_profile`, `last_validated_at`,
  `last_used_at` and `created_by`, with unique names per organization and
  unique `credential_ref` per device+connector. It has no `base_url`, AEAD
  triple, key version or `wrapped_dek`; the tenant FK and metadata-only shape
  replace the earlier encrypted-row design.
- `connector_devices` is new: the token hash and status are the only
  authentication material. There is no analogous table in
  `connector-usage.md`.
- `connector_usage_ledger` is new and is the durable free-tier counter; it
  does not replace `connector_rate_limits`, which remains design-only.
- The tool caps are new; the existing turn, token, cost and sandbox budgets are
  unchanged.
- One earlier divergence is now resolved: §4.3 described rotation as revoking
  the old row and deleting it, and §2.3 assumed ciphertext overwrite. With
  device-held secrets, rotation updates the device keychain item and the
  metadata `credential_ref`/status; there is no ciphertext to overwrite and no
  secret history. `connector-usage.md` §4.3 is read that way.
- GitHub remains deployment-level in this plan, and its App key is server-held
  because it is the platform's own App. The target per-organization GitHub
  installation is a separate, later change and is not claimed here.

The implemented part of this page is the credential foundation: migration 0010,
the three tenant-scoped repositories with fakes, and the device token, proxy and
broker contracts. The connect UI, worker binding and device-daemon poll
transport are designed only. The GitHub and generic-webhook path described in
[`connectors/README.md`](connectors/README.md) remains the only working
connector execution.
