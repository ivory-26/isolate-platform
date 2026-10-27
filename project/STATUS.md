# Status

Last updated: 2026-10-27 (event build, day 1 — wave 2 integrated)

## Repository
- This repo (`isolate-platform`) contains ONLY event-week work (started Oct 27, 2026), fresh git history. The pre-event spike/compatibility MVP lives in a separate repo and stays out of this history.
- CI: lint/typecheck/test + advisory gitleaks on every push/PR; build returns when the web app scaffold lands.

## Sprint state — ALL SIX TASKS COMPLETE, WAVE 2 MERGED
- Sprint A: A1 `@isolate/shared` done (60 tests); A2 `@isolate/db` done (`bcf71f6`+`0f96283`; 27 pass/1 skip offline, 28/28 live pre-migration; fresh client rewrite).
- Sprint B: B1 worker done (`45fe874`; 20 tests); B2 Mastra done (`4353dba`; 14 tests, dountil machine + policy-gated tools); B3 compiler done (`ec6afde`; 52 tests); B4 connector done (`9226219`; 26 tests).
- Integration: all `task/*` merged → `sprint/a-foundation` + `sprint/b-runtime` → `main` (`a453af8`), ownership segregation yielded ZERO merge conflicts. Full validate on main: biome clean, typecheck 6/6, **172 pass / 0 fail / 1 skip offline** (live db test skips without env; live worktree run WITH env: 28/28 pass, pre-migration probe).
- Deferred to wave 3 (reviewed, not applied — see `project/DECISIONS.md`): B1's `JobRow.lease`/`lastError` totality + `WorkerConfig.jobTimeoutMs` promotion; B3's db/shared schema proposals (compiled_plans, workflow events); B2's mandate to B3 compiler: forbid dotted node ids.

## Verified evidence summary
- `bun run check`: 61 files, 0 errors/warnings. `bun run typecheck`: 6/6 projects. `bun run test`: 172 pass / 0 fail / 1 skip across 15 files (all suites, offline).
- All task branches pushed to origin with their committing agent's tip verified via `git ls-remote`.

## Verified in the legacy workspace (pre-migration; informational)
- Coordinator seed gates at migration time: biome ✅, typecheck 6 projects ✅, bun test ✅ (shared 60 pass incl. transplants), workspace install reproducible.
