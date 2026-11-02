# Wave 23 — Event-first redesign and web onboarding

Status: implementation in progress (2026-11-02)
Design sources: [`docs/spec.md`](../docs/spec.md), [`docs/connector-onboarding.md`](../docs/connector-onboarding.md), [`project/design.md`](design.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md)
Migration: `packages/db/migrations/0016_integration_onboarding.sql` (approved, not yet applied)

## 1. What is already real

The backend is complete through wave 21: Neon Auth + Google, tenancy and capabilities,
durable task queue, worker lifecycle, Modal sandbox, diff/acceptance/validation gates,
payload-bound approvals, PR creation, retry lineage, GitHub App reads and scoped writes,
ten device-held connectors, connector call queue, trace read API, usage records,
audit, rate limits, OTLP. The web app has a landing page, auth, overview, runs,
approvals, repositories, workflows library, usage, settings, devices/connectors.
2,600+ tests pass; 0010–0015 are applied.

## 2. What is missing or wrong

1. The product is **not event-first**. The primary action is a manual task form that
   asks for repository UUIDs, a branch, a workflow version and budgets. That is an
   operator form, not an autonomous product.
2. Onboarding is engineer-shaped: register a device by hand, paste an opaque keychain
   name, register a repository by full name, export a token, set env vars, restart the
   daemon. None of it is a guided browser flow.
3. GitHub is deployment-bound (`GITHUB_APP_INSTALLATION_ID`), not per organization.
   A second customer cannot install the App and use their own repositories.
4. Event evidence is invisible. Signals are persisted but there is no inbox, no delivery
   ledger, no trigger policy UI and no source health.
5. The run detail shows a timeline but not the execution/agent tree. No multi-agent
   delegation is implemented in the backend; do not pretend otherwise.
6. Long tables either truncate silently or use an inner scrollbar (usage) and cramped
   cells. There is no pagination primitive.
7. Auth/signup and dashboard loads have avoidable waterfalls and layout jitter. The
   landing hero copy carries a text shadow the user explicitly wants removed.
8. The docs describe the connect UI/transport as unwired; that is stale. Refresh the
   status tables instead of trusting the old wording.

## 3. Target product model

An integration has three independent capabilities: **event source**, **context provider**
and **action provider**. The UI shows them separately. Credentials stay customer-held.
Events create tasks; tasks run through the existing durable worker.

### Primary navigation

| Destination | Purpose |
|---|---|
| Home `/overview` | Inbox, Needs you, Running now, Sources, setup checklist |
| Inbox `/inbox` | Event deliveries, source, severity, matched rule, status, task link |
| Runs `/runs` | Execution history, source filter, run detail with execution map |
| Approvals `/approvals` | Pending payload-bound decisions |
| Integrations `/integrations` | Catalog, connected sources, relays, trigger rules |
| Repositories `/repositories` | GitHub App installation and repository selection |
| Usage `/usage` | Measured tokens/sandbox/cost, paginated |
| Settings `/settings` | Workspace, members, policy |

Manual delegation is secondary: a topbar action and a two-field composer at `/submit`
(repository + goal; acceptance criteria optional; workflow/branch/budgets under
"Advanced"). Workflows leave primary navigation but the route remains available.

### Onboarding flow

`/onboarding` is the first destination for an organization with no repository, relay,
connection or trigger. Steps:

1. **GitHub** — install the Isolate App, return through `/api/github/callback`, select
   repositories from `GET /installation/repositories`, import them.
2. **Relay** — register a relay, show a one-line install command containing the device
   token once, wait for the first heartbeat.
3. **Source** — choose a connector from the catalog. The browser starts a pairing
   session; a localhost page served by the relay receives the provider secret and stores
   it in the relay's encrypted local store. The server receives metadata only.
4. **Autonomy** — create the default trigger (production, critical/high, prepare fix) and
   map it to a repository.
5. **Ready** — land on Home with the first source card and inbox empty state.

The checklist is also rendered on Home until every step is complete. A new signup
redirects to `/onboarding`, not to an empty dashboard.

### Relay pairing flow (customer-held secret)

```
browser (owner/admin)                 server                         relay daemon (127.0.0.1)
  POST /api/device/pairing  ───────►  connector_pairings (code hash)
  GET localhost:47821/pair?code=... ───────────────────────────────►  claim code (device auth)
                                                                     stores secret encrypted locally
  poll pairing status       ◄──────  completed (metadata row)  ◄────  POST /api/device/pairing/complete
```

Rules: code is random 256-bit, shown once, 10-minute expiry, only 127.0.0.1, no CORS,
one-time; the server never receives the secret; the relay writes `~/.isolate/secrets.json`
with 0600 permissions and AES-256-GCM using a key derived from the device token.
Env-var secrets remain a compatibility fallback, never the product path.

## 4. Lane ownership (one owner per path)

| Lane | Owns | Does not touch |
|---|---|---|
| CORE / coordinator | `packages/db/migrations/0016*`, `project/*`, `docs/*`, root scripts | feature code |
| GITHUB | `packages/shared/**` event contracts, `packages/db/src/**` new repositories, `packages/integrations/src/github/**`, `apps/web/src/server/github-*.ts`, `apps/web/src/routes/api.github.*`, `apps/web/src/features/repositories/*.functions.ts`, `apps/web/src/features/repositories/contracts.ts` | UI components |
| RELAY | `apps/device-daemon/**`, `packages/db/src/**` pairing repository, `apps/web/src/server/device-pairing.server.ts`, `apps/web/src/server/connector-connect.server.ts`, `apps/web/src/routes/api.device.pairing*.tsx`, `apps/web/src/routes/api.connectors.*` | web UI components |
| EVENTS | `apps/web/src/server/incident-intake*.ts`, `apps/web/src/server/webhook-*.ts`, `apps/web/src/server/inbox-read.server.ts`, `apps/worker/src/**` autonomy/GitHub resolver, `packages/db/src/**` subscription/delivery repositories | web UI components |
| UI-SETUP | `apps/web/src/features/onboarding/**`, `features/integrations/**`, `features/devices/**`, `routes/_app.onboarding.tsx`, `routes/_app.integrations*.tsx`, `routes/_app.devices.tsx`, `components/shell/nav.ts`, `routes/_app.tsx` | server actions, db |
| UI-HOME | `apps/web/src/features/overview/**`, `features/inbox/**`, `features/tasks/**`, `routes/_app.overview.tsx`, `routes/_app.inbox.tsx`, `routes/_app.submit.tsx`, `features/repositories/repositories-view.tsx`, `routes/_app.repositories.tsx` | nav, run screens |
| UI-RUNS | `apps/web/src/features/runs/**`, `features/approvals/**`, `routes/_app.runs*.tsx`, `routes/_app.approvals.tsx`, `server/runs-read.server.ts`, `server/approvals-read.server.ts` | overview, shell |
| TABLES | `apps/web/src/components/ui/table.tsx`, `components/console/data-table.tsx`, `components/common/pagination.tsx`, `features/usage/**`, `features/landing/landing.css` (hero shadow only) | feature pages owned above |
| PERF | `apps/web/src/router.tsx`, `routes/__root.tsx`, `features/auth/**`, `components/auth/**`, `routes/login.tsx`, `routes/signup.tsx`, `components/brand/**`, `components/GradientASCII.tsx`, `components/dither-kit/**` | feature pages |

Shared files (`styles.css`, `package.json`, root lockfile, `routeTree.gen.ts`) are
coordinator-only; lanes ask for a change instead of editing them.

## 5. Server contracts (frozen for UI lanes)

All return `ServiceResult<T>` (`{ ok: true, value } | { ok: false, error: { code, message } }`)
unless noted, and are capability-checked server-side.

### Setup and GitHub

- `getSetupState()` → `{ githubConnected, relayActive, connectionActive, triggerEnabled, firstRun, complete }`
- `getAuthState` unchanged.
- `startGitHubInstall()` → `{ url }` (302 route also available at `/api/github/install`)
- `listInstallationRepositories()` → `{ repositories: [{ fullName, defaultBranch, private, installationId }] }`
- `importRepositories({ fullNames: string[] })` → `{ imported: [{ id, fullName, defaultBranch }], skipped: string[] }`

### Relays and pairing

- `listRelays()` → `{ relays: [{ id, displayName, status, lastSeenAt, version }] }`
- `registerRelay({ displayName })` → `{ relayId, token, expiresAt }` (token once)
- `revokeRelay({ relayId })` → `{ status: "revoked" }`
- `createPairing({ relayId, connectorId, displayName, authKind, credentialRef, scopes? })` →
  `{ pairingId, code, localUrl, expiresAt }`
- `getPairing({ pairingId })` → `{ status, credentialId? }`
- `cancelPairing({ pairingId })` → `{ status: "cancelled" }`

### Integrations and triggers

- `listIntegrations()` → `{ integrations: IntegrationSummary[] }`
- `getIntegration({ connectorId })` → `{ connection, subscriptions, deliveries, usage }`
- `saveSubscription(input)` → `{ subscription }`
- `setSubscriptionEnabled({ id, enabled })` → `{ subscription }`
- `deleteSubscription({ id })` → `{ status: "deleted" }`
- `listDeliveries({ connectorId?, limit? })` → `{ deliveries: EventDelivery[] }`
- `listInbox({ status?, source?, limit?, cursor? })` → `{ items: EventDelivery[], nextCursor }`

`IntegrationSummary` carries connector id, label, capabilities, connection status,
relay name/status, last verified/event, enabled tools, trigger count, usage counters.
`EventDelivery` carries id, source, eventKind, severity, title, summary, status,
reasonCode, repository, taskId, receivedAt, links. Never a payload, credential or token.

### Onboarding redirect

`_app` loader redirects to `/onboarding` only when `getSetupState().complete === false`
**and** the request is not already on `/onboarding`, `/settings`, or `/organizations`.
Existing populated workspaces must not be forced through onboarding; gate on
`firstRun === false && no repo && no relay && no connection`.

## 6. Migration 0016

Creates `github_installations`, `integration_subscriptions`, `event_deliveries`,
`connector_pairings`; adds `repositories.github_installation_id`,
`tasks.autonomy_level`, and bounded display fields to `incident_signals`.
No secret column. Pairing codes are sha256 hashes. Apply only after coordinator review
and with explicit user approval (already given).

## 7. Acceptance criteria

- A new owner can connect GitHub, install a relay and connect Sentry without editing
  `.env` or pasting a provider key into the browser.
- A signed GitHub failure at/above the default threshold creates one task, links it to
  the delivery, and shows it in Inbox and Home.
- A duplicate delivery is recorded as `deduplicated` and creates no second task.
- The relay stores the secret locally; a database dump contains metadata only.
- Run detail exposes an execution map built from real events (task → attempt → agent
  turn → tool/connector/validation/approval/artifact). No fabricated subagents.
- Every table that can exceed one page exposes pagination and no inner scrollbar; cells
  have left/right padding.
- Landing hero has no text shadow; reduced motion stays honored.
- Auth/signup navigation paints the shell from cache without an anonymous flash; the
  dashboard's first data paint has no avoidable client-only waterfall.
- Offline gates pass twice: scoped biome, `bun scripts/typecheck-all.ts`, web tests,
  `bun run acceptance:offline`, `bun run security:check`.
