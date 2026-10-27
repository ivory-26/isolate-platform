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
- File ownership: `packages/db/**`
- Coordinator handoff notes: migration transplanted (RENAME to `0001_platform_core.sql`); 6 repositories implemented; known defects: type self-imports in repository files + missing tests + no gates yet; also rewrite `client.ts` fresh (no legacy port).
- Status: in progress

## Sprint B — Runtime & Orchestration (`sprint/b-runtime`)

### B1 — Durable worker loop (`apps/worker`)
- Owner: agent session B1 · Worktree: `../worktrees-platform/sb1-worker` · Branch: `task/sb1-worker`
- File ownership: `apps/worker/src/**`
- Coordinator handoff notes: loop + heartbeat + sanitize + ~14 tests transplanted; known defects: 2 tsc typing errors in loop.ts; gates/commit outstanding.
- Status: in progress

### B2 — Mastra SDLC workflow (`packages/mastra`)
- Owner: agent session B2 · Worktree: `../worktrees-platform/sb2-mastra` · Branch: `task/sb2-mastra`
- File ownership: `packages/mastra/src/**`
- Coordinator handoff notes: d.ts verification + `agents/runtime.ts` done; workflow + tools registry + tests not started. Use the design ruling in brief §Task B2 (dountil machine).
- Status: in progress

### B3 — Workflow registry/validation/compiler (`packages/workflow-schema`)
- Owner: agent session B3 · Worktree: `../worktrees-platform/sb3-wf-schema` · Branch: `task/sb3-wf-schema`
- File ownership: `packages/workflow-schema/src/**`
- Coordinator handoff notes: types/nodes/graph/validate/compiler + test suite transplanted; known defect: phantom import `AGENT_TASK_CONFIG_PLACEHOLDER` in the test file; gates not yet run.
- Status: in progress

### B4 — GitHub connector (`packages/integrations`)
- Owner: agent session B4 · Worktree: `../worktrees-platform/sb4-integrations` · Branch: `task/sb4-integrations`
- File ownership: `packages/integrations/src/**`
- Coordinator handoff notes: implementation transplanted (REST client, redaction, audit sink, MCP guard); known defects: 3 tsc errors (imports in rest-client + 2 test-site casts); tests not yet run.
- Status: in progress

## Wave 2 — Integration & validation (coordinator)
- Merge all `task/*` branches → sprint lanes → `main`; full `bun run validate`; apply `0001_platform_core.sql` to Neon (with user approval); QA/DoD audit; docs + challenges; CI green on pushed commit.
- Status: planned

## Later (event scope decisions pending)
- Post-kickoff web app (fresh TanStack Start scaffold, NOT a port of the legacy app), sandbox execution plane, visual editor UI.
