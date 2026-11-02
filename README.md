# Isolate — Autonomous DevSecOps Agent Platform (event build)

> **Event disclosure (hackathon):** Every file in this repository was written during the event week starting **October 27, 2026**, in a fresh git history. A pre-event spike (the compatibility MVP that validated the stack) lives in a **separate private repository** (`ivory-26/isolate`); none of its code, history, or scaffolding has been committed here.

Isolate is an **event-first DevSecOps control plane**. Customers connect GitHub and their own DevSecOps tools once. Signed events create durable tasks, a Mastra agent investigates and edits inside a disposable Modal sandbox, validation and acceptance decide completion, and pushes/PRs wait at payload-bound human approvals. Provider credentials stay on a customer-controlled relay, never in the server, browser, prompt or sandbox.

**Stack**: Bun workspaces · TypeScript · TanStack Start/Router/Query · Mastra (`@mastra/core`) · Neon PostgreSQL · Zod · Biome · Bun test · OpenAI-compatible Muse models (Meta Model API for dev/pre-production, Baseten for production) · Modal sandboxes.

## Start here

| Document | Why |
|---|---|
| [`docs/USER-SETUP.md`](docs/USER-SETUP.md) | Web-first customer flow: GitHub App → relay install → source pairing → triggers |
| [`docs/spec.md`](docs/spec.md) | Managed integrations and autonomous event-driven agent specification |
| [`project/STATUS.md`](project/STATUS.md) | Current wave, exact gates, applied migrations and known gaps |
| [`project/WAVE23.md`](project/WAVE23.md) | Event-first redesign, page map, lane ownership and contracts |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Control plane, worker, sandbox, tenancy and security boundaries |

## What is built

| Area | Package / app | Status |
|---|---|---|
| Shared contracts: result/error codes, task state machine, event vocabulary, incident/context, integrations, logging + redaction | `packages/shared` | implemented + tested |
| Data plane: Neon schema through migration `0016`, repositories, atomic-claim durable queue, payload-bound approvals, connector devices/credentials/calls/ledger, GitHub installations, trigger subscriptions and event receipts | `packages/db` | implemented + tested |
| Agent/tool plane: Mastra runtime, policy-gated typed tools, sandbox tool backend, ten connector tool bindings | `packages/mastra` | implemented + tested |
| Workflow registry/validation/compiler (no eval, version-pinned) | `packages/workflow-schema` | implemented + tested |
| GitHub connector: App JWT → per-installation token, reads, scoped writes, webhook verification, installation repository listing | `packages/integrations` | implemented + tested |
| Sandbox: deny-by-default provider, Modal adapter, command policy, Git workspace, validation command | `packages/sandbox` | implemented + tested |
| Durable worker: poll/claim/heartbeat/ack, lifecycle, validation/acceptance, approvals, retries, leases, tracing | `apps/worker` | implemented + tested |
| Web control plane: public landing, Neon Auth/Google, event-first Home, Inbox, Runs + execution map, Approvals, Integrations, Repositories, Delegates, Usage, Settings, onboarding | `apps/web` | implemented + tested |
| Device relay: outbound polling, typed connector dispatch, local encrypted secret store, loopback pairing page, one-line installer | `apps/device-daemon` | implemented + tested |
| Ten connectors: GitHub, Sentry, Grafana, PagerDuty, Kubernetes, Datadog, New Relic, Honeycomb, Axiom, SigNoz | device + server adapters | implemented; browser pairing verification pending |

## Event-first flow

```text
provider/webhook ─► verify ─► normalize ─► dedupe ─► subscription policy ─► durable task
                                                               │
GitHub App install ─► repository picker ───────────────────────┤
relay pairing ─► device-held secret ─► typed connector calls ──┤
                                                               ▼
worker: context bundle ─► Modal sandbox ─► validation/acceptance ─► approval ─► push/PR
                                                               │
Home/Inbox ◄── event receipts and task links ◄──────────────────┘
```

The webhook never runs an agent or fetches provider data synchronously. A duplicate delivery is recorded as `deduplicated`; resolved lifecycle events update the incident without opening a new task. Manual delegation remains available as a secondary composer.

## Layout

```text
apps/web/              TanStack Start control plane and public landing
apps/worker/           durable task consumer and run lifecycle
apps/device-daemon/    customer relay, local secret store and pairing server
packages/shared/       contracts: state machine, incidents, integrations, logging
packages/db/           Neon client, migrations, repositories, queue
packages/mastra/       agent runtime, typed policy-gated tools
packages/workflow-schema/ node registry, graph validation, compiler
packages/integrations/ GitHub and vendor adapter foundations
packages/sandbox/      Modal sandbox, command policy, Git workspace
docs/                  setup, connector, tracing, scaling and spec documents
project/               status, tasks, decisions, security and wave records
```

## Commands

| Command | What it does |
|---|---|
| `bun install` | workspace install |
| `bun run check` | Biome (lint + format) |
| `bun run typecheck` | tsc per project (strict) |
| `bun --no-env-file test` | Bun test; live-Neon tests skip without `DATABASE_URL` |
| `bun run validate` | check + typecheck + test |
| `bun run dev:web` | web app at http://localhost:3000 (loads `.env` from the repo root) |
| `bun run dev:worker` | worker (reads `.env` at repo root; create from `.env.example`) |
| `bun --no-env-file scripts/acceptance-offline.ts` | offline end-to-end acceptance, zero provider credentials |
| `bun run security:check` | client/server secret-boundary scan |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, the web build, the client secret sweep and blocking gitleaks on every PR and push.

## Environment

Copy `.env.example` → `.env` (never commit it). Values are loaded server-side only; no secret reaches browser code, prompts, logs or the sandbox. Customer provider keys are **not** deployment env values: they are entered on the relay's loopback pairing page and stored in its local encrypted store. The platform holds only its own GitHub App identity, webhook HMAC secrets and database credentials. See `docs/USER-SETUP.md` §8 for the operator checklist.

## Provider credits (strict)

Baseten (Muse Spark Open) and Modal (sandboxes) are credit-funded and shared. **API keys are the last step of a wave:** all code, fakes, tests, builds and merges must pass with `INFERENCE_PROVIDER=none` and `SANDBOX_PROVIDER=null` before any credential is added. Live verification is one bounded acceptance pass; no exploratory, benchmark, or retry-loop calls; CI never receives provider keys. Full policy: `AGENTS.md` §Provider credits.
