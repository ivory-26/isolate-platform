# Status

Last updated: 2026-10-29 (wave 4 provider plane merged and offline-green; no provider keys added)

## Current: wave 4 complete offline — Phase D/E (keys) not started

- All wave-4 lanes merged into `main` with `--no-ff`: W4-0 `10dc869`, W4-INF `15b04ef`, W4-DB `75b668a`, W4-SBX `a13d990` (+ lockfile `186e706`), W4-WRK `b25112e` (+ lockfile `aa60171`), W4-WEB `4e0a914`, W4-OPS (this integration commit).
- **Zero provider credentials were used or requested.** Modal/Baseten credits remain untouched; Phase D (keys) and Phase E (one bounded live pass) await explicit user authorization.
- Gates on `main`: biome 0 errors (10 pre-existing warnings) · typecheck **8/8 projects** · **869 pass / 0 fail across 51 files** with live Neon enabled (two identical runs) · web production build green · client secret sweep green (**26 checks**, includes `BASETEN_`, `MODAL_`, `inference.baseten.co`, `modal.com`).
- **Key-less acceptance** (`bun run acceptance:offline`): PASS on submit → idempotent replay (one job) → worker claim → policy-gated tools (allowlisted read executes, `git.push_branch` denied before the backend) → one model usage row + one sandbox teardown row → `destroy` exactly once on success / throw / abort → complete / dead_letter / retry(LEASE_LOST) acks. Refuses to run if any `BASETEN_*`/`MODAL_*` variable is set; imports no provider SDK.
- **Integration boundary (wave 5):** real adapters are implemented and tested but the worker composition stays injection-only. `loadTaskContext` has no DB source (tasks/compiled plans do not carry goal/acceptance/file ownership), and `CodingAgentRuntimeFactoryOptions` does not receive the provisioned sandbox handle, so `SandboxToolBackend` cannot be bound per job. Also, `createModalSandboxClient` resolves the Modal app at construction (network), so it must be built at Phase E with keys, never at offline boot. Details in `CHALLENGES.md` and `DECISIONS.md`.

## Wave 4 deliverables (verified)

- **W4-INF** — `basetenModelConfig` (fail-closed, https/no-credentials URL checks, no key echo), `defineCodingAgent` `tools`/`maxSteps`, `createMastraAgentRuntime` usage mapping (`totalUsage` → `AgentUsage`), cumulative token caps → `BUDGET_EXCEEDED`, tool-name-only recording, five read-only sandbox tools behind `wireSandboxTools` (strict Zod, denied tools never reach the backend), `git.read` in the deny-by-default policy. 42 tests.
- **W4-DB** — all jsonb writes bind `$n::text::jsonb`; live `jsonb_typeof` regression suite plus `budget_limits->>` scans; `UsageRepository` with exact micro-dollar aggregation (`numeric(12,6)` strings, no float sums), in-memory fake on the same helpers, live Neon coverage. 158 tests (live included).
- **W4-SBX** — `ModalSandboxProvider` behind `SandboxProvider` with an injected client, pre-create limit validation, egress deny → `blockNetwork: true`, combined UTF-8 output cap, abort → `CANCELLED`, idempotent destroy; server-only SDK factory with dynamic import. 184 tests, offline.
- **W4-WRK** — bounded caps (per-turn/per-task tokens, sandbox seconds, USD, steps); `createTaskExecutionHandler` with exactly-once teardown on success/throw/abort, per-call usage rows, sandbox usage row after destroy, bounded verdict mapping; offline composition; 84 tests.
- **W4-WEB** — `resolveCallerScope` (session + membership seams, UUID validation, tenant isolation), compile-at-submit with `WORKFLOW_REJECTED` issue surfacing, production DB deployments fail closed until a real session adapter exists; 158 tests + build + sweep.
- **W4-OPS** — `scripts/acceptance-offline.ts`, client sweep patterns, full offline gates ×2, docs.

## Wave 4 handover (superseded by the record above)

Grants: $100 Baseten credits (Muse Spark Open only) and $100 Modal credits. Mastra core stays `@mastra/core@1.79.0`; inference uses the existing OpenAI-compatible model object and sandboxing uses the existing `SandboxProvider` contract. **Keys are the last step:** every lane is implemented, tested and merged with `INFERENCE_PROVIDER=none` / `SANDBOX_PROVIDER=null`; user-supplied credentials arrive only in Phase D, after offline acceptance. Policy: [AGENTS.md](AGENTS.md#provider-credits-baseten--modal-strict). Full task specs and phase order live in [TASKS.md](TASKS.md#wave-4--provider-plane-baseten-inference--modal-sandboxes-planned-2026-10-29).


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

## Wave 4 history (planning record)

Wave 4 was planned as a provider plane with $100 Baseten and $100 Modal credits, keys last. All lanes were implemented and merged offline; Phase D (user adds keys) and Phase E (one bounded completion + one sandbox) remain unauthorized and unstarted. Deferred to wave 5: visual editor + approval queue UI, GitHub App token broker, Mastra `Workspace`/LSP evaluation, deploy pipeline. W4-H (pin Zed's Mastra docs MCP to 1.3.9) remains opportunistic.

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
