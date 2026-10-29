# Isolate — Autonomous DevSecOps Agent Platform (event build)

> **Event disclosure (hackathon):** Every file in this repository was written during the event week starting **October 27, 2026**, in a fresh git history. A pre-event spike (the compatibility MVP that validated the stack) lives in a **separate private repository** (`ivory-26/isolate`); none of its code, history, or scaffolding has been committed here.

An autonomous DevSecOps control plane: accept an engineering task, plan and implement a change with a Mastra agent runtime inside a durable worker, validate it through a bounded repair loop, and emit reviewable pull requests — with policy gates, approvals, and audit at every boundary.

**Stack**: Bun workspaces · TypeScript · Mastra (`@mastra/core`) as agent/workflow runtime · Neon PostgreSQL as system of record (data plane) · Zod everywhere · Biome · Bun test · OpenAI-compatible model providers (Baseten Muse Spark Open planned for the provider plane).

## What is built in this repo (event week)

| Area | Package / app | Status |
|---|---|---|
| Shared contracts: result/error codes, task state machine, event vocabulary, logging + redaction | `packages/shared` | implemented + tested |
| Data plane: Neon schema, repositories, atomic-claim durable queue, payload-bound approvals | `packages/db` | implemented (tests in progress) |
| Orchestration runtime: SDLC agent workflow with bounded repair + approval suspension | `packages/mastra` | in progress |
| Visual workflow registry/validation/compiler (no eval, version-pinned) | `packages/workflow-schema` | implemented (tests in progress) |
| GitHub connector foundations: PR creation, redaction, audit sink, approval gating | `packages/integrations` | implemented (tests in progress) |
| Durable worker: poll/claim/heartbeat/ack lifecycle, reapers, graceful stop | `apps/worker` | implemented |

## What is deliberately not here (phase roadmap)

Sandbox execution plane, visual editor UI, auth/multi-tenancy — scheduled next within the event; see `project/TASKS.md`.

## Layout

```text
apps/worker/          durable task consumer and run lifecycle
packages/shared/      contracts: state machine, errors, events, logging
packages/db/          Neon client, schema migrations, repositories, queue
packages/mastra/      agent runtime, typed policy-gated tools, SDLC workflow
packages/workflow-schema/ node registry, graph validation, compiler
packages/integrations/ GitHub/MCP connector foundations
```

## Commands

| Command | What it does |
|---|---|
| `bun install` | workspace install |
| `bun run check` | Biome (lint + format) |
| `bun run typecheck` | tsc per project (strict) |
| `bun run test` | Bun test (live-DB tests skip without `DATABASE_URL`) |
| `bun run validate` | check + typecheck + test |
| `bun run dev:worker` | worker (reads `.env` at repo root; create from `.env.example`) |

CI: `.github/workflows/ci.yml` runs the same gates on every PR + push, with advisory gitleaks secret scanning.

## Environment

Copy `.env.example` → `.env` (never commit it). Values are loaded server-side only; no secret ever reaches browser code, model prompts, or logs (redaction is enforced in shared logging).

## Provider credits (strict)

Baseten (Muse Spark Open) and Modal (sandboxes) are credit-funded and shared. **API keys are the last step of a wave:** all code, fakes, tests, builds and merges must pass with `INFERENCE_PROVIDER=none` and `SANDBOX_PROVIDER=null` before any credential is added. Live verification is one bounded acceptance pass; no exploratory, benchmark, or retry-loop calls; CI never receives provider keys. Full policy: `AGENTS.md` §Provider credits.
