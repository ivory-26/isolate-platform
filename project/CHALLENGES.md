# Challenges and lessons

Symptom / root cause / correction / prevention format for meaningful failures (event build).

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
