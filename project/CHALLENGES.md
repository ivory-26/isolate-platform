# Challenges and lessons

Symptom / root cause / correction / prevention format for meaningful failures (event build).

## 2026-10-27 — CI: timing-window upper bounds fail on slow runners (worker heartbeat spam test)
- Symptom: local suite 20/20 green, but CI failed `(fail) per-job heartbeat ticker keeps leases alive without spamming — Expected: <= 12` on the sprint-merge commit; pass/fail depended on machine speed.
- Root cause: the test asserted an absolute beat cap (12) inside a fixed 200ms wall-clock window; on a slower shared runner more 15ms scheduling windows elapse before the observer wakes, so the beat count legitimately exceeds a locally-calibrated constant. (The agent's own lesson — "tolerant bounds instead of exact counts" — had been applied to the lower bound only.)
- Correction: bound scaled to actually-elapsed time at interval granularity (`ceil(elapsedMs / intervalMs) + 3`), which preserves the anti-spam property (≤1 beat per configured interval) while being runner-independent; worker suite re-run ×3 green, biome + tsc clean.
- Prevention: any assertion over C/f clock-dependent counts must scale with measured elapsed time (or use injected/fake clocks) — never a locally-calibrated constant. Added to the wave-2 integration checklist for future review of all timing tests.

## 2026-10-27 — B2: Mastra parses dotted step ids as nested paths during resume
- Symptom: `run.resume({step: "sdlc.review_ready"})` threw `This workflow step "sdlc" was not suspended. Available suspended steps: [sdlc.review_ready]`.
- Root cause: `Run._resume` does `stepParam.split(".")`, assuming step ids never contain dots; the first segment is validated against top-level `suspendedPaths`.
- Correction: renamed all SDLC step ids to dash-form (`sdlc-planning`, `sdlc-gate`, …) and resume via `suspendOptions.resumeLabel` → `run.resume({label, resumeData})`; suspension→resume tests fail if a dotted id returns.
- Prevention: forbid `.` in node/step ids — flagged to B3's compiler as a validation rule (`INVALID_TYPE` on dotted ids); verify id grammar against the consumer's own primitives, not just the compiler.

## 2026-10-27 — B2: in-memory `run.resume` requires a storage-backed snapshot
- Symptom: after `run.start` returned `status: "suspended"`, `run.resume(...)` threw `No snapshot found for this workflow run` when no `Mastra`/storage was attached.
- Root cause: `_resume` always resolves the suspended snapshot through `mastra.getStorage()`; suspend works without storage, resume does not.
- Correction: `createSdlcWorkflow(deps, { mastra })` now requires the durable state plane (Neon-backed store in production, `InMemoryStore` in tests); worker contract noted.
- Prevention: verify both halves of a suspend/resume pair independently — mid-workflow API asymmetries don't surface until the second half runs.

## 2026-10-27 — B2: `InferPublicSchema` requires structural zod schemas
- Symptom: hand-rolled "schema-like" objects fail `@mastra/schema-compat`'s public-schema boundary; zod v3/v4 pass (shallow structural check on `_output`/`_input`/`_zod`).
- Root cause: Mastra's schema compatibility layer defines schemas structurally, not nominally.
- Correction: typed per-tool zod schemas instead of a generic `Record<string, unknown>` tool input.
- Prevention: when a framework claims generic schema support, check its compatibility layer's structural requirements before adopting non-zod schema shapes.

## 2026-10-27 — B1: frozen in-memory clock made every new job unclaimable
- Symptom: after repo migration, claim-dependent worker tests hung in `eventually` for 2s and failed 5/20; same tests passed pre-pause.
- Root cause: test fake captured `now = Date.now()` once at construction while `makeJob()` stamped `notBefore` 1–2 ms later; on the frozen clock `notBefore <= now` is false forever — pass/fail depended purely on where the scheduler's ~15.6 ms tick boundary fell vs the capture order.
- Correction: fake `now` became a getter following real time until a test assigns it (assignment then freezes it deterministically); verified via a standalone probe run before touching source.
- Prevention: an in-memory fake must use ONE clock for every gate it enforces; never take two `Date.now()` calls across construction and use.

## 2026-10-27 — B1: fake heartbeat didn't simulate lease loss, so "stale ack rejected" was untestable
- Symptom: `heartbeat false aborts the handler signal and ack is rejected` timed out asserting `status === "claimed"` even though the heartbeat returned false as configured.
- Root cause: the fake's "lost" beat returned false but left the lease row intact; the subsequent `ackComplete` found the job still owned and accepted it — simulation contradicted the contract (`heartbeat === false` ⇒ lease gone; ack thereafter = LEASE_LOST).
- Correction: on a "lost" beat the fake now clears `job.lease` before returning false; ticker fixtures hold live leases and wire `leaseLost` to abort the signal, mirroring production wiring.
- Prevention: fakes must implement the state CHANGE the real backend performs, not merely the return value; assert the downstream contract consequence, not just the flag.

## 2026-10-27 — B1: ticker self-stop made "no beats yet" indistinguishable from "timer broken"
- Symptom: heartbeat ticker tests counted exactly 1 beat and terminated; first hypothesis blamed `timer.unref()` (disproven by probe: 15/16 ticks fired).
- Root cause: the ticker intentionally self-stops on its first false beat (lease-lost contract); tests exercising an unowned job deterministically produced a single beat — a valid feature colliding with an invalid fixture.
- Correction: fixtures now hold a live lease for the ticker's owner; spam test uses tolerant bounds (≥2 beats in 200 ms) instead of exact counts.
- Prevention: when a component terminates on an invariant, fixtures must satisfy the invariant's preconditions; run a cheap probe script before blaming timing APIs.

## 2026-10-27 — A2: circular self-imports made the package unbuildable and hid unexportable contract types
- Symptom: tsc TS2305/TS2459/TS2303 ×11 across 5 repository modules; `JobRow`/`QueueRepository` unexportable for `apps/worker`.
- Root cause: transplanted files imported their own contract interfaces from themselves; the interfaces existed nowhere in the module graph — snapshot was committed without a green tsc.
- Correction: declared and exported every contract interface + `JobType`/`JobStatus`/`JobRow` in the module that implements it; re-verified `apps/worker` typechecks as a consumer.
- Prevention: typecheck before committing any transplant; forbid `import ... from "./<this-file>"` in review checklist.

## 2026-10-27 — A2: camelCase budget jsonb keys vs snake_case row contract (hidden by `as` casts in the driver)
- Symptom: tsc TS2739 in the new in-memory fake; the Postgres driver had masked it with two `as` casts.
- Root cause: `create()` persisted camelCase keys into `budget_limits` jsonb while the row contract and the `budget_limits->>'max_duration_ms'` over-budget scan expect snake_case — every persisted task stored jsonb the row type would never read.
- Correction: serialize snake_case keys at the insert boundary (TS input stays camelCase); same mapping in the fake; regression asserted in fakes test + live test post-migration.
- Prevention: cast-based row mapping silently hides drift — prefer shape-checked mapping helpers; the fake run-through caught it because the fake uses the real type without casts.

## 2026-10-27 — A2: 3 test-authoring misses vs helper semantics (helpers were correct)
- Symptom: 3/28 first-suite failures.
- Root cause: (a) edge-count split on `),(` instead of `), (`; (b) assumed dead-letter at `maxAttempts=0` while the clamp `max(1, ...)` requeues; (c) checked legality after mutating status, firing the CONFLICT branch (checked before INVALID_TRANSITION by design).
- Correction: fixed the tests to the documented semantics; no production changes.
- Prevention: derive expected values from the shared contract (`TASK_STATE_TRANSITIONS`) computed in-test rather than hand-enumeration.

## 2026-10-27 — A2: stale paths + timeouts after worktree relocation
- Symptom: live test skipped despite valid `DATABASE_URL`; Neon connect+TLS exceeded Bun's 5s test timeout; pre-migration live probe failed with `42P01`.
- Root cause: borrowed env-file path `../isolate/.env` was relative to the OLD worktree layout (correct: `../../isolate/.env`); default timeout too short; migration not yet applied.
- Correction: corrected path (never read/printed); explicit 120s timeout; live test probes `to_regclass('public.organizations')` and exits cleanly pre-migration.
- Prevention: after any worktree relocation, re-derive all relative paths in briefs and record corrected ones in the report.

## 2026-10-27 — B4: transplanted redaction implementation vs test contract drift
- Symptom: `bun test packages/integrations` failed 2 redaction tests despite the stop report claiming only 3 tsc errors.
- Root cause: transplanted `redact.ts` and `redact.test.ts` were mutually out of date revisions (impl ate keyword markers; tests expected them preserved in `"Bearer [auth-redacted]"`; homogeneous filler runs swallowed wholesale vs capped).
- Correction: rebuilt the rule set to the test contract: keyword-kept replacement with `\s+` guard so `[token-redacted]` markers never re-match; mixed-case requirement on long runs so pure filler caps instead of vanishes; 5000-char cap preserved. Regression locked by the 6-case redact suite.
- Prevention: run the FULL gate sequence (not tsc alone) immediately after any transplant — test/impl drift invisible to tsc is exactly what the test gate catches.

## 2026-10-27 — B4: REST-path tests predated the deny-default approval gate
- Symptom: 14/20 rest-client tests returned `APPROVAL_REQUIRED` while asserting network-path outcomes (success paths without approval payloads).
- Root cause: deny-default sensitivity (`isSensitive` omitted ⇒ everything sensitive) landed mid-sprint; the test file was internally inconsistent (same call both needed and didn't need approval depending on the test).
- Correction: re-aligned tests to the security contract: approval-carrying helper computes `approvalPayloadSha256` via exported `sha256Hex(canonicalPullRequestPayload(spec))`; pure REST-path tests declare a trusted `isSensitive: () => false`; deny-default covered by dedicated tests asserting zero network calls.
- Prevention: when a security default changes mid-sprint, re-run the whole affected suite before parking; treat tsc-only stop reports as unverifiable.

## 2026-10-27 — B4: repo migration normalized "already-fixed" assumptions
- Symptom: resume checklist expected exactly 3 tsc errors, found 2; full test gate reclassified the task from "compile-fix" to "test-contract reconciliation".
- Root cause: cross-repo transplant normalizes state; EOL-only "modified" diffs mask real revision drift.
- Correction: verified per-file (not aggregate) test counts, committed the transplanted state + fixes as one feat commit on the migrated branch.
- Prevention: after workspace migration, treat stop reports as hypotheses — re-run biome → tsc → test from scratch before classifying work; record per-file counts.

## 2026-10-27 — B3: worktree transplant silently dropped a package's test suite
- Symptom: `packages/workflow-schema/src/workflow-schema.test.ts` absent on disk post-transplant although the handoff notes referenced a defect *inside* that file (impossible for a nonexistent file).
- Root cause: transplant copied only implementation files present at `git checkout <ref> -- <path>` time; the untracked-at-snapshot test file was lost; handoff notes were written against the old worktree state without re-verification.
- Correction: suite recreated from the shipped sources (52 tests covering every `WorkflowIssue` code, determinism, version pinning); aliases `AgentTaskConfig`/`ValidateLoopConfig` added to `types.ts` so the intended import contract resolves.
- Prevention: after any transplant, diff the file inventory against the source worktree before trusting notes; grep for `PLACEHOLDER`/`FIXME` tokens in the resume gate; treat handoff claims as unverified until `bun test <pkg>` returns a count.

## 2026-10-27 — B3: transplanted code failed strict tsc on first gate run (3 latent errors)
- Symptom: `TS2322` in `compiler.ts` (cycle-walk cursor `number | undefined`), `TS2399`-class `TS2339` ×2 in `validate.ts` (`config.tool` on the per-node config union).
- Root cause: implementation committed to disk before ever running the type gate in this repo's tsconfig strictness (`noUncheckedIndexedAccess`, narrow on per-node unions).
- Correction: `"tool" in config` narrowing; explicit `number | undefined` cursor; indexed loop replacing `forEach`-with-return (also satisfying Biome `useIterableCallbackReturn` / `noNonNullAssertion`).
- Prevention: biome+tsc immediately after each module write, with the exact gate output recorded in the task note at creation time; never cite a sibling repo's looser tsconfig as gate evidence.

## 2026-10-27 — A1: post-migration CRLF checkout broke the Biome format gate on unchanged files
- Symptom: after repo migration, `bunx biome check packages/shared` failed with 19 formatter-only errors; every diff was CRLF(␍) → LF on files whose content had not changed.
- Root cause: Windows Git `core.autocrlf=true` converts LF blobs to CRLF on checkout; Biome's default lineEnding wants LF. Seed blobs are correct LF.
- Correction: `bunx biome check --write <owned dir>` normalizes on disk; `git status` then shows identical blobs ("nothing to commit"). Permanent fix: root `.gitattributes` added (`* text=auto eol=lf`) by the coordinator.
- Prevention: pin `eol=lf` in `.gitattributes` before onboarding any Windows-based agent clones; agents hitting the same failure should run the scoped `--write` first and diff to confirm no real formatting issues hide beneath.

## 2026-10-27 — B1: `JobRow.lease` optional+nullable narrowing friction
- Symptom: tsc TS18048 "lease possibly undefined" despite `!== null` checks.
- Root cause: contract declared optional `lease?: {...} | null` so null-check is not a total guard.
- Correction: `== null` guards in consumer code; contract proposal queued: prefer total `lease: {...} | null`.
- Prevention: type-review optional fields against every consumer guard at contract time.

## 2026-10-27 — A2: targeted edit corrupted an SQL statement map
- Symptom: object-literal statement map merged a later key into a broken template literal.
- Root cause: edit pair omitted a trailing structural key present in oldString.
- Correction: repaired in place; renumbered prepared-statement parameters.
- Prevention: re-read affected regions after multi-line edits inside literals; never let oldString/newString differ on anchoring keys.

## 2026-10-27 — A2: contract self-import inside its own implementation file
- Symptom: redundant `import type { XRepository } from "./x-repository"` in the interface's own module.
- Root cause: mechanical carry-over when implementation was written into existing contract files.
- Correction: pending removal in all repository files (resume task).
- Prevention: implementing a contract declared in the same module requires no import; only cross-package contracts need imports.

## 2026-10-27 — B3: pause landed mid-write leaving a phantom import
- Symptom: test file imported a nonexistent `AGENT_TASK_CONFIG_PLACEHOLDER`.
- Root cause: editorial placeholder survived an interrupt.
- Correction: delete on resume; commit at every module boundary going forward.
- Prevention: commit (or at least typecheck) at module boundaries so pauses can't leave broken imports.

## 2026-10-27 — B4: connector failure union predated mandated error mappings
- Symptom: 404/429 mappings required codes missing from the PR-creator union.
- Root cause: contract written before the task's decision; sibling consumers keyed on the stale union.
- Correction: extended union in owned file + optional sanitized message; flagged for downstream switch updates.
- Prevention: when a task mandates new mappings, diff the failing contract and broadcast type changes before siblings code against it.

## 2026-10-27 — B4: no typed `fetch.mock` in bun-types
- Symptom: brief assumed an untyped Bun API; typed test code failed.
- Root cause: runtime API exists conceptually but no surfaced type declaration.
- Correction: injected `fetchImpl?: typeof fetch` dependency, stubbed via `mock()` from `bun:test`.
- Prevention: verify named APIs against installed type declarations before building test strategy on them.

## 2026-10-27 — B3: first compiler draft improvised scaffolding inside a half-written file
- Symptom: non-compiling placeholder helpers in the SCC-ordering path.
- Root cause: inline improvisation before threading the required inputs through signatures.
- Correction: full rewrite with explicit indexed-edges parameters and deduped edge sets (parallel-edge bug fixed same pass).
- Prevention: thread new parameters through signatures first, then implement.

## 2026-10-27 — Swarm ops: subagent session identity is not task identity
- Symptom: pause-time stop-state reports lacked session↔task linkage; fresh diagnostic sessions reported clean state while real work sat uncommitted in worktrees.
- Root cause: task assignment lives only in orchestration context, not on disk.
- Correction: reports keyed by worktree path/branch via `git worktree list`; agents write task id + touch-set into `project/TASKS.md` at claim time.
- Prevention: persist task manifest at spawn (worktree, branch, ownership list) and require a claim-time record before edits.
