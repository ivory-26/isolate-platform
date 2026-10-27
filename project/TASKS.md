# Tasks

Owner / file ownership / dependencies / acceptance criteria / DoD per task. Statuses: planned / in progress / blocked / done.

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
- File ownership: `packages/mastra/src/**`
- Coordinator handoff notes: d.ts verification + `agents/runtime.ts` done; workflow + tools registry + tests not started. Use the design ruling in brief §Task B2 (dountil machine).
- Status: in progress

### B3 — Workflow registry/validation/compiler (`packages/workflow-schema`)
- Owner: agent session B3 · Worktree: `../worktrees-platform/sb3-wf-schema` · Branch: `task/sb3-wf-schema`
- Coordinator verification: commit `ec6afde` — test suite RECREATED (transplant had silently dropped it; see CHALLENGES), biome 0 issues, tsc clean, **52 pass / 0 fail**. Supported-subset + rejection-shape reports and editor-facing integration checklist delivered.
- Status: **done**

### B4 — GitHub connector (`packages/integrations`)
- Owner: agent session B4 · Worktree: `../worktrees-platform/sb4-integrations` · Branch: `task/sb4-integrations`
- Coordinator verification: commit `9226219` — biome 0 issues, tsc clean, **26 pass / 0 fail** (redact 6 + rest-client 20). Deny-default approval gating redaction-proof + audit sink covered; contract note: failure union extended with NOT_FOUND/RATE_LIMITED (optional sanitized message), consumers switch on `code`.
- Status: **done**

## Wave 2 — Integration & validation (coordinator)
- Merge all `task/*` branches → sprint lanes → `main`; full `bun run validate`; apply `0001_platform_core.sql` to Neon (with user approval); QA/DoD audit; docs + challenges; CI green on pushed commit.
- Status: planned

## Later (event scope decisions pending)
- Post-kickoff web app (fresh TanStack Start scaffold, NOT a port of the legacy app), sandbox execution plane, visual editor UI.
