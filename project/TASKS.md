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

## Wave 4 — next queue (handover)
- **W4-A — auth/tenancy:** concrete `AuthoredWorkflowVersionReader`, real session → `CallerScope`, membership/permission enforcement, API-boundary tenant-isolation tests. Owner: TBD.
- **W4-B — jsonb write normalization:** migrate 0001 repositories from `JSON.stringify(...)` → `::jsonb` binds to object or `::text::jsonb`; add live `jsonb_typeof` assertions; re-enable/verify SQL-side `budget_limits->>` scans. Owner: TBD.
- **W4-C — compilation in the task pipeline:** compile at submit → persist pinned plan → worker consumes pinned plan; surface rejection issues in UI. Owner: TBD.
- **W4-D — Mastra storage + worker integration:** verify Neon/Postgres storage adapter vs `@mastra/core@1.79.0` d.ts; wire `createSdlcWorkflow` (suspension/approval resume) into worker. Owner: TBD.
- **W4-E — sandbox execution plane:** hosted `SandboxProvider` + command/egress policy enforcement in worker; NullProvider stays default in dev/CI. Owner: TBD.
- **W4-F — approvals + visual editor:** React Flow editor over the node registry; approval queue route with payload-SHA + expiry binding. Owner: TBD.
- **W4-G — CI/ops:** optional live-DB CI job, gitleaks triage → blocking, deploy pipeline, push + verify CI for the wave-3 merge.
- **W4-H — tooling:** pin Zed's `mastra` MCP to `@mastra/mcp-docs-server@1.3.9` (1.3.10 crashes on Windows); declined during wave 3, still open.

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

