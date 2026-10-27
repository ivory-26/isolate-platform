# Status

Last updated: 2026-10-27 (event build, day 1 evening — wave 3 launched, 5-agent branch-per-agent swarm)

## Current: wave 3 in flight (5 parallel agent sessions + coordinator)

- Swarm topology: one worktree + one branch per agent under `C:/Users/Sahil/Documents/worktrees-platform/w3-*`, branches `task/w3-worker` (apps/worker), `task/w3-db` (packages/db), `task/w3-wfschema` (packages/workflow-schema), `task/w3-web` (apps/web, fresh TanStack Start scaffold), `task/w3-sandbox` (new packages/sandbox). Task specs + DoD in `project/TASKS.md`.
- Coordinator pre-commit (on `main`) landed first: `workerConfigSchema.jobTimeoutMs` promoted (contract from B1 proposal — default 120000, bounds 1000–3600000, shared tests updated); `packages/sandbox` added to typecheck-all auto-discovery; B1 `JobRow.lease`/`lastError` totality proposal verified ALREADY SATISFIED by the db contract (total nullable, consumers use `== null` guards) — recorded in DECISIONS. Scoped gates green: biome ✅ · tsc ✅ · bun test shared 60/60 ✅.
- New skills installed per SKILLS.md checklist and reviewed: `tanstack-start-best-practices`, `tanstack-router-best-practices`, `tanstack-query-best-practices` (source `deckardger/tanstack-agent-skills`, installed user-level 2026-10-27, contents reviewed — guidance-only, no policy bypass).
- Integration (coordinator, after agents report): central merge → main, lockfile regen, full validate, migration 0002 apply to Neon (with user approval), secret sweep on web client bundle, docs, push, CI.

## Event build day 1 — wave 2 integrated (verified)

## Repository
- This repo (`isolate-platform`) contains ONLY event-week work (started Oct 27, 2026), fresh git history. The pre-event spike/compatibility MVP lives in a separate private repo and stays out of this history — including file blobs in ALL branch histories (verified: a pre-event migration file that had leaked back via a transplant merge was purged from every ref by a coordinator history rewrite and force-push).
- CI on `main`: lint + typecheck + tests + advisory gitleaks — **green**. (Build step returns when the web app scaffold lands.)

## What is implemented so far (Sprint 1 — contracts & foundation + Sprint 2 — runtime, complete)

### Shared contracts & utilities (`packages/shared`) — A1, done
- Branded id types + `newId(prefix)`; `Result<T,E>` with `isOk`/`isErr` narrowing guards; `PlatformError` with ErrorCode union and retryability classification.
- Task state machine: `TASK_STATE_TRANSITIONS`, `canTransition`, terminal states — exercised by tests asserting every declared transition is legal and every state has at least one declared rejection.
- Run-event vocabulary: envelope schema, `parseRunEvent`, `createRunEvent` (Zod-validated, untrusted-input safe: parse errors surface field paths + issue codes only, never offending values).
- Zod schemas: task-transition request (optimistic `expectedStatus→to` legality), worker config (hard int bounds, egress deny/allowlist only), budget limits.
- Logging + redaction: `createConsoleLogger` (structured, redacting) + `redactDeep` (plain-object walker, non-plain/circular detection, depth cap 6, `REDACTED` sentinel).
- **60 tests** (state machine, result, errors, ids/brands, events, schemas, redaction).

### Data plane (`packages/db`) — A2, done + LIVE-VERIFIED
- Migration `0001_platform_core.sql` (this repo's first, idempotent `CREATE ... IF NOT EXISTS`, Postgres ≥13): organizations, users, memberships, repositories, integrations + integration_permissions, workflow_definitions + workflow_versions, tasks (budget JSONB `budget_limits` with snake_case keys, unique org+idempotency_key), task_attempts, workflow_runs, run_events, artifacts, approvals (payload_sha256 binding + expiry), tool_invocations, audit_events, usage_records, and the durable `jobs` queue with the partial `jobs_claimable_idx` index backing `FOR UPDATE SKIP LOCKED` atomic claims.
- Fresh `createDb` client factory (bounded pool 5/30s/10s, `prepare: false` for Neon PgBouncer transaction mode, notices silenced) + `parseJsonbColumn` normalizer (see Challenges — jsonb decode is not guaranteed through param bindings on Neon pooled endpoints).
- Repositories (contracts declared in-module): `TaskRepository` (transition guard enforcing the shared state machine; optimistic `expectedStatus`; CONFLICT classification precedes INVALID_TRANSITION — verified live), `QueueRepository` (atomic claim; ack/ackFail computes retry/dead-letter from stored counters — callers cannot supply them), `ApprovalRepository` (decide only against exact `payload_sha256` + pending + not-expired), `TaskAttemptRepository`, `WorkflowRunRepository`, `AuditRepository` + `ToolInvocationRepository`.
- In-memory fakes built on the SAME pure decision helpers as the PG drivers (no fake/driver drift); `claimNext` accepts a `nowMs` hook for deterministic backoff tests.
- Tests: pure-logic (transition matrix incl. terminal rejections, ackFail dead-letter/backoff math, approval decision matrix with inclusive expiry boundary; **28 pass offline**, the live test skipping cleanly) + **live Neon roundtrip (28/28 pass after migration apply)** covering task create + dedupe, optimistic transition with stale-expectation CONFLICT, atomic queue claim + foreign-ack rejection + ack lifecycle, payload-bound approval decision.
- Migration **applied to the NEW Neon project `isolate-platform` (`divine-butterfly-60669535`, Pg 17, aws-us-west-2)**; schema verified: exactly the 18 planned tables. The old MVP Neon project (`isolate-mvp`) was **permanently purged** after verification that it held only spike tables.

### Durable worker (`apps/worker`) — B1, done
- `createWorkerLoop`: bounded poll tick, `claimNext → handler(ctx) → ackComplete/ackFail` protocol; retryable verdicts → `ackFail` (requeue/dead-letter decided by the queue's stored counters, never the caller); non-retryable short-circuits; missing/no-op handler paths ack-fail NOT_FOUND/VALIDATION_FAILED.
- `heartbeat` ticker (~lease/2, skip-if-in-flight, self-stops on lease loss and aborts the handler signal); `requeueExpiredLeases` reaper ticker with overlap guard; per-job hard timeout budget (test seam; `BUDGET_EXCEEDED` ack-fail on handler that ignores its abort signal).
- Graceful stop: SIGINT/SIGTERM/uncaughtException → signal + resolvable within a bounded drain even if a handler hangs; `sanitize.ts` keeps messages error-code-first (URLs/bearer/api-keys stripped, 300-char cap); unknown errors collapse to `INTERNAL` with details withheld.
- **20 tests** ×3 reproducibility (in-memory queue + fake handlers) — CI-green after scaling the heartbeat spam-test bound by elapsed time.

### Orchestration runtime (`packages/mastra`) — B2, done
- d.ts-verified against installed `@mastra/core@1.79.0` before implementation (dotted-step-id resume bug avoided by dash-named steps; suspension→resume requires a storage-backed `Mastra`).
- `createSdlcWorkflow` per the ratified mapping: `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created`; loop body runs validation then at most one repair turn while budget remains; `repairAttemptsUsed` persisted through workflow `stateSchema`/`setState` (never raw retry); terminal failures (`REPAIR_BUDGET_EXHAUSTED`, non-recoverable validation, agent-turn failure, approval rejection, PR-creation failure) short-circuit via `bail()` into a typed outcome union. `defaultSdlcPlan` kept as the serializable template.
- Policy-gated tool registry: `wirePlatformTools({policy, implementations, onDecision}).forTask(ctx)` over `createTool` — deny-by-default snapshot policy, sensitive actions always resolve `APPROVAL_REQUIRED`, missing/failed implementations deny or fail with bounded codes, crash-safe onDecision (audit hook).
- **14 fake-runtime-only tests** (turn-budget bounds, suspension/resume across approvals and rejections, policy denials, per-turn recording) — zero provider/network.

### Visual workflow compiler (`packages/workflow-schema`) — B3, done
- Finite node registry with strict per-type Zod configs: `task.agent` (agent id + prompt template ref), `tool.call` (must exist in a supplied allowlist — deny-by-default), `approval.gate` (action + risk), `condition.switch` (enumerated branches, `eq` only, one shared left variable), `validate.loop` (bounded `maxAttempts` ≤ 10, cross-checked against task budget).
- `validateDefinition`: duplicate ids, missing endpoints, unreachable required steps, no-terminal checks, `UNSAFE_CONFIG` on undeclared keys, cycle policy (only a single self-contained `validate.loop` cycle with an exit edge is supported), `UNAUTHORIZED_TOOL`, `MISSING_VERSION`. Pure data in/out — no eval/codegen.
- `compileWorkflow`: version-pinned, deterministic topological order (Kahn over Tarjan SCC with declared-order tie-breaks).
- **52 tests**; every rejection class exercised.

### GitHub connector (`packages/integrations`) — B4, done
- Real REST client over injectable `fetch` (10s bounded timeout): single `POST /repos/{owner}/{repo}/pulls`; credentials injected, never logged; Zod-validated spec + response boundaries; failure mapping 404→`NOT_FOUND`, 403→`POLICY_DENIED`, 429→`RATE_LIMITED`(+retry hint), 422→`VALIDATION_FAILED`, 401/5xx/network→`INTEGRATION_UNAVAILABLE` (retryable only), unmapped 4xx→`POLICY_DENIED` (deny-default).
- Approval gating built-in: sensitive paths (unknown policy → sensitive) require `approvalId` + payload-bound `approvalPayloadSha256` (`sha256Hex(canonicalPullRequestPayload(spec))` recomputed and lowercased-compared; any drift re-prompts approval — fail-safe).
- Redaction choke point (`redactSecrets`) for every emission path — regression-proven against planted tokens; audit sink (AuditRepository-shaped, fail-quiet) fires on every outcome including blocks; MCP allowlist guard (deny-default).
- **26 tests** (redaction 6 + rest-client 20).

### Integration & validation (wave 2, coordinator)
- All `task/*` branches merged → `sprint/a-foundation` + `sprint/b-runtime` → `main` with **zero merge conflicts** (file-ownership discipline).
- Full offline gates on main: biome clean · typecheck 6/6 projects · **200 pass / 0 fail / 1 skip across 20 files**. Live data-plane suite: 28/28.
- CI green on pushed `main` (tests + gitleaks). One CI-found flake fixed centrally (heartbeat test bound).
- Reviewers' contract proposals recorded and deferred to wave 3 (see `project/DECISIONS.md`).

## Data plane changes (this milestone)
- **New Neon project** `isolate-platform` (`divine-butterfly-60669535`, Pg 17, aws-us-west-2) is the system of record for this repo going forward.
- `0001_platform_core.sql` applied there by `scripts/apply-migration.ts` (repo-native runner; statement-level, idempotent, never prints env values); 18 platform tables verified present.
- Old MVP project (`isolate-mvp`, `dark-dream-15274602`) deleted — the spike DB is gone; nothing pre-event remains in Neon.
- The old `DATABASE_URL` in the legacy workspace is no longer referenced by this repo's tests: the event repo root `.env` (gitignored) points at the new project.

## Wave 3 queue (reviewed, deferred — coordinator repository)
- B1: promote `JobRow.lease`/`lastError` totality (non-optional nullable) + `WorkerConfig.jobTimeoutMs` from test seam.
- B3: db schema proposals (version-pinned `compiled_plans`, `rejection_issues`) + shared workflow-event exports.
- B2 → B3 rule: forbid dotted node/step ids in the compiler (Mastra resume treats `.` as a path separator).
- Deferred: post-kickoff web app scaffold (fresh TanStack Start app — NOT a legacy port), sandbox execution plane, visual editor UI.