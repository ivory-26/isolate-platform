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

## 2026-10-27 — Wave 2 integration: cross-package contract proposals reviewed and DEFERRED
- Decision: proposals from B1 (`JobRow.lease`/`lastError` totality, `WorkerConfig.jobTimeoutMs` promotion) and B3 (compiled_plans + workflow-definition version tables, workflow event schemas in shared) are recorded but NOT applied in wave 2. Wave-3 work items, owner-assigned at that point.
- Rationale: wave-2 gates are green without them (all consumers already use `== null` guards / test-seam overrides, so the changes are ergonomics, not correctness); applying cross-package edits mid-merge would violate the ownership-freeze discipline that delivered zero merge conflicts.

## 2026-10-27 — Bounded SDLC mapping on installed Mastra d.ts (from B2 verification, ratified)
- Decision: the SDLC machine runs as `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created`; the loop body runs validation then at most one repair turn while budget allows, with `repairAttemptsUsed` persisted in workflow state.
- Rationale: installed @mastra/core loop primitives accept single-step bodies; multi-step loops/impose if/else are not expressible — template stays serializable (`defaultSdlcPlan`), runtime uses the dountil shape.
- Alternatives rejected: linear ladder (mirrors repairing unconditionally), custom orchestration framework (against ARCHITECTURE.md §12).

## 2026-10-27 — CI: GitHub Actions gates + advisory gitleaks
- Decision: frozen-lockfile install → biome → typecheck-all → test on every push/PR; gitleaks advisory until scan noise is reviewed.
- Rationale: automated secret scanning was demanded by the legacy repo's leaked-token history (documented in its private repo); advisory prevents blocking on unknown patterns until triaged.
