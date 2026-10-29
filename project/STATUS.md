# Status

Last updated: 2026-10-29 (wave 3 fully integrated, live-verified; wave 4 handover below)

## Current: wave 3 complete — merged, migrated, validated

- All five `task/w3-*` branches committed by the coordinator and merged into `main` with **zero conflicts** (`--no-ff`, one merge commit per branch). Worktree copies were reconciled by content hash before merging (see CHALLENGES: duplicated W3-D/W3-F work inside `w3-web`).
- Root lockfile regenerated centrally (`bun install`); `apps/web` dependencies and `packages/sandbox` workspace are locked.
- Full gates on `main`: biome 0 errors (9 pre-existing test warnings) · typecheck **8/8 projects** · **662 pass / 0 fail / 0 skip across 38 files** with live Neon enabled (offline: 660 pass / 2 skip).
- Web production build green; client-bundle secret sweep green (22 checks over 4 client files).
- CI now builds the web app and runs the client secret sweep in addition to lint/typecheck/tests.
- Migration `0002_workflow_compilation.sql` **applied to Neon `isolate-platform`** (`divine-butterfly-60669535`) via `scripts/apply-migration.ts`; **20/20 tables verified**.
- Live suites: 139/139 in `packages/db` (both Neon roundtrips). One integration defect fixed: JSON strings bound to `::jsonb` were double-encoded by the driver (masked in 0001 by `parseJsonbColumn`; exposed by the new `jsonb_typeof` CHECKs) — new repositories now bind `$n::text::jsonb` and the live test asserts DB-level JSON types.

## Wave 3 deliverables (verified)

### W3-W — worker consumes `WorkerConfig.jobTimeoutMs`
- `apps/worker/src/config.ts` parses the promoted contract (default 120000, bounds 1000–3600000); `loop.ts` sources the per-job hard timeout from config, dep-level override remains a test seam. 33 tests pass (config + loop), including config-supplied timeout → `BUDGET_EXCEEDED` path.

### W3-D — workflow compilation persistence
- Migration `0002_workflow_compilation.sql`: `compiled_plans` (org-scoped, `(organization_id, workflow_definition_id, workflow_version)` unique, insert-only, plan/pin CHECK constraints) and `rejection_issues` (append-only history, non-empty array CHECK, `(org, def, version, created_at DESC, id DESC)` index); composite FKs prevent cross-tenant and nonexistent-version writes.
- `CompiledPlanRepository` / `WorkflowRejectionRepository` / `WorkflowVersionRepository` with pure decision helpers + in-memory fakes on the same helpers; 137 offline tests; live suite covers atomic duplicate-save CONFLICT, tenant/version NOT_FOUND, DB-enforced FKs and CHECKs, append-only rejection ordering.

### W3-F — compiler rejects dotted node ids + unknown-input hardening
- `INVALID_NODE_ID` rejection class at `nodes[index].id` (Mastra resume treats `.` as path separator); ids are never rewritten.
- New `shape.ts` boundary: `validateDefinition`/`compileWorkflow` accept `unknown` from authored JSON, reject unknown fields instead of stripping, and diagnostics stop echoing authored values/keys. 157 tests (up from 52).

### W3-S — `packages/sandbox`
- Deny-by-default provider contract + `NullProvider` (refuses all execution), command policy (timeout, arg shape, output caps, egress intent), git helpers (`openRepo`, `createBranch`, `createWorktree`, `removeWorktree`, `task/<id>` naming) over `Bun.$` with bounded output and temp fixtures only. 119 tests, offline.

### W3-U — fresh TanStack Start control plane (`apps/web`)
- Bun + React + TanStack Start/Router/Query, two routes: task submission (server function validates with `@isolate/shared`, enqueues via `TaskRepository`/`QueueRepository`) and runs/tasks list.
- Local mode uses `@isolate/db/testing` fakes when `DATABASE_URL` is absent; Postgres mode uses `@isolate/db` server-side only. Workflow compilation service (scope → membership → policy → compile → persist/reject) is implemented server-side with a W4-owned authored-version reader seam.
- 114 tests, typecheck, production build and client secret sweep green; no provider keys or DB URLs in client bundle.

## Wave 4 handover (next)

1. **W4-A — auth/tenancy surface:** implement `AuthoredWorkflowVersionReader` and real session → `CallerScope` resolution (currently dev/local-mode only); enforce membership/permission in server handlers; add a tenant-isolation test at API boundary.
2. **W4-B — normalize remaining jsonb write paths:** 0001 repositories still bind `JSON.stringify(...)` to `::jsonb`; the roundtrip works only because `parseJsonbColumn` parses the double-encoded value. Switch to object or `::text::jsonb` binds and add live `jsonb_typeof` assertions. This matters for SQL-side scans (e.g. `budget_limits->>'max_duration_ms'`).
3. **W4-C — wire compilation into the task pipeline:** compile at task submit against an authored version, persist the pinned plan, surface rejection issues in the UI, and make the worker consume the pinned plan instead of ad-hoc orchestration.
4. **W4-D — Mastra storage + worker integration:** confirm the current Neon/Postgres storage adapter against installed `@mastra/core@1.79.0` d.ts; wire `createSdlcWorkflow` into the worker loop with suspension/approval resume (storage-backed instance required).
5. **W4-E — sandbox execution plane:** implement a hosted provider behind `SandboxProvider`, wire command policy + egress policy into the worker, and keep the NullProvider as the default in development/CI.
6. **W4-F — approvals + visual editor UI:** React Flow editor over the validated node registry; approval queue route bound to payload SHA + expiry.
7. **W4-G — CI/ops:** optional live-DB job (Neon branch or disposable project), gitleaks triage → blocking, deploy pipeline. Push + CI verification of the wave-3 merge is still pending (not pushed in this session).
8. **W4-H — tooling:** `.zed/settings.json` still launches `@mastra/mcp-docs-server@latest`, which crashes on Windows (1.3.10 packaging bug). Qoder uses a pinned local 1.3.9 install; pinning Zed too was declined by the user and remains open.

## Repository
- This repo (`isolate-platform`) contains ONLY event-week work (started Oct 27, 2026), fresh git history. The pre-event spike/compatibility MVP lives in a separate private repo and stays out of this history.
- CI on `main`: lint + typecheck + tests + web build + client secret sweep + advisory gitleaks. Wave-3 merge is **not yet pushed**; CI greenness on the remote is unverified until push.
- Project agent assets: `.agents/skills/{mastra,mastra-factory}` (v2.4.0 / v1.0.0, `mastra-ai/skills`), `.zed/settings.json` (mastra MCP), `skills-lock.json`. `.claude/` is machine-local symlinks and gitignored.

## Data plane
- Neon project `isolate-platform` (`divine-butterfly-60669535`, Pg 17, aws-us-west-2) is the system of record.
- Migrations `0001_platform_core.sql` + `0002_workflow_compilation.sql` applied; 20 tables verified. Runner verifies the full table set and never prints environment values.
- Old MVP project (`isolate-mvp`) remains deleted; nothing pre-event is referenced by this repo.

## Wave 2 (history — verified)
- Shared contracts (60 tests), data plane (28 offline + 28 live), durable worker (20), Mastra SDLC workflow (14), workflow compiler (52), GitHub connector (26). Zero-conflict merges, CI green on the then-pushed `main`. Details below retained from the wave-2 record.

### Shared contracts & utilities (`packages/shared`) — A1, done
- Branded id types + `newId(prefix)`; `Result<T,E>` with `isOk`/`isErr` narrowing guards; `PlatformError` with ErrorCode union and retryability classification.
- Task state machine: `TASK_STATE_TRANSITIONS`, `canTransition`, terminal states — exercised by tests asserting every declared transition is legal and every state has at least one declared rejection.
- Run-event vocabulary: envelope schema, `parseRunEvent`, `createRunEvent` (Zod-validated, untrusted-input safe: parse errors surface field paths + issue codes only, never offending values).
- Zod schemas: task-transition request (optimistic `expectedStatus→to` legality), worker config (hard int bounds, egress deny/allowlist only), budget limits.
- Logging + redaction: `createConsoleLogger` (structured, redacting) + `redactDeep` (plain-object walker, non-plain/circular detection, depth cap 6, `REDACTED` sentinel).
- **60 tests** (state machine, result, errors, ids/brands, events, schemas, redaction).

### Data plane (`packages/db`) — A2, done + LIVE-VERIFIED
- Migration `0001_platform_core.sql` (idempotent, Postgres ≥13): organizations, users, memberships, repositories, integrations + integration_permissions, workflow_definitions + workflow_versions, tasks (budget JSONB `budget_limits` snake_case keys, unique org+idempotency_key), task_attempts, workflow_runs, run_events, artifacts, approvals (payload_sha256 binding + expiry), tool_invocations, audit_events, usage_records, and the durable `jobs` queue with partial `jobs_claimable_idx` backing `FOR UPDATE SKIP LOCKED` claims.
- Fresh `createDb` client factory (bounded pool 5/30s/10s, `prepare: false` for Neon PgBouncer transaction mode) + `parseJsonbColumn` row-mapping normalizer.
- Repositories: `TaskRepository` (state-machine guard, optimistic transitions, CONFLICT before INVALID_TRANSITION), `QueueRepository` (atomic claim; ack/ackFail from stored counters), `ApprovalRepository` (exact payload SHA + pending + expiry), `TaskAttemptRepository`, `WorkflowRunRepository`, `AuditRepository`, `ToolInvocationRepository`. In-memory fakes share the same pure decision helpers.
- Offline tests + live Neon roundtrip (task create/dedupe, stale-expectation CONFLICT, atomic queue claim + foreign-ack rejection, payload-bound approval).

### Durable worker (`apps/worker`) — B1, done
- `createWorkerLoop`: bounded poll tick, `claimNext → handler(ctx) → ackComplete/ackFail`; retryable verdicts requeue/dead-letter from stored counters; heartbeat (~lease/2, skip-if-in-flight, aborts handler on lease loss); `requeueExpiredLeases` reaper with overlap guard; per-job hard timeout (now config-sourced).
- Graceful stop (SIGINT/SIGTERM/uncaughtException) with bounded drain; `sanitize.ts` error-code-first messages (URLs/bearer/api keys stripped, 300-char cap).

### Orchestration runtime (`packages/mastra`) — B2, done
- `createSdlcWorkflow`: `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created`; persisted `repairAttemptsUsed`; typed bail outcomes; `defaultSdlcPlan` template.
- Policy-gated tool registry `wirePlatformTools` (deny-by-default snapshot policy, sensitive actions → APPROVAL_REQUIRED, crash-safe audit hook). 14 fake-runtime tests.

### Visual workflow compiler (`packages/workflow-schema`) — B3, done (wave-3 hardened)
- Finite node registry with strict per-type Zod configs; validation rejects missing/duplicate nodes, unreachable required steps, unsafe config, unauthorized tools, version-missing and unsupported cycles; deterministic Kahn/Tarjan compiler. Wave 3 added dotted-id rejection and unknown-input shape guards (157 tests).

### GitHub connector (`packages/integrations`) — B4, done
- REST pull-request creation over injectable fetch; approval gating bound to `sha256Hex(canonicalPullRequestPayload)`; failure mapping; redaction choke point; audit sink; MCP allowlist guard. 26 tests.
