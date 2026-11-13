# Isolate

Isolate is an event-first DevSecOps control plane. Teams connect GitHub and their own
DevSecOps tools once. Signed provider events become durable tasks; a Mastra agent
investigates and edits inside a disposable Modal sandbox; validation and acceptance
decide completion; and pushes or pull requests wait at payload-bound human approvals.
Provider credentials stay on a customer-controlled relay and never enter the server,
browser, prompt, logs or sandbox.

**Stack**: Bun workspaces · TypeScript · TanStack Start/Router/Query · Mastra
(`@mastra/core`) · Neon PostgreSQL · Zod · Biome · Bun test · OpenAI-compatible Muse
models (Meta Model API for development, Baseten for production) · Modal sandboxes.

## Contents

- [Documentation](#documentation)
- [What is built](#what-is-built)
- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Environment](#environment)
- [Provider credits](#provider-credits)
- [Contributing](#contributing)
- [Hackathon disclosure](#hackathon-disclosure)
- [License](#license)

## Documentation

| Document | Purpose |
|---|---|
| [`docs/USER-SETUP.md`](docs/USER-SETUP.md) | Web-first customer flow: GitHub App, relay install, source pairing and triggers |
| [`docs/spec.md`](docs/spec.md) | Managed integrations and autonomous event-driven agent specification |
| [`project/STATUS.md`](project/STATUS.md) | Current wave, exact gates, applied migrations and known gaps |
| [`project/WAVE23.md`](project/WAVE23.md) | Event-first redesign, page map, lane ownership and contracts |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Control plane, worker, sandbox, tenancy and security boundaries |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, workflow, gates and pull request checklist |
| [`SECURITY.md`](SECURITY.md) | Supported versions and private vulnerability reporting |

## What is built

| Area | Package or app | Status |
|---|---|---|
| Shared contracts: result and error codes, task state machine, event vocabulary, incident and context models, integrations, logging and redaction | `packages/shared` | implemented and tested |
| Data plane: Neon schema through migration `0016`, repositories, atomic-claim durable queue, payload-bound approvals, connector devices, credentials, calls and ledger, GitHub installations, trigger subscriptions and event receipts | `packages/db` | implemented and tested |
| Agent and tool plane: Mastra runtime, policy-gated typed tools, sandbox tool backend, ten connector tool bindings | `packages/mastra` | implemented and tested |
| Workflow registry, validation and compiler (no `eval`, version-pinned) | `packages/workflow-schema` | implemented and tested |
| GitHub connector: App JWT, per-installation token, reads, scoped writes, webhook verification, installation repository listing | `packages/integrations` | implemented and tested |
| Sandbox: deny-by-default provider, Modal adapter, command policy, Git workspace, validation command | `packages/sandbox` | implemented and tested |
| Durable worker: poll, claim, heartbeat, acknowledge, lifecycle, validation and acceptance, approvals, retries, leases and tracing | `apps/worker` | implemented and tested |
| Web control plane: public landing, Neon Auth with Google, event-first Home, Inbox, Runs and execution map, Approvals, Integrations, Repositories, Delegates, Usage, Settings and onboarding | `apps/web` | implemented and tested |
| Device relay: outbound polling, typed connector dispatch, local encrypted secret store, loopback pairing page, one-line installer | `apps/device-daemon` | implemented and tested |
| Ten connectors: GitHub, Sentry, Grafana, PagerDuty, Kubernetes, Datadog, New Relic, Honeycomb, Axiom and SigNoz | device and server adapters | implemented; verification probes tested offline, SaaS live acceptance pending |

## How it works

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

The webhook never runs an agent or fetches provider data synchronously. A duplicate
delivery is recorded as `deduplicated`; resolved lifecycle events update the incident
without opening a new task. Manual delegation remains available as a secondary
composer.

## Repository layout

```text
apps/web/                 TanStack Start control plane and public landing
apps/worker/              durable task consumer and run lifecycle
apps/device-daemon/       customer relay, local secret store and pairing server
packages/shared/          contracts: state machine, incidents, integrations, logging
packages/db/              Neon client, migrations, repositories, queue
packages/mastra/          agent runtime, typed policy-gated tools
packages/workflow-schema/ node registry, graph validation, compiler
packages/integrations/    GitHub and vendor adapter foundations
packages/sandbox/         Modal sandbox, command policy, Git workspace
docs/                     setup, connector, deployment and specification documents
project/                  status, tasks, decisions, security and wave records
scripts/                  acceptance, migration, typecheck and security tooling
```

## Getting started

Requirements: [Bun](https://bun.sh/) 1.4.4 and Git. A Neon PostgreSQL database is
needed only for the live-database integration tests; those skip automatically when
`DATABASE_URL` is unset.

```bash
git clone https://github.com/ivory-26/isolate-platform.git
cd isolate-platform
bun install --frozen-lockfile
cp .env.example .env
bun run dev:web
```

No provider API key is required to develop, test or build. Keep the offline defaults
(`INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`) unless a maintainer authorizes a
bounded acceptance run. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## Commands

| Command | What it does |
|---|---|
| `bun install` | Workspace install |
| `bun run check` | Biome lint and format check |
| `bun run typecheck` | TypeScript per project, strict |
| `bun --no-env-file test` | Bun test; live-Neon suites skip without `DATABASE_URL` |
| `bun run validate` | check, typecheck and test |
| `bun run dev:web` | Web app at http://localhost:3000 (loads `.env` from the repository root) |
| `bun run dev:worker` | Worker (reads `.env` at the repository root) |
| `bun --no-env-file scripts/acceptance-offline.ts` | Offline end-to-end acceptance with zero provider credentials |
| `bun run security:check` | Client and server secret-boundary scan |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, the web production build, the
client secret sweep, tests, offline acceptance and blocking gitleaks on every pull
request and push to `main`.

## Environment

Copy `.env.example` to `.env` and never commit it. Values are loaded server-side only;
no secret reaches browser code, prompts, logs or the sandbox. Customer provider keys
are not deployment environment values: they are entered on the relay's loopback pairing
page and stored in its local encrypted store. The platform holds only its own GitHub
App identity, webhook HMAC secrets and database credentials. See
[`docs/USER-SETUP.md`](docs/USER-SETUP.md) §8 for the operator checklist.

## Provider credits

Baseten (Muse Spark Open) and Modal sandboxes are credit-funded and shared. API keys
are the last step of a wave: all code, fakes, tests, builds and merges must pass with
`INFERENCE_PROVIDER=none` and `SANDBOX_PROVIDER=null` before any credential is added.
Live verification is one bounded acceptance pass, with no exploratory, benchmark or
retry-loop calls. CI never receives provider keys. Full policy: [`AGENTS.md`](AGENTS.md)
§ Provider credits.

## Contributing

Contributions are welcome after the event. Read [`CONTRIBUTING.md`](CONTRIBUTING.md)
before opening a pull request. In short: branch from `main`, keep the change scoped,
run the offline gates twice, add tests, update the docs and never commit a credential.
Report vulnerabilities privately through [`SECURITY.md`](SECURITY.md), not in a public
issue.

## Hackathon disclosure

Isolate was built for a hackathon. Every file in this repository was written during the
event week starting **October 27, 2026**, in a fresh git history. A pre-event spike that
validated the stack lives in a separate private repository (`ivory-26/isolate`); none
of its code, history or scaffolding has been committed here.

The project was **not submitted to the hackathon on time**. Circumstances during the
event week meant the submission deadline was missed, and the work was published
afterward as a complete record rather than an entry. Nothing in this repository should
be read as a judging submission, placement or award claim.

The repository is maintained on a best-effort basis. Status, known gaps, wave records,
security audits and the exact gate results at publication are documented in
[`project/STATUS.md`](project/STATUS.md), [`project/TASKS.md`](project/TASKS.md),
[`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md) and [`project/SECURITY.md`](project/SECURITY.md).

## License

Released under the [MIT License](LICENSE).
