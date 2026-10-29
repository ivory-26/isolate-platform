# Decisions log

Dated; one entry per decision: decision — rationale — alternatives rejected.

## 2026-10-27 — Event repo split (hackathon compliance)
- Decision: all event-week work lives here (`isolate-platform`, fresh history). The pre-event spike stays out (separate repo). Agents' transplanted work was produced during the event; the legacy app's `apps/web`, its migration, and Oct-25 docs were excluded.
- Rationale: hackathon rules require a standalone extract with only event-week code; "copied scaffolding written before kickoff must be rewritten" — byte-for-byte ports of legacy logic (notably `packages/db/src/client.ts`) are assigned for fresh rewrites.

## 2026-10-27 — Monorepo skeleton + contracts-first worktree swarm
- Decision: Bun workspaces (`apps/*`, `packages/*`); every cross-package TS contract is committed before implementation; each agent gets one worktree + one branch and is forbidden from root files (`package.json`, `bun.lock`, root tsconfigs/`biome.json`), `.github`, and root `project/*`.
- Rationale: root/lockfile edits are the only files shared by all worktrees; centralizing them eliminates the merge-deadlock class. Contracts-first is the proven spike technique scaled to cross-package.
- Alternatives rejected: agents creating their own package skeletons (lockfile conflicts); one shared worktree (violates no-concurrent-writers).

## 2026-10-27 — Workspace tooling: Bun workspaces + per-project tsc via driver script
- Decision: each project keeps its own tsconfig extending `tsconfig.base.json` (no composite/refs); `typecheck` iterates projects, skipping absent dirs; `bun test` at root discovers all workspace tests; live-DB tests skip without `DATABASE_URL`.
- Rationale: zero new tooling, strict noEmit checks, resilient to the pending fresh web scaffold.

## 2026-10-27 — Neon data plane: new event-owned project; MVP project purged
- Decision: this repo now uses the NEW Neon project `isolate-platform` (`divine-butterfly-60669535`, Pg 17, aws-us-west-2); the old MVP project (`isolate-mvp`, `dark-dream-15274602`, created Oct 25) was verified spike-only (single `agent_smoke_test_runs` table) and then **deleted**.
- Rationale: compliance isolation — the event codebase must not touch infrastructure that holds pre-event code/data; a fresh project guarantees no shared state with the MVP spike.
- Migration `0001_platform_core.sql` applied via `scripts/apply-migration.ts` (repo-native, idempotent, statement-splitting runner); 18 tables verified. End-to-end live suite: 28/28.

## 2026-10-27 — jsonb decode contract at the row-mapping boundary
- Decision: every repository row mapper passes jsonb columns through `parseJsonbColumn` (client.ts). Drivers may legitimately return jsonb as a **raw JSON string** on Neon pooled endpoints when the value passed a param binding (empirically proven with literal vs mast bound probes: literal `::jsonb` decodes to object, `$1`-bound values return string).
- Rationale: the TS row contract must hold regardless of driver decode path; storage itself was always correct (single-encoded).
- Alternatives rejected: driver `types:` parser override (fragile across Bun/postgres.js versions and risks double-serializing the write path), normalizing in every consumer (drift-prone).

## 2026-10-27 — Transition failure classification: CONFLICT wins over pair legality
- Decision: `PostgresTaskRepository.transition` classifies against the REAL current status (CONFLICT when `expectedStatus ≠ actual`, regardless of whether the pair itself is legal) — the same ordering the pure `guardTransition` helper and the in-memory fake already encode. The original fast-path guard pre-checked the pair using the stale `expectedStatus`, misclassifying stale-expectation calls as INVALID_TRANSITION; the live Neon suite caught it.
- Rationale: lost races are a caller-actionable condition; an outdated expectation is a lost race first, a bad state-machine call only if the expectation was still valid.

## 2026-10-27 - Wave 2 integration: cross-package contract proposals reviewed and DEFERRED
- Decision: proposals from B1 (`JobRow.lease`/`lastError` totality, `WorkerConfig.jobTimeoutMs` promotion) and B3 (compiled_plans + workflow-definition version tables, workflow event schemas in shared) are recorded but NOT applied in wave 2. Wave-3 work items, owner-assigned at that point.
- Rationale: wave-2 gates are green without them (all consumers already use `== null` guards / test-seam overrides, so the changes are ergonomics, not correctness); applying cross-package edits mid-merge would violate the ownership-freeze discipline that delivered zero merge conflicts.
- Wave-3 resolution (coordinator pre-commit): B1 totality proposal verified ALREADY SATISFIED — `JobRow.lease`/`lastError` are declared total nullable (`field | null`, no `?`) in `packages/db/src/repositories/queue-repository.ts`, fakes/drivers conform, consumers use `== null` guards; no code change required. `WorkerConfig.jobTimeoutMs` promoted via `workerConfigSchema` (optional-with-default, bounds 1000-3600000, default 120000) — apps/worker consumes it in wave 3 on `task/w3-worker`. B3 schema proposal becomes migration `0002_workflow_compilation.sql` (`compiled_plans`, `rejection_issues`, version-pinned) owned by `task/w3-db`; plan-shape alignment with the compiler is recorded as follow-up coordination after both report (no cross-agent shared-file coupling).

## 2026-10-27 — Bounded SDLC mapping on installed Mastra d.ts (from B2 verification, ratified)
- Decision: the SDLC machine runs as `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created`; the loop body runs validation then at most one repair turn while budget allows, with `repairAttemptsUsed` persisted in workflow state.
- Rationale: installed @mastra/core loop primitives accept single-step bodies; multi-step loops/impose if/else are not expressible — template stays serializable (`defaultSdlcPlan`), runtime uses the dountil shape.
- Alternatives rejected: linear ladder (mirrors repairing unconditionally), custom orchestration framework (against ARCHITECTURE.md §12).

## 2026-10-27 — CI: GitHub Actions gates + advisory gitleaks
- Decision: frozen-lockfile install → biome → typecheck-all → test on every push/PR; gitleaks advisory until scan noise is reviewed.
- Rationale: automated secret scanning was demanded by the legacy repo's leaked-token history (documented in its private repo); advisory prevents blocking on unknown patterns until triaged.

## 2026-10-29 — Wave 3 integration: content-hash reconciliation, zero overwrites
- Decision: each uncommitted `task/w3-*` worktree was committed on its own branch, then merged into `main` with `--no-ff`; duplicated files carried by more than one worktree were reconciled by **content hash** first. `task/w3-db` and `task/w3-wfschema` were treated as canonical owners of their packages; `w3-web`'s duplicate `packages/db`/`packages/workflow-schema` copies (identical except an older `db/src/index.ts`) were backed up (`/tmp/w3-web-dupes-backup/packages-dupes.tar`) and dropped so only `apps/web` came from that branch.
- Rationale: "no conflicts, no overwrites" is satisfied by ownership discipline, not by merge-tool luck — comparing hashes proves a duplicate is redundant before it is discarded, and the backup makes the discard reversible.
- Alternatives rejected: three-way merging duplicate package trees (reintroduces the exact divergence the parallel-wave design prevents); deleting duplicates without a backup (irreversible if a hash comparison was wrong).

## 2026-10-29 — Migration 0002 applied; `JSON.stringify` params bind as `::text::jsonb`
- Decision: `0002_workflow_compilation.sql` is applied to Neon `isolate-platform` via the repo-native `scripts/apply-migration.ts` (idempotent, statement-split, verifies the full 20-table set). All new JSON writes bind `$n::text::jsonb`, not `$n::jsonb`.
- Rationale: postgres.js stringifies a JS string parameter before it reaches a `jsonb` cast, so `$4::jsonb` stores the *JSON text as a JSON string* (`jsonb_typeof = 'string'`). `0001` never noticed because `parseJsonbColumn` parses the double-encoded value on read; `0002`'s `jsonb_typeof(plan) = 'object'` CHECK made it a hard failure. `::text::jsonb` forces the driver to keep the string and lets Postgres parse the JSON itself.
- Alternatives rejected: passing JS objects instead of pre-serialized strings (works, but the repositories intentionally own serialization and the live test asserts DB-level types); loosening the CHECK (would hide the defect and break SQL-side JSON scans).

## 2026-10-29 — CI also builds the web app and runs the client secret sweep
- Decision: `.github/workflows/ci.yml` gained `bun run build` and `bun run check:client` under `apps/web`, alongside the existing lint/typecheck/test jobs.
- Rationale: the control-plane app is the only place a provider key or `DATABASE_URL` could reach a browser bundle; a build that never runs in CI cannot prove the server-only boundary survives bundling. The sweep (22 checks over 4 client files) is the regression test for that boundary.
- Alternatives rejected: relying on typecheck alone (types do not model bundle reachability); a manual pre-push check (already drifted once).

## 2026-10-29 — Zed MCP config left unchanged; Qoder uses pinned local servers
- Decision: `.zed/settings.json` still points at `@mastra/mcp-docs-server@latest`; the user declined changing it. Qoder Desktop instead runs pinned local installs (`~/.qoder/mcp-servers/{context7,mastra-docs}`) via `node <dist>`, plus the hosted Neon MCP with OAuth.
- Rationale: 1.3.10 crashes on Windows (`ERR_MODULE_NOT_FOUND` in `@modelcontextprotocol/client`), so "latest" is unsafe there; but editing another IDE's config is the user's call, not ours. The pinned-local pattern is the durable fix and is recorded as wave-4 item W4-H.
- Alternatives rejected: silently editing `.zed/settings.json` (refused by the user); pinning via `npx` (Windows cold-start init timeouts observed).

## 2026-10-29 — Baseten (Muse Spark Open) is the primary inference provider
- Decision: run the coding agent on Baseten Model APIs through the **existing** OpenAI-compatible model object (`providerId/modelId/url/apiKey` in `packages/mastra/src/agents/types.ts`): base URL `https://inference.baseten.co/v1`, `BASETEN_API_KEY`, model id from `BASETEN_MODEL_ID` (documented id `meta-models/muse-spark-open`, 1M context, server-side tool-call parsing; the 1026 snapshot id is resolved via `GET /v1/models` at setup and set by env, never guessed). `@mastra/core@1.79.0` stays pinned; no new inference framework or router.
- Rationale: $100 credits are the grant for this model only; Mastra already supports arbitrary OpenAI-compatible endpoints in object form, so the integration is config plus a usage callback, not a rewrite. An env-driven base URL also keeps a second compatible provider possible without code changes if credits are not approved.
- Alternatives rejected: adding a Baseten-specific SDK/plugin (duplicates Mastra's model layer); Mastra's `baseten/...` router string (the registry does not list Muse Spark Open, and the exact dated snapshot must come from the account's model list); hardcoding a slug (wrong snapshot risk).

## 2026-10-29 — Modal is the sandbox execution provider, behind our own contract
- Decision: implement `ModalSandboxProvider` in `packages/sandbox` over `modal@0.11.x`, satisfying the existing `SandboxProvider` contract (`create/execute/destroy`) and reusing `commandPolicy` (argv, timeout, output caps) unchanged. `NullProvider` remains the default; Modal is opt-in via `SANDBOX_PROVIDER=modal`.
- Rationale: $100 Modal credits plus a JS sandbox API cover the execution gap; our policy/limit/audit boundary is already tested and the agent-facing `sandbox.exec` tool already exists in `wirePlatformTools`, so the provider is an adapter, not a new security model. Direct SDK use keeps the boundary in one reviewed file.
- Alternatives rejected: Mastra's `Workspace` + ComputeSDK Modal provider (the documented `@mastra/workspace-sandbox-computesdk` package is not published — npm 404 on 2026-10-29 — and would move policy into a beta layer); calling Modal's Python SDK (violates the TypeScript runtime); Python-only custom images (JS SDK offers registry/ID images; use `node:22-bookworm` or `oven/bun:1` with git).
- Verification gates: pin `modal` exactly; fake `ModalSandboxClient` for offline tests; live smoke only under `MODAL_LIVE=1` with tiny limits. Egress mapping (`outboundDomainAllowlist` vs `blockNetwork`/`cidrAllowlist`) is verified against the installed d.ts before coding and recorded if the two differ.

## 2026-10-29 — Spend control uses existing `usage_records`, no migration
- Decision: every Baseten call and every Modal sandbox session writes a `usage_records` row (provider, model/sandbox id, tokens or sandbox-seconds, `cost_usd` from a config price table); caps come from worker config (`maxTokensPerTask`, `maxSandboxSeconds`, `maxCostUsdPerTask`) and existing `budget_limits`. No schema change in wave 4.
- Rationale: the table already has org/task/model/provider/token/cost columns and indexes; a new migration would add coordination cost across parallel lanes for no additional capability. Per-org spend is a `sumByOrgSince` query.
- Alternatives rejected: new `sandbox_sessions` table (duplicates usage_records for MVP); unbounded spend with alerting only (credits are finite and shared).

## 2026-10-29 — Provider credentials are the last step (standing credit policy)
- Decision: a wave must be fully implemented, tested, built, merged and offline-green with `INFERENCE_PROVIDER=none` / `SANDBOX_PROVIDER=null` **before** any Baseten or Modal credential is supplied. Keyed activity is restricted to a single bounded acceptance pass: one `GET /v1/models`, one completion (`max_tokens <= 16`, no tools), one sandbox (`echo`, ≤60 s, smallest limits, terminated), optional bounded end-to-end only with separate approval. No exploratory, benchmark, load, or retry-loop calls; no live calls in CI; measured spend must be read from `usage_records` and reported. Canonical policy: `AGENTS.md` §Provider credits.
- Rationale: the credits are finite, shared, and granted per person; most integration bugs are adapter/mapping/policy bugs that fakes catch for free. Making keys the last step converts the default failure mode from "spend to discover" into "pass offline gates, then verify once." It also keeps CI free and reproducible for contributors without accounts.
- Alternatives rejected: provisioning keys at sprint start for convenience (spends on scaffolding mistakes and invites exploratory calls); allowing agents to "just run one" live test when blocked (unbounded by repetition); relying on dashboard alerts only (lagging and not enforced at the call site).

## 2026-10-29 — W4-0 verified provider facts (docs + d.ts only, no keyed calls)

Verified against the published `modal@0.11.1` tarball `dist/index.d.ts`, Baseten Model APIs docs, Mastra docs, and the installed `@mastra/core@1.79.0` d.ts. No credential was read, requested, or used.

- **Modal JS (`modal@0.11.1`; Node 22+):** `import { ModalClient } from "modal"`; `new ModalClient({ tokenId, tokenSecret })` (also falls back to `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`). Create needs an **App**: `client.apps.fromName(name)` then `client.sandboxes.create(app, image, params)`; image from `client.images.fromRegistry("node:22-bookworm")` (synchronous, registry pull). Params: `cpu`, `memoryMiB` (not bytes), `timeoutMs`, `idleTimeoutMs`, `command: string[]`, `workdir`, `env`. Network is `blockNetwork: true` by default-able flag plus `outboundDomainAllowlist: string[]` / `outboundCidrAllowlist: string[]` — there is **no** `cidrAllowlist` and no `network: {...}` object in 0.11.1 (Context7 autodocs disagree; the d.ts wins). `sandbox.exec(argv, { timeoutMs })` returns a `ContainerProcess` **with streams**; read via `readText()`, exit code via `proc.wait(): Promise<number>` (no `.exitCode`). `timeoutMs` defaults to 0 (unbounded) — always pass one. `terminate()` is **not documented as idempotent**; the adapter must guard per handle.
- **Baseten:** OpenAI-compatible base `https://inference.baseten.co/v1`, chat at `/chat/completions`, model list at `GET /v1/models`, `Authorization: Bearer <key>`; documented model id `meta-models/muse-spark-open`; usage fields `usage.prompt_tokens` / `usage.completion_tokens` / `usage.total_tokens`. The dated snapshot id remains unconfirmed until Phase D's single `GET /v1/models`.
- **Mastra 1.79:** `agent.generate(prompt, { maxSteps })` (finite, default 5); `generate()` returns `{ text, totalUsage, toolCalls, toolResults, steps }`; `totalUsage` is `{ inputTokens, outputTokens, totalTokens, ... }`. Tool-call entries are chunk-shaped (`payload.toolName`), so the runtime must read names from the concrete result shape rather than cast blindly.
- **Image choice:** `node:22-bookworm` (full, not `-slim`) — must ship `git` for the git helpers; `oven/bun:1` is acceptable only if a probe shows git present. Image is a constant, not repo-controlled.
- **Sandbox env:** `MODAL_APP_NAME` and `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` are server-only worker env; the web app and client bundle never see them.

### Key-less acceptance path (Phase C, designed here)

`scripts/acceptance-offline.ts` runs with `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`, and asserts no `BASETEN_*`/`MODAL_*` variable is set. It composes production services with package fakes and asserts, in order:
1. submission through the control-plane service validates and enqueues exactly one `run_task` job (idempotent replay yields the same job);
2. the worker loop claims the job and runs the task handler;
3. agent turns run through the policy-gated tools: an allowlisted read executes against the fake backend, a non-allowlisted/approval-band tool is denied and never reaches the backend;
4. the injected usage sink receives one row per model call and the sandbox-teardown row;
5. `destroy` is observed exactly once on success, thrown handler error, and abort;
6. the job ends in the expected ack state (complete / retry / dead_letter) and the queue shows no in-flight lease.
No provider SDK is imported and no network call is made; the script exits non-zero on any assertion.

## 2026-10-29 — W4-OPS integration decisions

- **Offline acceptance lives at `scripts/acceptance-offline.ts` and is runnable as `bun run acceptance:offline`.** It imports production control-plane and worker modules via relative paths (root scripts cannot resolve `@isolate/*` specifiers because the root package declares no workspace dependencies; per-package `node_modules` symlinks make the nested imports resolve). It refuses to start when any `BASETEN_*`/`MODAL_*` variable is present or when `INFERENCE_PROVIDER`/`SANDBOX_PROVIDER` hold non-offline values.
- **The acceptance uses fakes at the package boundaries, not at the service boundaries.** Submission goes through `createTaskService` + `createRepositoryStore` + `createSubmissionCompiler` with in-memory task/queue/compilation repositories; execution goes through the real `createWorkerLoop` + `createTaskExecutionHandler`; tools go through the real `wireSandboxTools` policy gate with a recording fake backend. This exercises the seams that can regress without touching a provider.
- **`destroy` is asserted by counting, and usage by row shape.** Success expects exactly one model row (`baseten`, 10/5 tokens, null cost) and one sandbox row (`recording-fake`, `sandbox:1x512`, null tokens); throw expects only the teardown row; abort is driven by a false heartbeat (lease loss) so teardown happens before any model call. Costs stay null because no trusted price table is configured — the script must not invent a price.
- **Client sweep patterns now include `BASETEN_`, `MODAL_`, `inference.baseten.co`, `modal.com`** in addition to the existing key/DB/private-key patterns, for 26 checks over the built client bundle.
- **Composition remains injection-only.** Real adapters are not selected at boot: task context has no DB source, the runtime factory receives no sandbox handle, and Modal client construction performs an API call. These are tracked in `CHALLENGES.md` as wave-5 integration work, not papered over with partial wiring.
