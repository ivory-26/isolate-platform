# Status

Last updated: 2026-10-30 (wave 8 merged and migrated; **live PR acceptance passed** — real Meta + Modal run created `ivory-26/agent-bank#1`)

## Current: wave 8 — Review close: validation gate, PR approval, rerun (merged, migrated, offline-complete)

Wave 8 turns `review_ready` into a reviewable outcome: the repository's configured validation command runs in the same sandbox before anything is pushed, a failure ends the task with a bounded report, opening a pull request is a **second** human approval bound to the exact commit, and a person can rerun failed work inside the same task boundary. **Scope decision (user): backend only — no web UI this wave.**

- **Merged on `main`** (`--no-ff`, zero conflicts): W8-DB `27e4ac5`, W8-VAL `88e5e5c`, W8-GH `3fa5e87`, W8-WRK `fee0bfe`, W8-CTL `73fddcb`. Contracts `c44f2bb`; decisions `849bb22`; coordinator integration `99c711c` (`@isolate/shared` dependency declared in `packages/sandbox`), `3e2455e` (`TaskRepository.recordPullRequest`), `39ffe2c` (acceptance coverage). Merge commits `a2c4e1e`, `546551a`, `d27f4e2`, `cfe1c2f`, `9f9d2c4`.
- **Migration `0006_review_surface.sql` applied to Neon `isolate-platform` / `br-steep-poetry-ar5iwdkb` (2026-10-30, user-approved)** via `scripts/apply-migration.ts` after a read-only precondition check showed none of the columns present; 20/20 tables verified. Verified via the Neon MCP: `repositories.validation_command text`, `validation_timeout_ms integer default 300000`, `tasks.pull_request_number|pull_request_url|retry_of|retry_depth default 0`, the four CHECK constraints, `tasks_retry_of_idx`, and `jobs_type_check` now accepting `create_pull_request`.
- **Validation gate**: `runValidationCommand` (`packages/sandbox`) tokenizes an operator-authored command **without a shell**, refuses metacharacters/unknown executables/out-of-range timeouts before any provider call, runs with egress deny, and returns the shared `ValidationReport` plus a bounded log. The handler runs it after the diff gate and before push, stores a `log_bundle` artifact and `validation.started/finished` with `stage: "command"`; a failure transitions `validating → failed`, writes no push, and is a non-retryable `VALIDATION_FAILED`. No configured command keeps the wave-7 meaning and records `skipped`.
- **PR stage**: after a successful push the worker reads HEAD, requests a second approval (`github.create_pull_request`) bound to `{repositoryFullName, headBranch, baseBranch, headSha}`, records the payload on `approval.requested`, and moves `review_ready → awaiting_approval`. A `create_pull_request` job verifies approved + SHA + target, verifies the remote head, creates at most one PR (idempotent), persists number/URL via `TaskRepository.recordPullRequest`, and moves `awaiting_approval → pull_request_created` with `pr.created`.
- **Rerun instead of repair**: a failed validation is never auto-repaired. `retryTask` (`apps/web` server-side, capability-gated before storage) creates a **new** task copying the failed task's boundary (repository, goal, acceptance criteria, file ownership, budget caps), links `retry_of`, increments `retry_depth` (bounded 3), records `task.retried` + `task.enqueued`, and enqueues exactly one `run_task`; replay is stable and enqueues nothing. `decideApproval` approves/rejects with the same capability gate, writes an audit row + `approval.decided`, and enqueues one `resume_task` (push) or `create_pull_request` (PR) — rejection fails the task and enqueues nothing.
- **No UI**: `apps/web` routes, components and styles are untouched; the client sweep is unchanged at 30 checks. The approval buttons, run-detail timeline and repository onboarding page are wave 9, together with the design system.
- **Gates on `main`**: biome **0 errors** (10 pre-existing warnings) · typecheck **8/8** · **1398 pass / 0 fail / 6 skip** offline, twice, identical · **1398 pass / 0 fail with live Neon** after `0006` · web production build green · client sweep **30 checks** · production smoke green (307 → `/login`) · `acceptance:offline` PASS with **7 scenarios** (success, throw, abort, validation-passed, validation-failed, pull-request, retry).

### Live PR acceptance — PASSED (2026-10-30, bounded sequential runs)

Task `2960432e-e63a-404d-bf34-cacae5d4fe3d`, branch `task/w8-live-24b80218`, PR **[ivory-26/agent-bank#1](https://github.com/ivory-26/agent-bank/pull/1)** (`open`, base `main`, one changed file `LIVE_PR_ACCEPTANCE.md`, head `b0d5700`), task status `pull_request_created`. The worker requested the push approval, paused, resumed after approval, cloned with a repo-scoped token, ran two Meta turns, produced a 379-byte diff artifact, requested the **second** approval bound to the pushed HEAD, and the `create_pull_request` job opened exactly one PR.

Measured: Meta calls **6380 prompt / 3528 completion** and **8735 / 2631** tokens (`cost_usd` null — no trusted price table); one Modal sandbox `0.125 CPU / 512 MiB`; sandbox destroyed; **0 sandboxes running** verified through `client.sandboxes.list()`. Validation recorded `skipped` because the target repo's vitest suite needs installed dependencies that a deny-egress sandbox cannot fetch.

Three defects were found and fixed by this run (not present in the offline evidence):
1. `createOfflineWorkerDeps` dropped `resolveSandboxEnv` and `createSandboxBackend` from the provider composition — real jobs cloned **without a credential** and ran the agent **tool-less**. Fixed with a regression test (`ade7d5f`).
2. A productive turn that ended with a summary instead of the empty sentinel was dead-lettered when the turn budget ran out, discarding a valid diff. The handler now accepts a produced in-bounds diff on **turn**-budget exhaustion only; token/cost/time caps still fail hard (`5abf9d8`).
3. The acceptance verifier minted its read token with `contents` only, so its own `GET /pulls` returned 403 while the PR itself was fine (`43a43f6`-class fix: request `pullRequests: "read"`).

Runs 1–3 of the same script failed earlier (missing git credential, then the per-turn cap, then the completion protocol); each was diagnosed from persisted rows and fixed before the next attempt, with no retries after a success.

### Wave 8 open items (need the user)

1. **Close the acceptance PR/branches** when the evidence is no longer needed: PR `#1`, branch `task/w8-live-24b80218`, and wave 7's `task/w7-live-da35089b`.
2. **Wave 9 = the product surface**: design system, run detail (`/runs/$taskId`), approvals page, repository onboarding, navigation — built on the server actions that now exist.
3. **Approval decision is not a distributed transaction**: `decide` (with its audit row) commits before the follow-up job is enqueued. A queue failure at that instant leaves an approved row with no job; replay returns `CONFLICT`. Documented in `CHALLENGES.md`; recovery today is an operator re-enqueue.
4. **Validation-image coverage**: `bun test` / `bun run <script>` are image-safe; `npm`/`pytest`/`cargo`/`go` are allowlisted but not preflighted in the sandbox image, so a missing binary surfaces as a failed report (exit 127) rather than a provisioning error.
5. **Evidence branch**: `task/w7-live-da35089b` on `ivory-26/agent-bank` remains from wave 7; delete it when it is no longer needed.

## Previous: wave 7 — Execution truth (merged, migrated, live pass complete)

Wave 7 closes the five gaps that stopped an agent from completing a coded change: seed data, repository clone, write tools, task-lifecycle writes, and a git+bun sandbox image. A task can now be planned, cloned, edited, committed, recorded and paused at a human approval gate before push.

- **Merged on `main`** (`--no-ff`, zero conflicts): W7-DB `e1db88f`, W7-SBX `00f8e5a`, W7-TOOLS `5dbe398`, W7-GH `cf44b78`, W7-WRK `4f8c74e`. Contracts were committed first at `7392fb9`/`7313446`/`d379c8b`/`478960e`/`f4235a1`.
- **Data plane**: migration `0005_execution_truth.sql` is **applied to Neon `isolate-platform`** (`br-steep-poetry-ar5iwdkb`) and verified: `artifacts.content text` + 256 KiB byte CHECK, `jobs_type_check` includes `resume_task`, all four new indexes present, zero duplicate pending approvals before apply. `RepositoryRepository`, `ArtifactRepository`, `PostgresExecutionLifecycle` + in-memory fake are merged.
- **Sandbox**: `TaskWorkspaceGit` (toolchain preflight, clean-URL shallow clone, branch, commit, bounded diff, non-force push); create-time `SandboxSpec.env` credential via `GIT_CONFIG_*`; Modal stdin for trusted file writes; default image `oven/bun:1`; clone/push egress allowlist; every other command stays deny.
- **Tools**: risk-table policy (`read_only`/`scoped_write` allowed, `sensitive` → `APPROVAL_REQUIRED`, `destructive` denied); `repo.write_file`, `git.commit_local`, `git.diff_summary`; bounded ownership globs; second-gate denials are audited as denials.
- **GitHub**: real `createGitHubAppTokenProvider` (RS256 App JWT via WebCrypto, repo-scoped installation token, cache until expiry−300 s, credential-free errors). Live: token mint, repo metadata, contents read, and a real clone/commit/push to `ivory-26/agent-bank` all passed.
- **Worker**: handler v2 records attempts/events, clones, runs bounded turns with ownership-bound write tools, validates a non-empty in-bounds diff, stores a bounded artifact, and pauses at `awaiting_approval` **before** any sandbox when push is enabled. `resume_task` verifies approval status + payload SHA; cancellation is checked before turns/push; teardown stays exactly once. Composition binds the DB lifecycle, workspace git, Modal provider, token broker and `GITHUB_PUSH_ENABLED` without logging credentials.
- **Seed**: `bun run seed` (`scripts/seed-workspace.ts`) creates the repository + workflow definition/version a Postgres submission needs; it refuses without `DATABASE_URL`, validates membership and compiles the graph before inserting. Seeded 2026-10-30 for `ivory-26/agent-bank` (main): org `15fc5715-0c26-4c80-bff3-863a47f8fff3`, user `278560b6-e7ac-4ceb-b960-a88741b2e4a5`, repository `4cc5b972-0edc-4f6b-bea4-741fde9fa17a`, workflow definition `114c905e-d2e9-42d1-8a59-8b633a22659e` version `1`.
- **GitHub live read check (2026-10-30, one token mint + read-only calls)**: App JWT → installation token succeeded; `GET /repos/ivory-26/agent-bank` returned 200 (`private`, default `main`); `GET /repos/.../contents/` returned 200; `GET /installation/repositories` returned exactly 1 repository. The App now reports `Contents: Read and write` / `Pull requests: Read and write` per the user.
- **Live GitHub push acceptance — PASSED (2026-10-30, one bounded run)**: task `38766867-f219-4ffb-8aaf-25c8d38a81b2`, branch `task/w7-live-da35089b`, commit `46913bea4a62485f74adae665c08058bacdf5646`, status **`review_ready`**. The approval was persisted and approved; the resume ran one deterministic turn (no LLM), wrote `LIVE_ACCEPTANCE.md` through the policy-gated tool, committed, validated a 5-line/280-byte diff, stored a diff artifact, and pushed the branch. GitHub returned **200** for both the branch and the file contents. 2 attempts, 6 run events, 1 artifact, 1 sandbox usage row (`cost_usd` null), sandbox destroyed, **0 running**. The four earlier failures were deterministic and are fixed: Modal allowlist/`blockNetwork`, omitted idle timeout, missing git in `oven/bun:1`, and commit ownership using a commit-to-commit diff that ignored untracked files. Push also re-allows the HTTPS protocol explicitly.
- **Key handling**: the PKCS#8 key is accepted as quoted multiline, literal `\n`, CRLF, single-line, or via `GITHUB_APP_PRIVATE_KEY_PATH`; the path form bypasses the dotenv multiline truncation. `*.pem` is gitignored.
- **Gates on `main`**: biome **0 errors** (10 pre-existing warnings) · typecheck **8/8** · **1217 pass / 0 fail / 5 skip** offline · **1208 pass / 0 fail with live Neon** at migration time (includes the `0005` lifecycle test) · web production build green · client sweep **30 checks** · production smoke green · `acceptance:offline` PASS (wave-6 lifecycle path; the wave-7 path is covered by worker tests).
- **Live acceptance (2026-10-30, one bounded sequential pass)**: Meta agent turn **6.1 s**, 60-char plan, **103 prompt / 429 completion tokens**; one Modal sandbox at **0.125 CPU / 512 MiB / 60 s** ran `echo isolate-ok` exit 0 and was destroyed; **0 running sandboxes** verified via `client.sandboxes.list()`; temporary usage org and rows cleaned (`0` leftovers). `cost_usd` is null because no trusted price table is configured.
- **Worktrees**: all five `task/w7-*` branches merged and pruned; `git worktree list` now shows only `main`.

### Wave 7 open items (need the user)

1. **Cleanup**: the acceptance pushed `task/w7-live-da35089b` to `ivory-26/agent-bank`; delete the branch when you no longer need the evidence. No PR was created.
2. **PR creation and approval UI are wave 8.** Wave 7 stops at `review_ready` after the push; the page that records approve/reject and PR creation remain wave 8.
3. **Validation gate is diff-based, not test-based.** `review_ready` means "an in-bounds change exists"; running the repo's formatter/lint/typecheck/tests as a gate is wave 8.

## Previous: wave 6 — Google sign-in, task intent persisted, real adapters bound

- **Google sign-in** is wired end to end through the first-party proxy. The server asks Neon Auth for a provider URL (`disableRedirect: true`) with a same-origin `/auth/callback`; the browser visits Google; Neon returns the session verifier and the challenge cookie; `/auth/callback` runs `processAuthMiddleware`, relays the exchange cookies and redirects. The provider URL is validated as public https, and the callback is built from the request origin, never from client input.
- **Neon config**: the shared `google` provider is enabled on `br-steep-poetry-ar5iwdkb`; `http://localhost:3000` is now a trusted domain. A production origin and (for production) own Google client credentials remain deployment steps.
- **Task intent is persisted**: migration `0004_task_context.sql` adds `tasks.goal`, `tasks.acceptance_criteria` and `tasks.file_ownership`; it is **applied to Neon `isolate-platform`** (columns and both array CHECKs verified via `information_schema`/`pg_constraint`). Submission collects them; `PostgresTaskContextRepository` serves the worker's `loadTaskContext` from one tenant-scoped task⋈repository read, failing closed on missing/terminal/foreign rows.
- **The wave-4 boundary is closed**: `CodingAgentRuntimeFactoryOptions` now receives the per-job `sandboxBackend` and trusted task ids; the worker builds a policy-gated `SandboxToolBackend` over the provisioned handle. The real worker composition binds the Postgres queue, usage sink and context loader, selects Modal only when opted in (app resolution stays lazy, no network at boot), and selects Baseten only when keyed. Every provider choice fails closed.
- **Data relations**: `public.users` ↔ `neon_auth.user` stay bridged by the same UUID (no cross-schema FK; `neon_auth` is Neon-owned). `memberships.user_id`, `tasks.created_by`, `tasks.repository_id` and `repositories.organization_id` keep real intra-platform FKs; identity mirroring runs on every session read, and `users.email UNIQUE` prevents two identities claiming one address.
- **Model split**: `INFERENCE_PROVIDER=meta` is the local/dev and pre-production path — Meta Model API `https://api.meta.ai/v1`, model `muse-spark-1.3-contributor` only. `INFERENCE_PROVIDER=baseten` is production — `meta-models/muse-spark-open-1026` only. No other model or provider exists. A bounded Meta agent turn was verified: one plan, 103 prompt / 367 completion tokens, 4.5 s, usage recorded and cleaned up.
- **Reasoning-model guard**: an empty agent turn at the output-token cap is now `BUDGET_EXCEEDED`, not completion (Muse Spark 1.3 spends the budget on reasoning first).
- **Keyed acceptance (2026-10-29, one bounded run)**: `GET /v1/models` listed 20 models with the target present → one completion `HTTP 200`, prompt 148 / completion 16 tokens, no tools, `max_tokens=16` → one Modal sandbox (`0.125 CPU / 512 MiB / 60 s`) `echo isolate-ok` exit 0 → terminated and confirmed destroyed. Both usage rows were written to a temporary organization, read back, printed and cleaned up. `cost_usd` is null because no trusted price table is configured; no cost was guessed.
- Gates on `task/w6-finish`: biome **0 errors** (10 pre-existing warnings) · typecheck **8/8** · **946 pass / 0 fail / 4 skip** offline (×2) and **950 pass / 0 fail** with live Neon · web production build green · client sweep **30 checks** · production smoke green · `acceptance:offline` PASS (run with `--no-env-file`; it correctly refuses when keyed env is present).

### Wave 6 open items (need the user)

1. **Live Google consent** must be exercised once by the user (the app only verified initiation/exchange logic offline). The shared provider needs no local Google credentials; production needs own credentials and the deployment origin in the trusted-domain list.
2. **Push is not performed** (project protocol). `main` is local at `8cd5260`; CI greenness on the remote is unverified until the user pushes.

## Previous: wave 5 complete — Neon Managed Better Auth wired in, tenant isolation enforced

- **Identity**: Neon Managed Better Auth (`@neondatabase/auth@0.7.0-beta`) is the web app's identity provider. The browser never talks to the auth host: a server-only route proxies `/api/auth/*` and rewrites the `__Secure-neon-auth.*` cookies onto our origin, so the SDK and the cookie secret stay server-side and no third-party cookie is involved.
- **The id is the tenancy bridge**: Neon Auth issues `uuid` user ids and `public.users.id` is a `uuid`, so the authenticated id *is* the platform user id. `memberships.user_id`, `tasks.created_by` and `workflow_versions.created_by` keep pointing at the session's owner — no second mapping table.
- **Tenancy stays in `public.organizations` + `public.memberships`** (Neon's Better Auth organization plugin is not used for tenancy — it cannot express the platform's `viewer` role).
- **Nobody sees everything**: identity is server-derived only — headers, cookies, query params and form fields are never identity inputs. The **membership role** is the sole authorization input; capabilities (`task:read`, `task:submit`, `organization:read`, `member:manage`) are checked **before** any storage access, and `viewer` may read but never submit. Membership is re-checked **inside the submit transaction** (the compile gate was `async () => true` before — now mandatory).
- **Fails closed**: a deployment with a database but no usable auth host reports `unavailable`; `/`, `/runs` and `/organizations` answer **307 → `/login`** and the local demo fallback requires `NODE_ENV=development|test` + `WEB_LOCAL_DEMO=true` + **no** `DATABASE_URL`.
- **New pages/components**: `/login`, `/signup`, `/organizations`, `/organizations/new`; `SessionProvider`, `UserMenu`, `OrganizationSwitcher`, `RoleBadge`, `AuthForm`.
- Migration `0003_auth_identity.sql` (`memberships_user_id_idx`) **applied to Neon `isolate-platform`** and verified via `pg_indexes`. The Neon-owned `neon_auth` schema is never written by this repo.
- Gates on `task/w5-auth`: biome **0 errors** repo-wide (10 pre-existing `noNonNullAssertion` warnings in `packages/db` test files) · typecheck **8/8 projects** · **903 pass / 0 fail / 4 skip across 53 files**, twice, identical · web production build green · client secret sweep green (26 checks over 17 client files) · production smoke green (307 → `/login` for the three tenant routes, 200 + `no-store` for `/login`).

### Wave 5 open items (status after wave 6)

1. **Deployment origin** — `http://localhost:3000` is now registered as a trusted domain; the production origin is still a deployment step.
2. **Social login** — resolved in wave 6: the shared `google` provider issues an authorize URL and the app completes the proxied callback exchange. Live consent must be exercised once by the user.
3. **~~Reconcile the shared root `bun.lock`.~~ Done** — `main` was merged into `task/w5-auth` (`b4366b1`), so the lockfile now carries wave 4's Modal/Mastra entries **and** wave 5's `@neondatabase/auth`. `bun install --frozen-lockfile` exits 0. `main` is an ancestor of `task/w5-auth`, so the coordinator can fast-forward with **zero conflicts**.
4. **Cross-lane repair applied.** Wave 5 made `CallerScope.role` and `createSubmissionCompiler`'s `authorizeMembership` required; W4-OPS's `scripts/acceptance-offline.ts` (which CI runs) did not supply them and failed at runtime. Fixed in `b4366b1`; `bun run acceptance:offline` passes.

## Previous: wave 4 complete offline — Phase D/E (keys) not started

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


## Previous: wave 3 complete — merged, migrated, validated

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

## Wave 4 history (planning record)

Wave 4 was planned as a provider plane with $100 Baseten and $100 Modal credits, keys last. All lanes were implemented and merged offline; Phase D (user adds keys) and Phase E (one bounded completion + one sandbox) remain unauthorized and unstarted. Deferred to wave 5: visual editor + approval queue UI, GitHub App token broker, Mastra `Workspace`/LSP evaluation, deploy pipeline — plus **W5-AUTH** (authentication & tenant access, delivered on `task/w5-auth`, see above). W4-H (pin Zed's Mastra docs MCP to 1.3.9) remains opportunistic.

## Repository
- This repo (`isolate-platform`) contains ONLY event-week work (started Oct 27, 2026), fresh git history. The pre-event spike/compatibility MVP lives in a separate private repo and stays out of this history.
- CI on `main`: lint + typecheck + tests + web build + client secret sweep + advisory gitleaks. The wave-3/4 merges and the wave-5 branch are **not yet pushed**; CI greenness on the remote is unverified until push.
- Project agent assets: `.agents/skills/{mastra,mastra-factory}` (v2.4.0 / v1.0.0, `mastra-ai/skills`), `.zed/settings.json` (mastra MCP), `skills-lock.json`. `.claude/` is machine-local symlinks and gitignored.

## Data plane
- Neon project `isolate-platform` (`divine-butterfly-60669535`, Pg 17, aws-us-west-2) is the system of record.
- Migrations `0001_platform_core.sql` + `0002_workflow_compilation.sql` + `0003_auth_identity.sql` applied; 20 tables verified. Runner verifies the full table set and never prints environment values.
- **Authentication**: Neon Managed Better Auth is enabled on branch `br-steep-poetry-ar5iwdkb` (`auth_provider = "better_auth"`, `owned_by = "neon"`). The Neon-owned `neon_auth` schema (9 tables) holds credentials/sessions and is never written by this repo; `public.users` / `public.memberships` / `public.organizations` remain the tenancy source of truth.
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
