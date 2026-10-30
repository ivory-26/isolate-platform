# Tasks

Owner / file ownership / dependencies / acceptance criteria / DoD per task. Statuses: planned / in progress / blocked / done.

## Wave 3 — Product surface expansion (`task/w3-*` branches, one worktree per agent)

Worktrees: `C:/Users/Sahil/Documents/worktrees-platform/w3-*`. Common rules: agents own ONLY the files listed; root files (`package.json` at root, `bun.lock` root changes beyond `apps/web` scaffolding, `scripts/`, `project/`, `.env*`) are coordinator-only; scoped gates per package (`bunx biome check <owned>`, `bunx --bun tsc -p <project>/tsconfig.json --noEmit`, `bun test <owned-tests>`); commit on the task branch before reporting; never push; never read/print `.env*`.

### W3-W — Worker consumes promoted `WorkerConfig.jobTimeoutMs`
- Owner: agent session W3-W · Branch: `task/w3-worker`
- File ownership: `apps/worker/**`
- Work: the per-job hard timeout now has its contract in `@isolate/shared` (`workerConfigSchema.jobTimeoutMs`, default 120000, bounds 1000–3600000). Source it from parsed WorkerConfig; keep the dep-level override strictly as a test seam; update createdAt/fixtures; keep all 20 loop/config tests green and add coverage that config-supplied timeouts are honored (including BUDGET_EXCEEDED path).
- DoD: scoped gates green ×2 reproducibility, commit, report with command evidence.
- Status: **done** — commit `e73e3d1`; coordinator gates: tsc clean, 33 pass / 0 fail ×2, biome clean 0 issues.

### W3-D — Wave-3 DB schema + repositories
- Owner: agent session W3-D · Branch: `task/w3-db`
- File ownership: `packages/db/**`
- Work: migration `0002_workflow_compilation.sql` (idempotent, Postgres ≥13, editorial style matching 0001): `compiled_plans` (org-scoped, `workflow_definition_id` + version-pinned `workflow_version` uniqueness, `plan` JSONB, `created_at`) and `rejection_issues` (`workflow_definition_id`, `workflow_version`, `issues` JSONB, `created_at`); new repositories `CompiledPlanRepository` (save/get/list, version immutability) and `WorkflowRejectionRepository` (record by version, list latest) with in-memory fakes built on pure decision helpers, offline tests mirroring `approval-repository.test.ts` style, live-Neon suite updates that skip cleanly without `DATABASE_URL`.
- DoD: scoped gates green ×2; migration NOT applied (coordinator applies); commit + report.
- Status: **done** — commit `70497f4`; 137 offline pass / 2 live skips; migration `0002` applied by coordinator (20/20 tables); live suite 139/139 after fixing jsonb `::text::jsonb` binding (commit `7ffdead`).

### W3-F — Compiler: forbid dotted node ids
- Owner: agent session W3-F · Branch: `task/w3-wfschema`
- File ownership: `packages/workflow-schema/**`
- Work: validator must reject any node id containing `.` (Mastra resume treats `.` as a path separator — see DECISIONS B2 note); new rejection class with dedicated tests; keep all 52 existing tests green; document in the module docstring.
- DoD: scoped gates green ×2; commit + report.
- Status: **done** — commit `7d7afd6`; 157 pass / 0 fail (up from 52; dot-id rejection + unknown-input shape hardening); tsc/biome clean.

### W3-U — Fresh web app scaffold + minimal control-plane UI
- Owner: agent session W3-U · Branch: `task/w3-web`
- File ownership: `apps/web/**` only (its package.json is inside). May `bun add` (worktree-local bun.lock changes allowed; coordinator owns the root lockfile merge).
- Work: fresh TanStack Start app (not a port) — Bun, React, TS strict; two routes: task submission (org-scoped, server function validates via `@isolate/shared` schemas and enqueues through `TaskRepository`/`QueueRepository` contracts; when `DATABASE_URL` is absent use the in-memory fakes from `@isolate/db/testing`) and a runs/tasks list (latest-first, sanitized fields only). Deps: `@tanstack/react-start`, `@tanstack/react-router`, `@tanstack/react-query`, react/react-dom, zod. Use the installed skills `tanstack-start-best-practices` / `tanstack-router-best-practices` / `tanstack-query-best-practices` + context7 for API confirmation. No secrets, no model providers, no sandbox execution in browser bundles; verify `dist/client` excludes `apiKey`/`DATABASE_URL`/provider hosts. Must pass root `bun run typecheck` (project auto-discovery) and `bunx biome check apps/web`.
- DoD: scoped gates + production build green; commit (excluding node_modules); report with command evidence. If online scaffold tooling fails, hand-build a minimal TanStack Start app from docs (do not commit broken state).
- Status: **done** — commit `cd3c40f`; tsc clean, 114 pass, production build + 22-check client secret sweep green. Integration note: the worktree also contained stale copies of W3-D/W3-F package work; those were dropped in favor of the canonical branches (hash-verified) before merge.

### W3-S — `packages/sandbox`: adapter contract + git helpers + command policy
- Owner: agent session W3-S · Branch: `task/w3-sandbox`
- File ownership: `packages/sandbox/**`
- Work: package from scratch (package.json, tsconfig matching sibling conventions, src). Deliver: (1) `SandboxProvider` adapter interface + a deny-by-default `NullProvider` that refuses every execution (no host process spawning of untrusted code — enforce in types and tests); (2) `commandPolicy` — timeout/arg-shape/output-cap/egress validators over an explicit allowlist shape; (3) `git` helpers — `openRepo`, `createBranch`, `createWorktree`, `removeWorktree`, unique `task/<id>` branch naming, operating with `Bun.$` on explicit paths (temp fixtures under the platform temp dir; never the host repo), bounded output; offline tests only.
- DoD: scoped gates green; package discovered by root typecheck (already wired); commit + report.
- Status: **done** — commit `3c8ef0a`; 119 pass / 0 fail, tsc/biome clean, offline-only.

## Wave 3 — Integration & validation (coordinator, after W3-* report)
- Merge `task/w3-*` → `main` centrally; regenerate root lockfile; full `bun run validate`; apply `0002_workflow_compilation.sql` to Neon `isolate-platform` **with user approval (Neon MCP)**; QA/DoD audit; web client-bundle secret sweep; docs (ARCHITECTURE/STATUS/CHALLENGES/SKILL-REGISTRY); push; verify CI green.
- Status: **done (except push/CI verification)** — five zero-conflict merges; lockfile regenerated; `bun run validate` 662/662 with live Neon; migration applied (20/20 tables); client sweep 22 checks; CI updated with web build + sweep. Not pushed by request scope; CI on remote unverified.

## Wave 4 — Provider plane: Baseten inference + Modal sandboxes (planned 2026-10-29)

Budget context: $100 Baseten credits (Muse Spark Open only) and $100 Modal credits. Mastra core stays `@mastra/core@1.79.0`; no orchestration framework change. Inference uses the **existing** OpenAI-compatible model object (`providerId/modelId/url/apiKey` in `packages/mastra/src/agents/types.ts`); sandboxing uses the **existing** `SandboxProvider` contract (`packages/sandbox/src/providers/types.ts`).

Ground rules (unchanged): one writable owner per package per wave; one worktree + `task/w4-*` branch per agent; root files (`package.json`, root `bun.lock`, `scripts/`, `project/`, `.env*`) are coordinator-only; scoped gates per package; commit on the branch before reporting; never push; never read/print `.env*`.

**Credit rule (strict):** Baseten and Modal keys are the LAST step. Every lane must be implemented, tested, built and merged with `INFERENCE_PROVIDER=none` and `SANDBOX_PROVIDER=null` before any key exists. No exploratory or benchmark calls; live acceptance is one bounded run with explicit user approval. Full policy: [`AGENTS.md`](../AGENTS.md) §Provider credits.

### Execution order (strict — keys last)

1. **Phase A — contracts + lanes (no keys):** interfaces committed first; W4-DB/W4-INF/W4-SBX/W4-WEB developed in parallel with fakes only.
2. **Phase B — merge + offline gates:** all lanes merged; `INFERENCE_PROVIDER=none SANDBOX_PROVIDER=null bun run validate` green ×2; worker dry-run with fake provider/runtime; web build + client sweep green.
3. **Phase C — offline acceptance:** task lifecycle exercised end-to-end with `NullProvider` + fake runtime and **zero provider credentials in the environment**. The scripted acceptance must assert: web submit validates and enqueues → worker claims → fake agent turns run through the policy-gated tools → usage sink receives rows → sandbox `destroy` is called on success, throw and abort → job acks with the expected verdict. No `BASETEN_*`/`MODAL_*` env is set and no provider SDK is invoked.
4. **Phase D — user adds keys (only after A–C are green):** user supplies credentials; first keyed action is a single `GET /v1/models` to confirm the exact Muse Spark Open snapshot id (no completion tokens). Do not run completions in this phase.
5. **Phase E — minimal live acceptance (one approval, one pass):** exactly one Baseten completion (`max_tokens <= 16`, no tools) and exactly one Modal sandbox (`echo`, ≤60 s, smallest limits, terminated immediately). Optional bounded end-to-end only with a separate explicit approval (`<= 2` turns, `<= 512` output tokens, sandbox `<= 5` min).
6. **Phase F — close-out:** read `usage_records` and report measured spend; verify zero sandboxes running; update docs; destroy temporary keys only with user approval.

### W4-0 — Coordinator pre-work (contracts only, NO keys)
- Commit cross-lane contracts FIRST: `AgentUsage` + `onUsage` hook in `packages/mastra/src/agents/types.ts`; `SandboxToolBackend` interface (read/list/search/exec/git) for the tool layer; `UsageSink` shape consumed by the worker (implemented by W4-DB). Interfaces only, no implementations.
- Verify provider facts against **installed types and published docs only** — no keyed call: `baseten` provider id and model id `meta-models/muse-spark-open-1026`; Modal egress field (`outboundDomainAllowlist` vs `blockNetwork`/`cidrAllowlist`) against the installed `modal` d.ts; image choice (`node:22-bookworm` or `oven/bun:1`, must include git). Phase D's single `GET /v1/models` confirms the id.
- **Do NOT provision, request, or test with Baseten/Modal credentials here.** Keys are Phase D, after A–C are green.
- Status: **done** — commits `d0da5ff` (contracts: `UsageRecordInput`/`UsageSink` in `@isolate/shared`; `AgentUsage`/`AgentUsageListener`/`AgentTurnCaps`/`CodingAgentRuntimeFactory` + optional `AgentTurnRecord.usage` in `@isolate/mastra`; `SandboxToolBackend` in `tools/sandbox-backend.ts`) and `a80868e` (verified Modal 0.11.1/Baseten/Mastra facts + Phase-C acceptance design in DECISIONS). Full offline validate in the worktree: 660 pass / 2 skip / 0 fail, 8/8 typecheck, biome clean. No keyed calls.

### W4-DB — `packages/db/**` (owner: agent W4-DB, branch `task/w4-db`)
- W4-B follow-up: normalize remaining `JSON.stringify(...)` → `::jsonb` writes to `::text::jsonb` (or object binds); add live `jsonb_typeof` assertions; verify SQL-side `budget_limits->>` scans still work.
- New `UsageRepository` over the existing `usage_records` table: `record({organizationId, taskId, modelId, provider, promptTokens, completionTokens, costUsd})`, `sumByTask`, `sumByOrgSince`; in-memory fake on the same pure helpers; live test. **No migration** (`usage_records` already exists).
- DoD: offline gates ×2; live suite green when `DATABASE_URL` is present; commit + report.
- Status: **done** — commit `fe70346` (merge `75b668a`). Six jsonb write sites now bind `$n::text::jsonb`; live `jsonb_typeof` + `budget_limits->>` suite; exact micro-dollar `UsageRepository` + in-memory fake. Gates ×2: 154 pass / 4 skip offline; on `main` with Neon: 158 pass / 0 fail (live jsonb + usage rows green).

### W4-INF — `packages/mastra/**` (owner: agent W4-INF, branch `task/w4-inf`)
- `basetenModelConfig(env)`: `{ providerId: "baseten", modelId: BASETEN_MODEL_ID (default meta-models/muse-spark-open-1026), url: BASETEN_BASE_URL ?? "https://inference.baseten.co/v1", apiKey: BASETEN_API_KEY }`; fail closed with a bounded error when the key is absent (no silent fallback).
- Extend `defineCodingAgent` to accept `tools` + `maxSteps`; extend `createMastraAgentRuntime` to pass them and emit `onUsage` from the generate result (verify exact token field names against the installed d.ts) and record tool names in `AgentTurnRecord.toolCalls` (never payloads).
- Sandbox-backed tools behind injected `SandboxToolBackend`, wired through the existing `wirePlatformTools` policy gate (`repo.read_file`, `repo.list_files`, `repo.search`, `sandbox.exec`, git read ops). Deny-by-default and approval routing stay in `tools/policy.ts`.
- Bounded loop: per-turn output-token cap, per-task token accumulator → `BUDGET_EXCEEDED` block; `maxSteps` finite.
- Tests: fake Agent + fake backend only (no network); usage mapping, tool denial, cap exhaustion, tool-call recording.
- DoD: offline gates ×2; commit + report.
- Status: **done** — commit `55bb35c` (merge `15b04ef`). 42 tests / 140 expects ×2, tsc clean, biome clean; no keyed calls.

### W4-SBX — `packages/sandbox/**` (owner: agent W4-SBX, branch `task/w4-sbx`)
- Add `modal` (pin `0.11.x`) to `packages/sandbox/package.json`; implement `ModalSandboxProvider` behind the existing `SandboxProvider` contract. Inject a `ModalSandboxClient` interface (create/exec/terminate) so tests never touch the network; construct the real `ModalClient` only in a server-only factory.
- Map `SandboxSpec` → `SandboxCreateParams`: cpu, memoryMiB, lifetime `timeoutMs`, `idleTimeoutMs`, absolute `workdir`, `command: ["sleep","48h"]`; egress deny-by-default (`blockNetwork: true` unless a verified domain/CIDR allowlist is provably required for clone/install). Reject unsupported limits BEFORE create.
- `execute`: `sb.exec(argv, { timeoutMs })`, capture stdout/stderr with caps, `wait()` exit code, map to `CommandResult`; abort propagates. `destroy`: idempotent terminate, tolerates already-gone.
- Offline fake-client tests: mapping, pre-create rejection, timeout, output cap, destroy idempotency, no host process spawning.
- Status: **done** — commit `db18988` (merge `a13d990`, lockfile `186e706`). 184 sandbox tests ×2; `external: ["modal"]` added to the barrel bundle assertion because the SDK's `detect-libc` embeds a `child_process` reference (first-party no-host-exec assertion unchanged).
- **Offline only in this lane.** The live smoke is Phase E (after keys), single-run: smallest allowed CPU/memory (target 512 MiB), `timeoutMs <= 60000`, create → `echo` → terminate, assert cleanup. Never in CI, never repeated for debugging.
- DoD: offline gates ×2; commit + report.

### W4-WRK — `apps/worker/**` (owner: agent W4-WRK, branch `task/w4-wrk`)
- Composition root: `NullProvider` unless `SANDBOX_PROVIDER=modal`; Baseten config only when `INFERENCE_PROVIDER=baseten`. No direct `modal` import and no provider SDK outside the adapters.
- `TaskExecutionHandler`: provision sandbox → bind tenant/task/run context → run bounded agent turns with sandbox tools → persist usage via injected `UsageSink` → **destroy in `finally`**; heartbeat during long work; abort → cancel + destroy; map failures to bounded verdicts. Idempotent under lease redelivery.
- Tests: fake provider/runtime/usage sink; cleanup on success, throw and abort; retry classification; no secret/payload leakage into logs or state.
- DoD: offline gates ×2; commit + report.
- Status: **done** — commit `9c4eb3d` (merge `b25112e`, lockfile `aa60171`). 84 tests ×2. Divergence: `SandboxSpec` has no `idleTimeoutMs` on this branch, so the handler carries it for the adapter without forwarding; empty turn output is the completion protocol.

### W4-WEB — `apps/web/**` (owner: agent W4-WEB, branch `task/w4-web`)
- W4-A: `resolveCallerScope` (session → org/user/memberships) with a test-only dev adapter; enforce on task submission and list handlers; tenant-isolation tests at the API boundary.
- W4-C: compile at submit against `AuthoredWorkflowVersionReader`, persist the pinned plan, surface `rejection_issues` in the task response; keep `Cache-Control: private, no-store`; no provider keys or DB URLs in the client bundle.
- Visual editor and approval queue move to wave 5 (same package, single writer).
- DoD: build + client secret sweep + tests; commit + report.
- Status: **done** — commit `c5fa6e1` (merge `4e0a914`). 158 tests ×2, build + 22-check sweep green. Contract change: submit now requires `workflowDefinitionId` + `workflowVersion`; receipts carry `compilation`; `WORKFLOW_REJECTED` added.

### W4-OPS — Coordinator integration (after all lanes report)
- Extend `apps/web/scripts/check-client.ts` forbidden patterns with `BASETEN_`, `MODAL_`, `inference.baseten.co`, `modal.com`.
- CI: **no provider keys and no live calls** (CI must stay free). Offline gates only; gitleaks triage; full `bun run validate`; docs (`STATUS`/`DECISIONS`/`CHALLENGES`/`TASKS`/`ARCHITECTURE`); push only with user approval.
- Keep W4-H (pin Zed's Mastra docs MCP to 1.3.9) as opportunistic tooling.
- Status: **done** — `scripts/acceptance-offline.ts` (+ `bun run acceptance:offline`) exercises submit → replay → claim → gated tools → usage → destroy(success/throw/abort) → ack with zero provider env, refusing to run if `BASETEN_*`/`MODAL_*` are set. Sweep patterns added. `main` gates: 869 pass / 0 fail ×2, 8/8 typecheck, biome 0 errors, web build + 26-check sweep. Real adapters remain injection-only (see CHALLENGES §Wave 4 integration boundary); Phase D/E not started.

### Dependency graph / parallelism
`W4-0 contracts → {W4-DB, W4-INF, W4-SBX, W4-WEB in parallel} → W4-WRK (develops against interfaces + fakes, integrates after INF/SBX merge) → W4-OPS`.
W4-WRK must NOT wait for adapters to be finished: it codes to `SandboxProvider`/`CodingAgentRuntime` and fake implementations, then swaps in the real ones at integration.

### Cost guardrails (both credits)
Policy of record: [`AGENTS.md`](../AGENTS.md) §Provider credits. Keys exist only in Phase D–E; every other phase runs with providers disabled.
- Baseten: `maxOutputTokens` per turn (`<= 16` for acceptance, small bounded value for product use), per-task token accumulator, existing `max_agent_turns`/`max_duration_ms`; one `usage_records` row per model call with cost from a config price table (no hardcoded guess); block at cap. Exactly one completion in Phase E.
- Modal: default 1 CPU / 1 GiB / 15 min lifetime / 5 min idle, no GPU, per-task sandbox-seconds cap, concurrency cap, destroy in `finally`; record sandbox usage rows (provider `modal`, model_id `sandbox:<cpu>x<mem>`, estimated `cost_usd`). Exactly one sandbox in Phase E.
- Live tests are opt-in, tiny, single-run, and never run in CI; they are the only paths allowed to spend credits.
- After each keyed run: read `usage_records`, report measured spend, verify zero running sandboxes. No retries after success; no cap increases to make a test pass.

### Deferred to wave 5
- Visual workflow editor (React Flow) + approval queue UI; GitHub App / scoped token broker for clone+PR; Mastra `Workspace`/LSP evaluation (native workspace sandbox package is not published: `@mastra/workspace-sandbox-computesdk` returns 404 as of 2026-10-29); deploy pipeline.

## Wave 5 — Authentication & tenant access: Neon Managed Better Auth (branch `task/w5-auth`, worktree `../worktrees-platform/w5-auth`)

Started 2026-10-29. Goal: a signed-in caller sees only their own organization's work, and no request can widen that boundary. Driven by the user's report that "Better Auth is enabled in NeonDB" and the requirement that people must not "see everything".

### W5-0 — Verify the provisioned auth host (Neon MCP, read-only)
- Confirmed on project `divine-butterfly-60669535`, branch `br-steep-poetry-ar5iwdkb`: `auth_provider = "better_auth"`, `owned_by = "neon"`, base URL `https://ep-lucky-night-arkvt9aj.neonauth.c-4.us-west-2.aws.neon.tech/neondb/auth`.
- The Neon-managed `neon_auth` schema holds `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `jwks`, `project_config`; `user.id` is `uuid DEFAULT gen_random_uuid()`.
- Live config: `trusted_origins: []`, `allow_localhost: true`, email/password with `allow_sign_up: true` and no email verification, one shared `google` OAuth provider with `client_id: null`, shared SMTP sender `auth@mail.myneon.app`.
- **Open, needs the user:** add the deployment origin as a trusted domain before hosting (`add_auth_trusted_domain`). Until then only localhost can sign in.

### W5-DB — `packages/db` tenancy access (owner: this lane)
- `UserRepository`, `MembershipRepository`, `OrganizationRepository` with Postgres drivers and in-memory fakes that mirror the unique constraints (one user per email, one organization per slug, one membership per org/user pair).
- `packages/db/src/roles.ts` — capability matrix: `owner|admin` → all, `member` → read/submit/organization-read, `viewer` → read/organization-read only.
- Migration `0003_auth_identity.sql` — `memberships_user_id_idx (user_id)` only. **Applied to Neon** and verified via `pg_indexes`. The `neon_auth` schema is Neon-owned and is never written by this repo.

### W5-AUTH — `apps/web` identity bridge and authorization (owner: this lane)
- Server-only Neon Auth adapter (`src/server/neon-auth.server.ts`): reads `NEON_AUTH_BASE_URL` / `NEON_AUTH_COOKIE_SECRET` (≥32 chars) / optional domain, same-site and TTL; proxies `/api/auth/*` and rewrites `__Secure-neon-auth.*` cookies onto this origin. The SDK never enters the client bundle.
- `src/server/auth-session.server.ts` — the id bridge: the Neon Auth user id **is** `public.users.id`; the first authenticated request mirrors the identity into `public.users` and gives it a personal organization, so a fresh signup is never a caller without a tenant.
- `src/server/caller-scope.server.ts` — identity is server-derived. `SessionResolver` answers only "who"; `MembershipReader` answers only "which organization". The remembered organization is a preference, honoured only when the membership really exists.
- `src/server/submission-compilation.server.ts` — `authorizeMembership` is now a **required** dependency, re-checked inside the submit transaction (it was `async () => true`).
- `src/server/task-service.server.ts` — the role gates the capability before any storage access; `viewer` may read but never submit.

### W5-UI — Auth components and pages (owner: this lane)
- Components: `SessionProvider`, `UserMenu`, `OrganizationSwitcher`, `RoleBadge`, `AuthForm`.
- Pages: `/login`, `/signup`, `/organizations` (membership list with role badges), `/organizations/new` (create an organization — the caller becomes its owner).
- `/`, `/runs` and `/organizations` are session-guarded; the submit form is disabled for a `viewer`.
- `scripts/check-client.ts` forbids `@neondatabase/auth`, `better-auth`, `neonauth` and `__Secure-neon-auth` in the browser bundle; `scripts/smoke-build.ts` asserts 307 → `/login` for every tenant route when no trusted auth is configured.

### W5-OPS — Coordinator integration (after this lane reports)
- Reconcile the shared root `bun.lock` delta against W4-SBX / W4-WRK — CI installs with `--frozen-lockfile`, so the lockfile entry must ship with the dependency.
- Merge `task/w5-auth` → `main`; re-run the full offline validate; add the deployment origin to the Neon trusted-domain list; update `.env.example` and `ARCHITECTURE.md` (done on this lane).

### Gates (this lane, 2026-10-29)
- `biome check` — 0 errors repo-wide (10 pre-existing `noNonNullAssertion` warnings in `packages/db/src/live.test.ts` and `packages/db/src/testing/fakes.test.ts`; not touched).
- `bun scripts/typecheck-all.ts` — all 8 projects pass.
- `bun test --no-env-file` — **903 pass / 0 fail / 4 skip**, twice, identical (the 4 skips are the Neon live suites, which need `DATABASE_URL`).
- `apps/web` — `vite build` green; client sweep green (26 checks over 17 client files); production smoke green (307 → `/login` for `/`, `/runs`, `/organizations`; 200 + `no-store` for `/login`).

### Status: **done — committed on `task/w5-auth`, not pushed**

## Wave 6.1 — Meta contributor inference for dev/pre-production (2026-10-30)

- `INFERENCE_PROVIDER=meta` → Meta Model API (`https://api.meta.ai/v1`), model `muse-spark-1.3-contributor` only; `META_MODEL_ID` rejects any other id. `INFERENCE_PROVIDER=baseten` remains production (`meta-models/muse-spark-open-1026`).
- Shared Mastra runtime factory for both; `createMetaRuntimeFactory`/`createBasetenRuntimeFactory`.
- Reasoning-model guard: empty text at the per-turn output cap throws `BUDGET_EXCEEDED` instead of signalling completion.
- Bounded live check: one Meta agent plan turn (1024-token cap), 103 prompt / 367 completion tokens, 4.5 s; usage row recorded and cleaned. Offline gates green.
- Status: **done** — keys are read only from `.env`; no value printed or committed.

## Wave 6 — Auth completion + real adapter integration (branch `task/w6-finish`, worktree `../worktrees-platform/w6-finish`)

Started 2026-10-29, based on `task/w5-auth`. Goal: finish the end-to-end auth story (Google sign-in, task intent in the DB) and remove the wave-4 integration boundary so the real Baseten/Modal adapters can be selected at boot once keys exist.

### W6-AUTH — Google OAuth end to end
- Server service: `startGoogleSignIn` (provider enumerated to `google`), same-origin `callbackURL` built from the request origin, `disableRedirect: true`, provider URL validated as public https.
- Return leg: `/auth/callback` runs `processAuthMiddleware`, relays the exchange `Set-Cookie` values and redirects; failures land on `/login?authError=...`.
- UI: "Continue with Google" on `/login` and `/signup`; no SDK in the client bundle.
- Neon: shared `google` provider confirmed; trusted domain `http://localhost:3000` added via MCP. Production origin and own Google credentials remain a deployment step.
- Status: **done (code + unit tests)** — live Google consent not exercised in this session.

### W6-DB — Task context persisted and loaded
- Migration `0004_task_context.sql`: `goal text`, `acceptance_criteria jsonb`, `file_ownership jsonb` with array CHECKs (additive; existing rows default to `''`/`[]`).
- `submitTaskSchema` requires a goal and bounds both lists; the form collects them one-per-line.
- `PostgresTaskContextRepository` joins task → repository under one `organization_id`; the worker maps to `TaskContext` and fails closed on missing/terminal/foreign rows.
- Status: **done** — migration applied and verified; live suite includes the round-trip and foreign-tenant null read.

### W6-WRK — Sandbox handle binding + real composition
- `CodingAgentRuntimeFactoryOptions` gains `sandboxBackend` + `toolContext`; the handler builds it from the provisioned handle.
- `SandboxToolBackend` implementation over `executeCommand` with a conservative workspace policy.
- `createBasetenRuntimeFactory`, DB queue/usage/task-context composition, Modal provider selection (lazy app resolution) and fail-closed provider selection.
- Status: **done** — offline fakes only; no keyed calls.

### W6-OPS — Validation and keyed acceptance
- Offline: biome 0 errors (10 pre-existing warnings), 8/8 typecheck, 946 pass / 0 fail / 4 skip ×2, web build + 30-check sweep + smoke, `acceptance:offline` PASS (`--no-env-file`).
- Live Neon: migration `0004` applied and verified; full suite 950 pass / 0 fail.
- Keyed acceptance (one run): models 20 listed / target present → one completion HTTP 200, 148 prompt + 16 completion tokens, no tools → one Modal sandbox 0.125 CPU / 512 MiB / 60 s, `echo` exit 0, terminated → usage rows recorded, printed and cleaned. No trusted price configured, so cost stays null.
- Status: **done** — live pass complete; branch fast-forwarded into `main` (`8cd5260`). Google consent remains a user browser check.

## Wave 7 — Execution truth: seed → clone → edit → commit → lifecycle → approval gate (planned 2026-10-30)

Goal: close the five execution gaps recorded after wave 6, so a task submitted in Postgres mode can be claimed, provisioned, cloned, edited, committed, recorded and stopped at a human approval gate before push/PR. Everything is proven **offline** against fakes; no Baseten/Modal/GitHub credential is requested and no live call is made. UI redesign, test-execution gates and a live GitHub App are wave 8.

Worktrees: `C:/Users/Sahil/Documents/worktrees-platform/w7-*`, one `task/w7-*` branch per lane. Common rules: agents own ONLY the files listed; root files (`package.json`, root `bun.lock`, `scripts/`, `project/`, `.env*`) are coordinator-only; scoped gates per package (`bunx biome check <owned>`, `bun scripts/typecheck-all.ts`, `bun test --no-env-file <owned-tests>`); commit on the task branch before reporting; never push; never read/print `.env*`.

**Cross-package contracts are committed first** on `main` (`7392fb9`): `SandboxSpec.env`, `TaskWorkspaceGit`, `ExecutionLifecycle`, `workspace.cloned`/`artifact.created` events, optional sandbox write-surface methods, `GitHubTokenProvider` + fail-closed placeholder. Lanes code against these; nobody redefines them.

### Validation loop (applies to every lane)

1. Agent self-validates and commits; report includes the commit SHA and raw command output.
2. Coordinator re-runs the scoped gates **twice** from a clean shell in the lane worktree.
3. Any red gate is returned to the agent with the exact failing output; at most **two** repair iterations.
4. A lane merges only when both runs are green; a lane that cannot pass is parked with its branch and findings, never merged red.
5. After merge, the coordinator runs the full `bun run validate` plus web build/client sweep/`acceptance:offline`.

### W7-DB — `packages/db/**` (owner: agent W7-DB, branch `task/w7-db`)
- Migration `0005_execution_truth.sql` (**idempotent; NOT applied by the lane**): `artifacts.content text` with a 256 KiB byte CHECK; unique `repositories (organization_id, external_full_name)`; unique `task_attempts (task_id, attempt_index)`; partial unique `approvals (task_id, action) WHERE status = 'pending'`; index `tasks (organization_id, created_at DESC)`.
- New `RepositoryRepository` (create/list/get under one organization; duplicate full name is `CONFLICT`), `ArtifactRepository` (bounded inline insert + listByTask), and `PostgresExecutionLifecycle` implementing `ExecutionLifecycle` over the existing task/run/attempt/approval repositories.
- In-memory fakes for all three sharing the same decision helpers; live tests skip without `DATABASE_URL`.
- Acceptance criteria: transitions go through `TASK_STATE_TRANSITIONS`; a stale `from` is `CONFLICT`; events are insert-only; artifact content over the cap is rejected before insert; every read carries `organization_id`; approval payload SHA is stored verbatim.
- DoD: scoped gates green ×2; migration not applied; commit + report with evidence.

### W7-SBX — `packages/sandbox/**` (owner: agent W7-SBX, branch `task/w7-sbx`)
- Implement `TaskWorkspaceGit` (`src/git/workspace.ts`) and export `createTaskWorkspaceGit`: toolchain preflight (`git`, `bun`, `grep`), shallow single-branch clone of a clean https URL into an empty workspace, task branch from the base, `commitAll`, bounded `diffStat`/`diffPatch`, `pushBranch`.
- Credential model: create-time `SandboxSpec.env` only, consumed through `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0` (extraheader); the URL never contains userinfo and the token never appears in argv, stdout, logs, errors or test fixtures. Validate names/values (≤16 keys, name `^[A-Z][A-Z0-9_]{0,63}$`, value ≤4096, no control characters) and forward them in the Modal create params (verify the installed `modal` d.ts first).
- Egress: clone/push commands request `github.com` + `codeload.github.com`; every other command remains `deny`. `ModalSandboxProvider` already maps an allowlist to `blockNetwork:false` + `outboundDomainAllowlist` — prove it with the fake client.
- Image: switch the default to a git+bun image (`oven/bun:1`) and make `assertToolchain` fail closed with `SANDBOX_IMAGE_UNSUPPORTED` when a binary is missing. Record the image fact in DECISIONS if the d.ts/docs disagree.
- Acceptance criteria: no shell, no host process, argv-only, timeouts/caps on every call, credential redaction tests, clean-URL assertion, push refused when egress is deny.
- DoD: scoped gates green ×2 offline; zero live calls; commit + report.

### W7-TOOLS — `packages/mastra/**` (owner: agent W7-TOOLS, branch `task/w7-tools`)
- Replace the read-only-only reference policy with an explicit risk table: `read_only` and `scoped_write` proceed (audited), `sensitive` returns `APPROVAL_REQUIRED`, `destructive` is denied without an approval. Keep the existing contract shape so wave-4/6 callers stay valid.
- New agent tools: `repo.write_file` (scoped_write), `git.commit_local` (scoped_write), `git.diff_summary` (read_only). `git.push_branch` and `github.create_pull_request` stay sensitive and are executed by the worker only after an approval, not by the model directly.
- File ownership: a bounded glob matcher (`*`, `**`, `?`, literal paths) over the task's `fileOwnership`; writes outside it and commits touching unowned paths are rejected before the backend runs. Empty ownership list means "no writes".
- Caps: content ≤256 KiB, commit paths ≤200, message ≤200 chars, ownership list ≤200 patterns; errors never echo content or paths beyond a bounded path.
- Acceptance criteria: write/commit/diff tests against a fake backend; traversal, unowned path, oversize content, approval-band routing, and audit-decision tests; read-only backend (missing optional methods) refuses write tools.
- DoD: scoped gates green ×2; commit + report.

### W7-GH — `packages/integrations/**` (owner: agent W7-GH, branch `task/w7-gh`)
- Implement `createGitHubAppTokenProvider`: RS256 App JWT (WebCrypto, PKCS#8 PEM), `POST /app/installations/{id}/access_tokens` scoped to one repository with `contents`/`pull_requests` only, cache until `expires_at − 300 s`, injectable `fetch`/clock, bounded errors.
- Bind the token broker to the sandbox push path: when push is enabled, the worker gets a repo-scoped token before the clone. Live PR creation stays wave 8; the broker and its fake-fetch tests are the wave-7 deliverable.
- Acceptance criteria: generated RSA key + fake fetch tests; no token in errors/logs/URLs; cache hit/expiry tests; 401/403/404/429 mappings; missing config fails closed; no network in tests.
- DoD: scoped gates green ×2 offline; commit + report.

### W7-WRK — `apps/worker/**` (owner: agent W7-WRK, branch `task/w7-wrk`)
- Execution handler v2: `planning` → provision → `assertToolchain` → clone → `executing` → bounded agent turns with write tools → `validating` (diff present, ownership honored) → `review_ready`; `failed`/`cancelled` map to bounded verdicts. Record one attempt, run events (`workspace.cloned`, `agent.turn_*`, `validation.*`, `artifact.created`) and a bounded diff artifact.
- Approval gate: because a sandbox is destroyed at job end, approval is requested **before** execution when push is enabled (planning → `awaiting_approval`), bound to `{repoUrl, branch}`. The job is acked without retry. A `resume_task` job proceeds only when `approvalStatus` is `approved`, unexpired, and the stored SHA equals the SHA of the action; rejection/expiry moves the task to `failed`. After execution and validation the worker pushes the isolated branch (no force) and ends at `review_ready`; PR creation is wave 8.
- Cancellation: check `isCancelled` before every turn and before push; cancellation still tears down exactly once.
- Composition: inject `ExecutionLifecycle`, `CreateTaskWorkspaceGit` and `GitHubTokenProvider`; bind the DB lifecycle only when `DATABASE_URL` exists, Modal + clone only when opted in, GitHub only when `GITHUB_APP_*` is present. No provider SDK import, no secret in logs.
- Acceptance criteria: fakes for provider/workspace/lifecycle/token; exactly-once teardown on success/throw/abort/cancel; event ordering; approval pause/resume/reject; redelivery idempotency; no payload/secret leakage.
- DoD: scoped gates green ×2 offline; commit + report.

### W7-OPS — Coordinator integration (after all lanes report)
- Cherry-pick/merge green lanes into `main` with `--no-ff`; verify ownership (`git diff --stat main...<branch> -- packages/` empty for non-owner lanes); remove each lane worktree and delete its branch after merge.
- Add `scripts/seed-workspace.ts` + `bun run seed` (demo organization, repository, workflow definition/version) and extend `scripts/acceptance-offline.ts` with the new path: submit → claim → clone (fake) → write/commit (fake) → lifecycle rows → diff artifact → approval pause → resume → teardown.
- Full `bun run validate` ×2, web build + client sweep + smoke, `acceptance:offline`; prepare `0005` for Neon and apply it **only with explicit user approval** (Neon MCP); update STATUS/DECISIONS/CHALLENGES/ARCHITECTURE/SKILL-REGISTRY.
- Status: **done offline** — see the execution record below; migration application and any keyed pass remain open.

### Dependency graph / parallelism
`C0 contracts (main 7392fb9) → {W7-DB, W7-SBX, W7-TOOLS, W7-GH in parallel} → W7-WRK (codes to contracts + fakes; composition wired by W7-OPS) → W7-OPS`.
W7-WRK must NOT import a database class that only exists on another lane: it depends on `ExecutionLifecycle` / `CreateTaskWorkspaceGit` / `GitHubTokenProvider` and receives them as injected dependencies.

### Wave 7 non-goals (explicit)
- No UI redesign and no new functional pages; approval decisions are exercised through the service/repository layer offline. The product surface and design system are wave 8.
- No test-execution validation gate (formatter/lint/typecheck/test); the wave-7 validation gate is "non-empty diff + ownership honored". Running repository toolchains as a gate needs a per-repo command contract and is wave 8.
- No live GitHub App, no deployment origin, no object storage, no workflow editor.

### Wave 7 execution record (2026-10-30)

All five lanes reported, were independently re-gated twice by the coordinator, and merged with `--no-ff` (zero conflicts):

| Lane | Commit | Coordinator gates (×2) |
|---|---|---|
| W7-DB | `740ae54` | biome 0 errors / 10 pre-existing warnings · typecheck 8/8 · 208 tests (5 live skips) |
| W7-SBX | `33ad23b` | biome clean · typecheck 8/8 · 292 tests |
| W7-TOOLS | `b55e1ae` | biome clean · typecheck 8/8 · 84 tests |
| W7-GH | `14c3e5f` | biome clean · typecheck 8/8 · 61 tests |
| W7-WRK | `bd7e012` | biome clean · typecheck 8/8 · 146 tests |

Merge commits: `e1db88f`, `00f8e5a`, `5dbe398`, `cf44b78`, `4f8c74e`. Post-merge `main`: biome 0 errors (10 warnings) · typecheck 8/8 · **1203 pass / 0 fail / 5 skip** ×2 · web build + 30-check sweep + smoke · `acceptance:offline` PASS.

Coordinator integration added after the merges: `resume_task` in `JobType` + `jobs_type_check`; `PostgresExecutionLifecycle`, `createTaskWorkspaceGit`, GitHub token broker and `resolveSandboxEnv` bound in the real composition; `pushEnabled` only with a real sandbox + broker; second-gate denials audited as denials; `scripts/seed-workspace.ts` + `bun run seed`; acceptance expectation updated from `POLICY_DENIED` to `APPROVAL_REQUIRED` for `git.push_branch`.

**Migration applied (2026-10-30, user-approved via Neon MCP)**: `0005` applied to `isolate-platform` / `br-steep-poetry-ar5iwdkb` in one transaction after confirming zero duplicate pending approvals. Verified: `artifacts.content text` + `octet_length(content) <= 262144`, `jobs_type_check` includes `resume_task`, and all four indexes (`repositories_org_full_name_unique`, `task_attempts_task_attempt_unique`, `approvals_pending_task_action_unique`, `tasks_org_created_idx`).

**Live acceptance (2026-10-30, one bounded sequential pass)**: Meta plan turn 6.1 s / 103 prompt + 429 completion tokens; one Modal sandbox 0.125 CPU / 512 MiB / 60 s, `echo isolate-ok` exit 0, destroyed; zero running sandboxes verified; temporary usage org/rows cleaned; `cost_usd` null (no price table). No Baseten call and no GitHub call were made. After migration, the full suite with live Neon passed **1208/1208** (includes the new `0005` lifecycle roundtrip).

**Seed + GitHub read validation (2026-10-30)**: seeded `ivory-26/agent-bank` (main) under org `15fc5715-…` / user `278560b6-…` → repository `4cc5b972-…`, workflow definition `114c905e-…` version 1. GitHub App JWT → installation token succeeded; repo metadata 200 (`private`, `main`), contents 200, installation scope exactly 1 repository; App permissions are now Contents R/W + Pull requests R/W. Key parsing now accepts multiline/escaped/CRLF/single-line PEMs and `GITHUB_APP_PRIVATE_KEY_PATH`; `*.pem` is gitignored.

**Live GitHub push acceptance — PASSED (2026-10-30, one bounded run)**: task `38766867-f219-4ffb-8aaf-25c8d38a81b2`, branch `task/w7-live-da35089b`, commit `46913bea4a62485f74adae665c08058bacdf5646`, status `review_ready`. Approval persisted/approved; one deterministic turn wrote `LIVE_ACCEPTANCE.md`, committed, validated a 5-line/280-byte diff, stored the artifact, and pushed; GitHub branch and contents both returned 200. 2 attempts, 6 events, 1 artifact, 1 sandbox usage row (cost null), sandbox destroyed, 0 running. Earlier failures (allowlist/`blockNetwork`, omitted idle timeout, missing git, untracked diff) are fixed; push re-allows HTTPS explicitly. No PR; the branch remains for evidence until the user deletes it.

Not done: no live GitHub App token has been minted (credentials pending); the acceptance script still exercises the wave-6 lifecycle path (the wave-7 path is covered by 152 worker tests); PR creation and all UI remain wave 8.

### Wave 7 risks
- Clone credentials are the highest-risk surface: the lane must prove the token is absent from argv, URLs, output, logs and fixtures.
- `oven/bun:1` git availability is asserted by the preflight, not assumed; a missing binary fails closed at runtime.
- Approval pause/resume touches queue semantics; the job must not be retried into a second sandbox while paused.
- The migration adds a partial unique approval index; duplicate pending approvals become a constraint violation, so the worker must treat an existing pending approval as idempotent success.

## Wave 8 — Product surface + review close (planned 2026-10-30)

Goal: the platform opens a pull request **only after the repository's configured validation command passes and a human approves that exact PR**, and a person can re-run failed work again inside the same task boundary instead of accepting the failure. **Scope decision (user, 2026-10-30): backend only — no web UI lane this wave.**

Carried in from wave 7: PR creation, a test-based validation gate (instead of "diff present"), the user-triggered rerun path, and repository validation policy. The design-system/run-detail/approval UI moves to wave 9, together with the deployment origin. Wave 7's accepted branch `task/w7-live-da35089b` on `ivory-26/agent-bank` is evidence only and stays untouched until the user deletes it.

Validation-failure policy (user, 2026-10-30): **no automatic repair turn.** A failed validation ends the attempt with a persisted report and no push; the user is then offered a **rerun in the same boundary** — same repository, goal, acceptance criteria and file ownership, as a new task linked to the failed one (`retry_of`), bounded to depth 3.

Worktrees: `C:/Users/Sahil/Documents/worktrees-platform/w8-*`, one `task/w8-*` branch per lane. Rules unchanged: agents own ONLY the files listed; root files (`package.json`, root `bun.lock`, `scripts/`, `project/`, `.env*`) are coordinator-only; scoped gates per package (`bunx biome check <owned>`, `bun scripts/typecheck-all.ts`, `bun test --no-env-file <owned-tests>`); commit on the branch before reporting; never push; never read/print `.env*`.

**No UI lane.** `apps/web` route files, components and styles are untouched; only its server-side control-plane services gain the rerun action (W8-CTL), with no page, route, component or CSS change in this wave.

### W8-0 — Coordinator contracts commit (before any lane, on `main`)
- `@isolate/shared`: `validationReportSchema` (`command`, `argv`, `exitCode`, `durationMs`, `outputBytes`, `truncated`, `status: passed|failed|skipped`) and `pullRequestRecordSchema` (`number`, `url`, `headSha`, `base`); new run-event type `task.retried` (the existing `validation.started`/`validation.finished`/`approval.decided`/`pr.created` types are reused as-is).
- `packages/db` (`JobType` only, contract edit): adds `create_pull_request`; the `jobs_type_check` change lands in `0006`. `run_task` covers a rerun, so no `retry_task` type is needed.
- No state-machine change: `failed` stays terminal. A rerun is a **new task row** in the same boundary, not a reopened terminal state.
- No implementation. Lanes code against these; nobody redefines them.

### W8-DB — `packages/db/**` (owner: agent W8-DB, branch `task/w8-db`)
- Migration `0006_review_surface.sql` (**idempotent; NOT applied by the lane**):
  - `repositories.validation_command text NULL` (CHECK length ≤ 512), `repositories.validation_timeout_ms integer NOT NULL DEFAULT 300000` (CHECK 1000–900000);
  - `tasks.pull_request_number integer NULL`, `tasks.pull_request_url text NULL` (CHECK length ≤ 512);
  - `tasks.retry_of uuid NULL REFERENCES tasks(id)`, `tasks.retry_depth integer NOT NULL DEFAULT 0` (CHECK 0–3), index on `retry_of`;
  - `jobs_type_check` recreated to include `create_pull_request`.
- New/extended repositories: `RunEventRepository.listByTask` (tenant-scoped, oldest-first, bounded page), `ApprovalRepository.listByTask` + `decide` (`pending → approved|rejected` with a real `expectedStatus` guard, `CONFLICT` on a decided row; `decided_by`/`decided_at` already exist and are `text`/`timestamptz` — do not change their types), `TaskRepository.createRetry`/read for the rerun boundary, `RepositoryRepository.setValidationPolicy` + read.
- Acceptance criteria: every read carries `organization_id`; a decision on a decided/expired approval is `CONFLICT`; the decision writes an `audit_events` row in the same transaction; a retry copies repository/goal/acceptance/ownership from the failed task only (never budget beyond the original cap), links `retry_of`, increments `retry_depth`, and refuses depth > 3 or a non-`failed` source; in-memory fakes share the same decision helpers; live suite skips without `DATABASE_URL`.
- DoD: scoped gates green ×2; migration not applied; commit + report with evidence.

### W8-VAL — `packages/sandbox/**` (owner: agent W8-VAL, branch `task/w8-val`)
- `runValidationCommand(repoPath, { command, timeoutMs })` over the existing argv-only execution path: a bounded command string is tokenized **without a shell**, checked against `commandPolicy` (extended with an explicit validation allowlist: `bun test`, `bun run <bounded script>`, `npm test`, `npm run <bounded script>`, `pytest`, `cargo test`, `go test`), executed with the repo timeout, captured stdout+stderr under a 64 KiB inline cap plus a full-log byte cap, and mapped to a `ValidationReport` (exit code, duration, truncated flag).
- Refusals before execution: empty/oversize command, shell metacharacters (`;|&><$\``), unknown executable, timeout outside bounds, egress other than `deny`.
- DoD: offline fake-provider tests only; zero live calls; commit + report.

### W8-GH — `packages/integrations/**` (owner: agent W8-GH, branch `task/w8-gh`)
- `createPullRequestForTask(...)` over the existing `createPrCreator` + `GitHubTokenProvider`: approval-bound canonical payload SHA, repo-scoped token, idempotent on an already-open PR for the head branch (returns it, does not fail), branch head SHA verified before create, bounded error mapping (401/403/404/422/429), no token/URL-with-userinfo in errors or logs.
- DoD: fake-`fetch` tests + generated RSA key; no network; commit + report.

### W8-WRK — `apps/worker/**` (owner: agent W8-WRK, branch `task/w8-wrk`)
- Handler v3 validation gate: after the diff/ownership gate, when `repositories.validation_command` is set, run it in the same sandbox before teardown; record `validation.started`/`validation.finished` with the bounded report, store a bounded log artifact, and **a failed validation ends the task `failed` with no push and no repair turn** (the rerun path replaces repair; recorded in DECISIONS). No validation command configured → `review_ready` keeps the wave-7 meaning and the event carries `skipped`.
- PR stage: a `create_pull_request` job handler verifies approval status + SHA + expiry, re-checks the remote head SHA against the pushed commit, creates the PR, transitions `review_ready → pull_request_created`, persists number/URL and appends `pull_request.created`. The transition must already exist in `TASK_STATE_TRANSITIONS`; if it does not, the lane reports it instead of widening the machine locally.
- Idempotency: redelivery of `create_pull_request` returns the same PR; a cancelled task never creates one; rejection/expiry moves the task to `failed`.
- Composition: bind the validation-policy reader and PR service only when GitHub is configured; no provider SDK import; no secret in logs.
- DoD: offline fakes for provider/workspace/lifecycle/token/PR; event ordering; teardown unchanged; commit + report.

### W8-CTL — `apps/web` server-side control-plane actions (owner: agent W8-CTL, branch `task/w8-ctl`)
- **No UI surface**: no file under `apps/web/src/routes/`, `apps/web/src/components/`, `apps/web/src/features/**/*.tsx` or `apps/web/src/styles.css` may change. Only server-side services, server functions and their tests.
- `retryTask(scope, { failedTaskId })`: capability `task:submit` checked **before** any storage read; the source task must be `failed`, belong to the caller's organization, be inside `retry_depth ≤ 3`, and its payload must be reproduced verbatim (repository, goal, acceptance criteria, file ownership, budget caps); creates the retry task through the store, records `task.retried` on the source task and `task.enqueued` on the new one, enqueues exactly one `run_task` job, and returns the new task id. A redelivered request with the same idempotency key returns the same task.
- `decideApproval(scope, { taskId, approvalId, decision: "approved" | "rejected" })`: capability `task:submit` checked **before** any storage read (a `viewer` can never decide); reads the pending approval tenant-scoped, rejects an expired row, writes the decision through `ApprovalRepository.decide` (audit row included), appends `approval.decided`, and on approval enqueues exactly one follow-up job — `resume_task` for `git.push_branch`, `create_pull_request` for `github.create_pull_request` — carrying `{taskId, approvalId, action}`; on rejection it moves the task to `failed` through the lifecycle and enqueues nothing. A redelivered decision is `CONFLICT`, never a second job.
- Expose both actions as server functions (no route, no page) so wave 9 only adds buttons; keep the existing no-store/CSRF and server-only boundaries.
- Tests: capability gate (viewer denied before storage), foreign-tenant denial, non-`failed` source rejected, depth-4 rejection, verbatim boundary reproduction, one job, idempotent replay; approval decision — expired row refused, rejection fails the task with no job, approval enqueues exactly one job of the right type, replay is `CONFLICT`, and audit/`approval.decided` rows are written.
- DoD: scoped gates green ×2, `apps/web` build + client sweep unchanged-green (no client surface added); commit + report.

### W8-OPS — Coordinator integration (after all lanes report)
- Merge green lanes into `main` with `--no-ff`; verify `git diff --stat main...<branch> -- <non-owned paths>` is empty; prune worktrees.
- Extend `scripts/acceptance-offline.ts`: submit → claim → clone → write/commit → validation **pass** → approval pause → resume → push (fake) → `review_ready` → approve PR → `create_pull_request` (fake) → `pull_request_created`; and a second scenario: validation **fail** → `failed`, no push, then `retryTask` → new task in the same boundary → one `run_task`; zero provider credentials.
- Full `bun run validate` ×2; web build + client sweep + smoke (must be unchanged-green with no new client surface); prepare `0006` for Neon and apply **only with explicit user approval** (Neon MCP); update STATUS/DECISIONS/CHALLENGES/ARCHITECTURE/SKILL-REGISTRY.
- Live close-out (needs a separate explicit approval): one bounded run against `ivory-26/agent-bank` that passes validation and creates **one** real pull request from a fresh branch, then report measured spend and remaining branches.

### Dependency graph / parallelism
`W8-0 contracts (main) → {W8-DB, W8-VAL, W8-GH in parallel} → {W8-WRK, W8-CTL in parallel, after the first three merge} → W8-OPS`.
W8-WRK codes only against the shared contracts plus fakes until `runValidationCommand`/`createPullRequestForTask` are on `main`; W8-CTL depends on `TaskRepository.createRetry` (W8-DB) and the shared event vocabulary.

### Wave 8 non-goals
- **All web UI** (design system, run detail, approvals page, repository onboarding, navigation) — deferred to wave 9 with the user's design input.
- Workflow editor (React Flow), object storage for full patches, multi-agent/planner-reviewer topology, hosting/deploy pipeline, RLS, automatic repair turns.
- Live inference beyond the single close-out acceptance; no retries after success.

### Wave 8 execution record (2026-10-30)

Contracts `c44f2bb` (shared review schemas, `task.retried`, `create_pull_request` job type) and decisions `849bb22` landed on `main` before any lane. All five lanes reported, were independently re-gated twice, and merged with `--no-ff`:

| Lane | Commit | Coordinator gates (×2) |
|---|---|---|
| W8-DB | `27e4ac5` | biome 0 errors / 10 warnings · typecheck 8/8 · 232 db tests (6 live skips) |
| W8-VAL | `88e5e5c` | biome clean · typecheck 8/8 · 353 sandbox tests |
| W8-GH | `3fa5e87` | biome clean · typecheck 8/8 · 94 integrations tests |
| W8-WRK | `fee0bfe` | biome clean · typecheck 8/8 · 196 worker tests |
| W8-CTL | `73fddcb` | biome clean · typecheck 8/8 · 212 web tests · build · 30-check sweep |

Merge commits: `a2c4e1e` (DB), `546551a` (VAL), `d27f4e2` (GH), `cfe1c2f` (WRK), `9f9d2c4` (CTL). Coordinator integration after the merges: `99c711c` declared the `@isolate/shared` workspace dependency that `packages/sandbox` had reached into by relative path; `3e2455e` added `TaskRepository.recordPullRequest` (driver, fake, tenant-scoped test) so the PR stage persists instead of only emitting an event; `39ffe2c` extended the offline acceptance.

**Post-merge `main`**: biome 0 errors (10 pre-existing warnings) · typecheck 8/8 · **1398 pass / 0 fail / 6 skip** offline ×2 · **1398 pass / 0 fail with live Neon** after `0006` · web build + 30-check sweep + smoke · `acceptance:offline` PASS with 7 scenarios.

**Migration applied (2026-10-30, user-approved)**: `0006_review_surface.sql` via `scripts/apply-migration.ts` (13 statements, all migrations idempotent), 20/20 tables verified. Neon MCP verification: `repositories.validation_command text`, `repositories.validation_timeout_ms integer default 300000`, `tasks.pull_request_number integer`, `tasks.pull_request_url text`, `tasks.retry_of uuid`, `tasks.retry_depth integer default 0`; CHECKs `repositories_validation_command_length_check`, `repositories_validation_timeout_ms_range_check`, `tasks_pull_request_url_length_check`, `tasks_retry_depth_range_check`; `jobs_type_check` accepts `create_pull_request`; `tasks_retry_of_idx` present.

**Acceptance scenarios now covered offline** (`bun run acceptance:offline`, zero provider credentials): submit/replay → claim → gated tools → usage → destroy → ack; throw and abort teardown; **validation passed** (`bun test` exit 0 → `review_ready`); **validation failed** (exit 1 → `failed`, log artifact, no push); **pull request** (approved + SHA match → PR recorded → `pull_request_created`); **retry** (failed task → same-boundary new task → one `run_task` → replay stable).

**Deliberately not done**: no live GitHub or inference call (user deferred the live PR to a later request); no web UI (routes/components/styles untouched). Wave 9 owns the design system, run detail, approvals page and repository onboarding.

### Wave 8 live acceptance record (2026-10-30)

**PASSED** after three diagnosed failures: task `2960432e-e63a-404d-bf34-cacae5d4fe3d`, branch `task/w8-live-24b80218`, PR `ivory-26/agent-bank#1` (open, one file, head `b0d5700`), status `pull_request_created`. Real Meta (`6380/3528` and `8735/2631` tokens, cost null) and one Modal sandbox (`0.125 CPU / 512 MiB`, destroyed, 0 running). Validation `skipped` on this repo (vitest needs installed deps; deny-egress sandbox cannot fetch them).

Fixes produced by the live path: `ade7d5f` (composition forwarded `resolveSandboxEnv` + `createSandboxBackend`; before it, jobs cloned without a credential and ran tool-less), `5abf9d8` (turn-budget exhaustion with a produced diff is completion), and the acceptance verifier now requests `pullRequests: "read"`. Runner: `scripts/acceptance-live-pr.ts` (`LIVE_PR=1`); diagnostic: `scripts/diagnose-live-clone.ts` (`DIAGNOSE_LIVE=1`, one tiny sandbox).

## Wave 9 — Completion truth, live validation, concurrency (planned 2026-10-30)

Goal: **completion is proven by the task's environment, never by a turn budget or a model's word.** A live run must show a configured validation command *executing and passing* before a push, a failing command blocking the push, and policy decisions persisted. Contracts are committed first (`c6f3b8b`: `acceptanceCheckSchema`, `acceptanceReportSchema`, `acceptance.started/finished` events).

### W9-0 contracts (done, on `main`)
- `@isolate/shared`: `acceptanceCheckSchema` = `path_exists | content_matches | command_exit_zero` (bounded, path-confined, strict), `acceptanceReportSchema` (bounded, `matched <= total`), events `acceptance.started` / `acceptance.finished`.

### W9-DB — `packages/db/**` (owner: agent W9-DB, branch `task/w9-db`)
- Migration `0007_acceptance_contract.sql` (**idempotent, not applied by the lane**): `tasks.acceptance_checks jsonb NOT NULL DEFAULT '[]'::jsonb` with a `jsonb_typeof(...) = 'array'` CHECK and an array-length bound (≤32).
- `TaskRow.acceptance_checks` + create/read mapping; `TaskCreateInput.acceptanceChecks`.
- `BranchLockRepository`: `acquire({organizationId, repositoryId, branch})` / `release` over `pg_try_advisory_lock(hashtext(org:repo:branch))` on a dedicated connection (session-scoped; the worker holds it for one job and releases in `finally`).
- Live suite: acceptance_checks round-trip with a DB-level JSON type assertion; the lock is exclusive for the same triple and free for a different one.

### W9-EXEC — `packages/sandbox/**` + `apps/worker/**` (owner: agent W9-EXEC, branch `task/w9-exec`)
- Validation argv: allow `bun test <path>` (plain `bun test` unchanged) where `<path>` is a bounded relative path, no `..`, no absolute path, no leading `-`; tests for every refusal.
- `runAcceptanceChecks` (worker): executes the three kinds in the task sandbox through the trusted policy — `path_exists`, `content_matches` (bounded read + regex, never logs content), `command_exit_zero` (validation runner). Emits `acceptance.started/finished`, stores a bounded `report` artifact, returns `AcceptanceReport`.
- **Completion rule**: when acceptance checks exist, every check must pass AND a configured validation command must pass before `review_ready`; any failure transitions `failed` with the report. When only a validation command exists, it gates. Only when **neither** exists does the diff-only rule apply, and the attempt outcome records `completion: "diff-only"`.
- `tool_invocations`: persist one row per tool call at the policy boundary (tool name, decision, bounded arg digest, duration, outcome) through an injected sink; denied calls included. Closes a table that has a repository but no runtime writer.
- Concurrency: `createWorkerLoop` honours `config.maxConcurrency` with a bounded pool (today it is single-in-flight), and the handler takes a per-repository+branch lock before provisioning and releases it in `finally`; a lock miss returns a bounded retry verdict with backoff.
- Tests: acceptance pass/fail per kind, no push after a failed check, tool-invocation rows on allow/deny, concurrency cap observed, lock miss → retry, no secret/content leakage.

### W9-WEB — `apps/web` server-side (owner: agent W9-WEB, after W9-DB; branch `task/w9-web`)
- Submission schema accepts `acceptanceChecks` (bounded, ≤32), the Postgres store persists them, the in-memory store mirrors it, `TaskSummary` unchanged. **No UI files.**

### W9-OPS — Coordinator (live proof, one bounded run each)
- Apply `0007` (user approval) and verify through the Neon MCP.
- **Live pass (validation PASS)**: `repositories.validation_command = "bun test live_acceptance.test.ts"`, acceptance checks `[path_exists LIVE_ACCEPTANCE.md, path_exists live_acceptance.test.ts, content_matches ...]`; the agent writes both files, validation runs in the sandbox and passes, then push → PR approval → PR.
- **Live pass (validation FAIL)**: a command that exits non-zero; the task must end `failed`, **no branch pushed**, the report artifact present, and `retryTask` able to rerun it.
- Record measured tokens, verify 0 sandboxes, update STATUS/CHALLENGES/DECISIONS.

## Wave 10 — DevSecOps incident response + context fabric (planned 2026-10-31)

Goal: the agent is triggered by real operational signals and resolves them end to end with the same execution loop.

- **Triggers**: signed webhooks from PagerDuty/Sentry/Datadog/Grafana and GitHub (failed workflow, failing check suite, security alert) → normalized `IncidentSignal` → task with `source`, `severity`, `service`, `fingerprint` (dedupe), `links`, bounded evidence bundle. Incidents are a new task *source*, not a new execution path.
- **Context fabric** (read-only connectors, scoped auth, per-tool permissions, audited): GitHub Actions runs and logs, check suites, branch protection/rulesets, CODEOWNERS, CONTRIBUTING, PR templates, recent commits and PRs; observability queries (Sentry issues, Datadog/Grafana metrics + logs, trace ids); deployment history; runbooks from `docs/runbooks/**` and the platform.
- **Context assembly**: bounded, cited `ContextBundle` (source, path/url, excerpt, trust level) injected with the untrusted-data rule; every item capped and attributable.
- **Resolution loop**: reproduce → query observability → fix on a branch → validation (wave 9) → human approval → PR linked to the incident → post-incident report artifact + timeline; escalate to `blocked` with evidence when the incident is not code-fixable.
- **Data**: `incidents`, `incident_signals`, `context_items`, `runbook_refs`, `connector_credentials` (server-only, never in prompts), plus `tasks.incident_id`.
- **Safety**: incident tasks inherit the same caps; production writes (deploy/rollback/secret change) are separate sensitive tools that always require approval; no connector credential enters model context.

### Multi-agent inside one sandbox (design, wave 10)
- One sandbox per task remains the isolation unit. An **orchestrator** plans and delegates to N **subagents** sharing the workspace but owning disjoint `fileOwnership` path partitions.
- Each subagent gets its own tool gate bound to the same `SandboxHandle`, its own turn/token budget, and no credentials beyond the task scope; results return as bounded summaries.
- Sequential by default (deterministic diffs); parallel only when ownership globs are provably disjoint, with a workspace path lock. Every subagent turn is a `run_event` with `agentId`; the diff and validation gates run once on the combined result.

### Concurrency model (wave 9 + 10)
- Queue claiming is already `FOR UPDATE SKIP LOCKED`; wave 9 adds a bounded in-process pool honouring `maxConcurrency` and a per-repository+branch advisory lock so two jobs never write one branch.
- Per-organization quotas and provider rate limits are wave 10; the sandbox provider remains the concurrency ceiling.

## Wave 11 — P1 fidelity, observability, storage (planned, after wave 9 live proof)

Lanes are defined now so future agents can claim them without re-deriving context. Contracts first (coordinator), then two parallel lanes, then integration.

### W11-0 — Contracts (coordinator)
- `BlobStore` interface in `@isolate/shared` (`put/get/list/delete` with size, content type and sha256), `CostPriceTable` type, and a `RunSummary` read shape (per-task tokens, sandbox seconds, cost, gate outcomes). No implementation.

### W11-PLAN — `packages/mastra/**` + docs (owner: agent W11-PLAN, branch `task/w11-plan`)
- Retire `createSdlcWorkflow` and its tests; the decision is already recorded in `DECISIONS.md`; document the handler as the runtime of record in `ARCHITECTURE.md §3`. If the user chooses plan execution instead, rewrite the workflow around the current helpers with a documented storage/resume design — decide first and record it.
- DoD: no dead lifecycle left, docs consistent, gates green ×2.

### W11-OBS — `packages/shared/**` + `apps/worker/**` + `scripts/**` (owner: agent W11-OBS, branch `task/w11-obs`)
- A trusted **price table** (config-driven, never guessed) so `usage_records.cost_usd` is populated from measured tokens and sandbox seconds; a `summarizeTask` read over `usage_records` + `task_attempts` + `artifacts`; and **structured metrics** through the existing logger (`isolate.metric` records with fixed names: claimed/completed/failed/dead_letter, turn latency, sandbox seconds, validation outcome, PR outcome).
- DoD: offline tests with fake clocks/rows, no external backend required, docs updated with the metric vocabulary.

### W11-STORE — `packages/db/**` + `apps/worker/**` (owner: agent W11-STORE, branch `task/w11-store`)
- `BlobStore` over an inline/DB-backed implementation with a 2 MiB ceiling and a documented S3/R2 seam; large diffs and log bundles move to the store, `artifacts.storage_ref` points at it, and the 256 KiB inline column stays for small payloads. No cloud credentials in this lane.
- DoD: migration if needed, tenant-scoped reads, live suite that skips without `DATABASE_URL`, worker writes through the store.

### W11-OPS — Coordinator
- Merge green lanes, apply any migration with user approval, run full validate ×2, extend `acceptance:offline` where behaviour changed, update STATUS/CHALLENGES, and confirm the wave-9 live proofs still hold.

## Wave 12 — Product surface (web UI) and deployment decision (planned; the user has design input)

- **Does not start without the user's design direction.** It includes the design-system/token pass, run detail, approvals, repository onboarding, and the deployment decision (hosting, production auth origin, own Google credentials, object storage backend, observability backend, CI/CD deploy, secret management, backup/restore).
- Entry criteria: waves 9–11 merged and documented; a short design brief from the user; the deployment questions answered (target host, budget, domain, data residency).

## Wave 4 — legacy handover (superseded by the provider-plane plan above)
- W4-A → folded into W4-WEB; W4-B → W4-DB; W4-C → W4-WEB; W4-D → W4-WRK; W4-E → W4-SBX; W4-F → wave 5; W4-G → W4-OPS; W4-H → opportunistic tooling.

## Wave 2 — Integration & validation (coordinator)
- Merge all `task/*` branches → sprint lanes → `main`; full `bun run validate`; apply `0001_platform_core.sql` to Neon (with user approval); QA/DoD audit; docs + challenges; CI green on pushed commit.
- Status: done

## Later (event scope decisions pending)
- Sandbox hosted providers, visual editor UI (React Flow), auth/tenancy surface on the web app.

## Sprint A — Foundation & Data Plane (`sprint/a-foundation`)

### A1 — `@isolate/shared` implementation
- Owner: agent session A1 · Worktree: `../worktrees-platform/sa1-shared` · Branch: `task/sa1-shared`
- File ownership: `packages/shared/**`
- DoD: brief §Task A1 (schemas + deep redaction + full test set).
- Coordinator verification: implementation + 60 passing tests verified in the new repo — scoped gates all green (biome / tsc / 60 pass · 0 fail), no drift to commit (work is at the seed commit). Its `.gitattributes` CRLF proposal adopted by the coordinator.
- Status: **done**

### A2 — `@isolate/db` implementation
- Owner: agent session A2 · Worktree: `../worktrees-platform/sa2-db` · Branch: `task/sa2-db`
- Coordinator verification: commits `bcf71f6` + `0f96283` — contracts declared/exported in-module (self-imports gone, 11 tsc errors → 0), fresh `client.ts` rewrite (26 LOC), budget jsonb snake_case bug fixed at insert boundary. Gates: biome clean (9 non-null warnings, test files only), tsc 0 errors, **27 pass / 1 skip** offline; **28 pass / 0 fail live** (pre-migration probe, correct `../../isolate/.env` path). Migration `0001_platform_core.sql` ready to apply (coordinator, with user approval).
- Status: **done**

## Sprint B — Runtime & Orchestration (`sprint/b-runtime`)

### B1 — Durable worker loop (`apps/worker`)
- Owner: agent session B1 · Worktree: `../worktrees-platform/sb1-worker` · Branch: `task/sb1-worker`
- Coordinator verification: commit `45fe874` — both tsc defects fixed (generic `settle()`, explicit `.catch` return annotation); 3 transplant test-fake defects found + fixed (frozen clock, simulated lease-loss, ticker fixtures). Gates: biome 0 issues ×2, tsc clean, **20 pass / 0 fail** (loop 17 + config 3), ×3 reproducibility. Contract proposals queued for wave-2 review: `JobRow.lease`/`lastError` totality; `WorkerConfig.jobTimeoutMs` promotion.
- Status: **done**

### B2 — Mastra SDLC workflow (`packages/mastra`)
- Owner: agent session B2 · Worktree: `../worktrees-platform/sb2-mastra` · Branch: `task/sb2-mastra`
- Coordinator verification: commit `4353dba` — `createSdlcWorkflow` per ratified dountil mapping (validate→repair loop body, persisted `repairAttemptsUsed`, bail short-circuits); policy-gated `wirePlatformTools` (deny-by-default, approval-required for sensitive); fake-runtime-only tests. Gates: biome 0 issues ×2, tsc clean, **14 pass / 0 fail**. Key artifacts for wave 2: dash-only step ids (dotted ids break resume — B3 must forbid `.` in node ids), `mastra` instance with storage required for suspend/resume, agent-turn budget = `maxRepairAttempts + 2`.
- Status: **done**

### B3 — Workflow registry/validation/compiler (`packages/workflow-schema`)
- Owner: agent session B3 · Worktree: `../worktrees-platform/sb3-wf-schema` · Branch: `task/sb3-wf-schema`
- Coordinator verification: commit `ec6afde` — test suite RECREATED (transplant had silently dropped it; see CHALLENGES), biome 0 issues, tsc clean, **52 pass / 0 fail**. Supported-subset + rejection-shape reports and editor-facing integration checklist delivered.
- Status: **done**

### B4 — GitHub connector (`packages/integrations`)
- Owner: agent session B4 · Worktree: `../worktrees-platform/sb4-integrations` · Branch: `task/sb4-integrations`
- Coordinator verification: commit `9226219` — biome 0 issues, tsc clean, **26 pass / 0 fail** (redact 6 + rest-client 20). Deny-default approval gating redaction-proof + audit sink covered; contract note: failure union extended with NOT_FOUND/RATE_LIMITED (optional sanitized message), consumers switch on `code`.
- Status: **done**


### Wave 9 execution record (in progress)

| Lane | Commit | Coordinator gates |
|---|---|---|
| W9-DB | `f7ee997` + `5277068` → merge `e515798` | biome 0 errors · typecheck 8/8 · 256 db tests ×2 |
| W9-EXEC | checkpoint `cf90e2e`, being finished by W9-EXEC2 | pending |
| W9-WEB | running | pending |

W9-DB shipped `tasks.acceptance_checks` (`0007`, unapplied) with a shared validator, plus a **row-lease** `branch_locks` table and `BranchLockRepository`. The first implementation used session advisory locks; review caught that our `DATABASE_URL` is a `-pooler` host (PgBouncer transaction mode), where session locks can leak or double-grant, so it was replaced by a single-statement lease (`ON CONFLICT ... WHERE expires_at < now()`), with the lesson recorded in CHALLENGES.

Known mid-wave red: `apps/web` "ownership, compile, task and queue writes share one transaction" — the transaction fixture still asserts the old task-insert argument shape now that `acceptance_checks` is a column. W9-WEB owns the fix.
