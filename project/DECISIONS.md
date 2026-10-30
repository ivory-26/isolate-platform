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

## 2026-10-27 - Wave 2 integration: cross-package contract proposals reviewed and DEFERRED
- Decision: proposals from B1 (`JobRow.lease`/`lastError` totality, `WorkerConfig.jobTimeoutMs` promotion) and B3 (compiled_plans + workflow-definition version tables, workflow event schemas in shared) are recorded but NOT applied in wave 2. Wave-3 work items, owner-assigned at that point.
- Rationale: wave-2 gates are green without them (all consumers already use `== null` guards / test-seam overrides, so the changes are ergonomics, not correctness); applying cross-package edits mid-merge would violate the ownership-freeze discipline that delivered zero merge conflicts.
- Wave-3 resolution (coordinator pre-commit): B1 totality proposal verified ALREADY SATISFIED — `JobRow.lease`/`lastError` are declared total nullable (`field | null`, no `?`) in `packages/db/src/repositories/queue-repository.ts`, fakes/drivers conform, consumers use `== null` guards; no code change required. `WorkerConfig.jobTimeoutMs` promoted via `workerConfigSchema` (optional-with-default, bounds 1000-3600000, default 120000) — apps/worker consumes it in wave 3 on `task/w3-worker`. B3 schema proposal becomes migration `0002_workflow_compilation.sql` (`compiled_plans`, `rejection_issues`, version-pinned) owned by `task/w3-db`; plan-shape alignment with the compiler is recorded as follow-up coordination after both report (no cross-agent shared-file coupling).

## 2026-10-27 — Bounded SDLC mapping on installed Mastra d.ts (from B2 verification, ratified)
- Decision: the SDLC machine runs as `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created`; the loop body runs validation then at most one repair turn while budget allows, with `repairAttemptsUsed` persisted in workflow state.
- Rationale: installed @mastra/core loop primitives accept single-step bodies; multi-step loops/impose if/else are not expressible — template stays serializable (`defaultSdlcPlan`), runtime uses the dountil shape.
- Alternatives rejected: linear ladder (mirrors repairing unconditionally), custom orchestration framework (against ARCHITECTURE.md §12).

## 2026-10-27 — CI: GitHub Actions gates + advisory gitleaks
- Decision: frozen-lockfile install → biome → typecheck-all → test on every push/PR; gitleaks advisory until scan noise is reviewed.
- Rationale: automated secret scanning was demanded by the legacy repo's leaked-token history (documented in its private repo); advisory prevents blocking on unknown patterns until triaged.

## 2026-10-29 — Wave 3 integration: content-hash reconciliation, zero overwrites
- Decision: each uncommitted `task/w3-*` worktree was committed on its own branch, then merged into `main` with `--no-ff`; duplicated files carried by more than one worktree were reconciled by **content hash** first. `task/w3-db` and `task/w3-wfschema` were treated as canonical owners of their packages; `w3-web`'s duplicate `packages/db`/`packages/workflow-schema` copies (identical except an older `db/src/index.ts`) were backed up (`/tmp/w3-web-dupes-backup/packages-dupes.tar`) and dropped so only `apps/web` came from that branch.
- Rationale: "no conflicts, no overwrites" is satisfied by ownership discipline, not by merge-tool luck — comparing hashes proves a duplicate is redundant before it is discarded, and the backup makes the discard reversible.
- Alternatives rejected: three-way merging duplicate package trees (reintroduces the exact divergence the parallel-wave design prevents); deleting duplicates without a backup (irreversible if a hash comparison was wrong).

## 2026-10-29 — Migration 0002 applied; `JSON.stringify` params bind as `::text::jsonb`
- Decision: `0002_workflow_compilation.sql` is applied to Neon `isolate-platform` via the repo-native `scripts/apply-migration.ts` (idempotent, statement-split, verifies the full 20-table set). All new JSON writes bind `$n::text::jsonb`, not `$n::jsonb`.
- Rationale: postgres.js stringifies a JS string parameter before it reaches a `jsonb` cast, so `$4::jsonb` stores the *JSON text as a JSON string* (`jsonb_typeof = 'string'`). `0001` never noticed because `parseJsonbColumn` parses the double-encoded value on read; `0002`'s `jsonb_typeof(plan) = 'object'` CHECK made it a hard failure. `::text::jsonb` forces the driver to keep the string and lets Postgres parse the JSON itself.
- Alternatives rejected: passing JS objects instead of pre-serialized strings (works, but the repositories intentionally own serialization and the live test asserts DB-level types); loosening the CHECK (would hide the defect and break SQL-side JSON scans).

## 2026-10-29 — CI also builds the web app and runs the client secret sweep
- Decision: `.github/workflows/ci.yml` gained `bun run build` and `bun run check:client` under `apps/web`, alongside the existing lint/typecheck/test jobs.
- Rationale: the control-plane app is the only place a provider key or `DATABASE_URL` could reach a browser bundle; a build that never runs in CI cannot prove the server-only boundary survives bundling. The sweep (22 checks over 4 client files) is the regression test for that boundary.
- Alternatives rejected: relying on typecheck alone (types do not model bundle reachability); a manual pre-push check (already drifted once).

## 2026-10-29 — Zed MCP config left unchanged; Qoder uses pinned local servers
- Decision: `.zed/settings.json` still points at `@mastra/mcp-docs-server@latest`; the user declined changing it. Qoder Desktop instead runs pinned local installs (`~/.qoder/mcp-servers/{context7,mastra-docs}`) via `node <dist>`, plus the hosted Neon MCP with OAuth.
- Rationale: 1.3.10 crashes on Windows (`ERR_MODULE_NOT_FOUND` in `@modelcontextprotocol/client`), so "latest" is unsafe there; but editing another IDE's config is the user's call, not ours. The pinned-local pattern is the durable fix and is recorded as wave-4 item W4-H.
- Alternatives rejected: silently editing `.zed/settings.json` (refused by the user); pinning via `npx` (Windows cold-start init timeouts observed).

## 2026-10-29 — Baseten (Muse Spark Open) is the primary inference provider
- Decision: run the coding agent on Baseten Model APIs through the **existing** OpenAI-compatible model object (`providerId/modelId/url/apiKey` in `packages/mastra/src/agents/types.ts`): base URL `https://inference.baseten.co/v1`, `BASETEN_API_KEY`, model id `meta-models/muse-spark-open-1026` (Meta Muse Spark Open; confirmed by the user and pinned as the platform default). No other model or provider is configured. `@mastra/core@1.79.0` stays pinned; no new inference framework or router.
- Rationale: $100 credits are the grant for this model only; Mastra already supports arbitrary OpenAI-compatible endpoints in object form, so the integration is config plus a usage callback, not a rewrite. An env-driven base URL also keeps a second compatible provider possible without code changes if credits are not approved.
- Alternatives rejected: adding a Baseten-specific SDK/plugin (duplicates Mastra's model layer); Mastra's `baseten/...` router string (the registry does not list Muse Spark Open, and the exact dated snapshot must come from the account's model list); hardcoding a slug (wrong snapshot risk).

## 2026-10-29 — Modal is the sandbox execution provider, behind our own contract
- Decision: implement `ModalSandboxProvider` in `packages/sandbox` over `modal@0.11.x`, satisfying the existing `SandboxProvider` contract (`create/execute/destroy`) and reusing `commandPolicy` (argv, timeout, output caps) unchanged. `NullProvider` remains the default; Modal is opt-in via `SANDBOX_PROVIDER=modal`.
- Rationale: $100 Modal credits plus a JS sandbox API cover the execution gap; our policy/limit/audit boundary is already tested and the agent-facing `sandbox.exec` tool already exists in `wirePlatformTools`, so the provider is an adapter, not a new security model. Direct SDK use keeps the boundary in one reviewed file.
- Alternatives rejected: Mastra's `Workspace` + ComputeSDK Modal provider (the documented `@mastra/workspace-sandbox-computesdk` package is not published — npm 404 on 2026-10-29 — and would move policy into a beta layer); calling Modal's Python SDK (violates the TypeScript runtime); Python-only custom images (JS SDK offers registry/ID images; use `node:22-bookworm` or `oven/bun:1` with git).
- Verification gates: pin `modal` exactly; fake `ModalSandboxClient` for offline tests; live smoke only under `MODAL_LIVE=1` with tiny limits. Egress mapping (`outboundDomainAllowlist` vs `blockNetwork`/`cidrAllowlist`) is verified against the installed d.ts before coding and recorded if the two differ.

## 2026-10-29 — Spend control uses existing `usage_records`, no migration
- Decision: every Baseten call and every Modal sandbox session writes a `usage_records` row (provider, model/sandbox id, tokens or sandbox-seconds, `cost_usd` from a config price table); caps come from worker config (`maxTokensPerTask`, `maxSandboxSeconds`, `maxCostUsdPerTask`) and existing `budget_limits`. No schema change in wave 4.
- Rationale: the table already has org/task/model/provider/token/cost columns and indexes; a new migration would add coordination cost across parallel lanes for no additional capability. Per-org spend is a `sumByOrgSince` query.
- Alternatives rejected: new `sandbox_sessions` table (duplicates usage_records for MVP); unbounded spend with alerting only (credits are finite and shared).

## 2026-10-29 — Provider credentials are the last step (standing credit policy)
- Decision: a wave must be fully implemented, tested, built, merged and offline-green with `INFERENCE_PROVIDER=none` / `SANDBOX_PROVIDER=null` **before** any Baseten or Modal credential is supplied. Keyed activity is restricted to a single bounded acceptance pass: one `GET /v1/models`, one completion (`max_tokens <= 16`, no tools), one sandbox (`echo`, ≤60 s, smallest limits, terminated), optional bounded end-to-end only with separate approval. No exploratory, benchmark, load, or retry-loop calls; no live calls in CI; measured spend must be read from `usage_records` and reported. Canonical policy: `AGENTS.md` §Provider credits.
- Rationale: the credits are finite, shared, and granted per person; most integration bugs are adapter/mapping/policy bugs that fakes catch for free. Making keys the last step converts the default failure mode from "spend to discover" into "pass offline gates, then verify once." It also keeps CI free and reproducible for contributors without accounts.
- Alternatives rejected: provisioning keys at sprint start for convenience (spends on scaffolding mistakes and invites exploratory calls); allowing agents to "just run one" live test when blocked (unbounded by repetition); relying on dashboard alerts only (lagging and not enforced at the call site).

## 2026-10-29 — W4-0 verified provider facts (docs + d.ts only, no keyed calls)

Verified against the published `modal@0.11.1` tarball `dist/index.d.ts`, Baseten Model APIs docs, Mastra docs, and the installed `@mastra/core@1.79.0` d.ts. No credential was read, requested, or used.

- **Modal JS (`modal@0.11.1`; Node 22+):** `import { ModalClient } from "modal"`; `new ModalClient({ tokenId, tokenSecret })` (also falls back to `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`). Create needs an **App**: `client.apps.fromName(name)` then `client.sandboxes.create(app, image, params)`; image from `client.images.fromRegistry("node:22-bookworm")` (synchronous, registry pull). Params: `cpu`, `memoryMiB` (not bytes), `timeoutMs`, `idleTimeoutMs`, `command: string[]`, `workdir`, `env`. Network is `blockNetwork: true` by default-able flag plus `outboundDomainAllowlist: string[]` / `outboundCidrAllowlist: string[]` — there is **no** `cidrAllowlist` and no `network: {...}` object in 0.11.1 (Context7 autodocs disagree; the d.ts wins). `sandbox.exec(argv, { timeoutMs })` returns a `ContainerProcess` **with streams**; read via `readText()`, exit code via `proc.wait(): Promise<number>` (no `.exitCode`). `timeoutMs` defaults to 0 (unbounded) — always pass one. `terminate()` is **not documented as idempotent**; the adapter must guard per handle.
- **Baseten:** OpenAI-compatible base `https://inference.baseten.co/v1`, chat at `/chat/completions`, model list at `GET /v1/models`, `Authorization: Bearer <key>`; model id `meta-models/muse-spark-open-1026`; usage fields `usage.prompt_tokens` / `usage.completion_tokens` / `usage.total_tokens`. Phase D's single `GET /v1/models` confirms the id before the one completion.
- **Mastra 1.79:** `agent.generate(prompt, { maxSteps })` (finite, default 5); `generate()` returns `{ text, totalUsage, toolCalls, toolResults, steps }`; `totalUsage` is `{ inputTokens, outputTokens, totalTokens, ... }`. Tool-call entries are chunk-shaped (`payload.toolName`), so the runtime must read names from the concrete result shape rather than cast blindly.
- **Image choice:** `node:22-bookworm` (full, not `-slim`) — must ship `git` for the git helpers; `oven/bun:1` is acceptable only if a probe shows git present. Image is a constant, not repo-controlled.
- **Sandbox env:** `MODAL_APP_NAME` and `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` are server-only worker env; the web app and client bundle never see them.

### Key-less acceptance path (Phase C, designed here)

`scripts/acceptance-offline.ts` runs with `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`, and asserts no `BASETEN_*`/`MODAL_*` variable is set. It composes production services with package fakes and asserts, in order:
1. submission through the control-plane service validates and enqueues exactly one `run_task` job (idempotent replay yields the same job);
2. the worker loop claims the job and runs the task handler;
3. agent turns run through the policy-gated tools: an allowlisted read executes against the fake backend, a non-allowlisted/approval-band tool is denied and never reaches the backend;
4. the injected usage sink receives one row per model call and the sandbox-teardown row;
5. `destroy` is observed exactly once on success, thrown handler error, and abort;
6. the job ends in the expected ack state (complete / retry / dead_letter) and the queue shows no in-flight lease.
No provider SDK is imported and no network call is made; the script exits non-zero on any assertion.

## 2026-10-29 — W4-OPS integration decisions

- **Offline acceptance lives at `scripts/acceptance-offline.ts` and is runnable as `bun run acceptance:offline`.** It imports production control-plane and worker modules via relative paths (root scripts cannot resolve `@isolate/*` specifiers because the root package declares no workspace dependencies; per-package `node_modules` symlinks make the nested imports resolve). It refuses to start when any `BASETEN_*`/`MODAL_*` variable is present or when `INFERENCE_PROVIDER`/`SANDBOX_PROVIDER` hold non-offline values.
- **The acceptance uses fakes at the package boundaries, not at the service boundaries.** Submission goes through `createTaskService` + `createRepositoryStore` + `createSubmissionCompiler` with in-memory task/queue/compilation repositories; execution goes through the real `createWorkerLoop` + `createTaskExecutionHandler`; tools go through the real `wireSandboxTools` policy gate with a recording fake backend. This exercises the seams that can regress without touching a provider.
- **`destroy` is asserted by counting, and usage by row shape.** Success expects exactly one model row (`baseten`, 10/5 tokens, null cost) and one sandbox row (`recording-fake`, `sandbox:1x512`, null tokens); throw expects only the teardown row; abort is driven by a false heartbeat (lease loss) so teardown happens before any model call. Costs stay null because no trusted price table is configured — the script must not invent a price.
- **Client sweep patterns now include `BASETEN_`, `MODAL_`, `inference.baseten.co`, `modal.com`** in addition to the existing key/DB/private-key patterns, for 26 checks over the built client bundle.
- **Composition remains injection-only.** Real adapters are not selected at boot: task context has no DB source, the runtime factory receives no sandbox handle, and Modal client construction performs an API call. These are tracked in `CHALLENGES.md` as wave-5 integration work, not papered over with partial wiring.

## 2026-10-29 — W5-AUTH: Neon Managed Better Auth is the identity provider; the id is the tenancy bridge

Verified live against Neon project `divine-butterfly-60669535` (branch `br-steep-poetry-ar5iwdkb`) with the Neon MCP: `auth_provider = "better_auth"`, `owned_by = "neon"`, base URL `https://ep-lucky-night-arkvt9aj.neonauth.c-4.us-west-2.aws.neon.tech/neondb/auth`, JWKS at `…/auth/.well-known/jwks.json`. The Neon-managed `neon_auth` schema holds `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `jwks`, `project_config`; `user.id` is a `uuid` with `gen_random_uuid()` default.

- Decision: use `@neondatabase/auth@0.7.0-beta` **server-side only**. The app proxies `/api/auth/*` upstream through a server-only TanStack route and rewrites the `__Secure-neon-auth.*` cookies onto its own origin. The browser never contacts the auth host, so no third-party cookie is involved and the SDK cannot reach the client bundle.
- Decision: **the user id is the identity bridge.** `public.users.id` is a `uuid` and Neon Auth issues `uuid` ids, so the authenticated id *is* the platform user id — `memberships.user_id`, `tasks.created_by` and `workflow_versions.created_by` keep pointing at the session's owner. No second mapping table, no id translation table.
- Decision: **tenancy stays in `public.organizations` + `public.memberships`.** Better Auth's organization plugin is not used for tenancy — Neon runs it server-side for its own console, and it cannot express the platform's `viewer` role. Neon Auth answers *who*; the platform tables answer *what*.
- Rationale: the user asked for "proper user access instead of everyone seeing everything". A single source of tenancy truth keeps the role model (`owner|admin|member|viewer`) and the capability matrix in this repo, and avoids a dual-write between two organization models.
- Alternatives rejected: mapping table between `neon_auth.user` and `public.users` (a second source of identity that must be kept in sync and can drift); Better Auth organizations as the tenancy model (loses `viewer`, splits tenancy across two schemas); self-hosted Better Auth (re-adds credential storage, email verification, and password-reset flows that the managed product already runs).

## 2026-10-29 — W5-AUTH: identity is server-derived, the role is the only authorization input

- Decision: request data is **never** an identity or authorization input. Headers, cookies, query parameters and form fields are ignored for identity. A `SessionResolver` may only answer "who is calling"; a separate `MembershipReader` may only answer "which organization is active". Both fail closed — an unreadable session is `AUTH_REQUIRED`, an unreadable membership is `FORBIDDEN`.
- Decision: the **membership role** is the sole authorization input, and it is read from the membership row. `packages/db` maps roles to capabilities (`task:read`, `task:submit`, `organization:read`, `member:manage`): `viewer` may read but never submit. A capability failure is `FORBIDDEN` and must fire **before** any storage read or write.
- Decision: the **remembered organization is a preference, not authorization**. It is honoured only when the caller really holds that membership and is otherwise ignored, so a stale cookie can neither widen access nor lock the caller out. A *requested* foreign organization is `FORBIDDEN`.
- Decision: the compilation service's `authorizeMembership` dependency became **mandatory**. It previously defaulted to `async () => true` — the scope alone opened the gate. It is now re-checked against `memberships` **inside the submit transaction**, so the task insert, the queue insert and the compiled plan are all guarded by the same live membership read.
- Rationale: "everyone seeing everything" is a failure of the *read path*, not of the write path. Binding authorization to a server-derived role, and re-checking it in the transaction that performs the write, removes the class of bug where a trusted-but-stale scope outlives the membership that justified it.
- Alternatives rejected: RLS policies (the platform's tenancy predicates live in the service layer and the schema does not carry an RLS setup; adding RLS now would be a second authorization model with two failure modes); request-supplied organization ids (the original "everyone sees everything" defect); cookie-only authorization (a cookie is an attacker-controlled preference, never a grant).

## 2026-10-29 — W5-AUTH: a database without a usable auth host fails closed

- Decision: when `DATABASE_URL` is present but the Neon Auth configuration is missing or unusable, the auth state is `unavailable` and **every tenant route redirects to `/login` with 307**. The local demo fallback is reachable only when `NODE_ENV` is `development`/`test`, `WEB_LOCAL_DEMO=true`, **and** `DATABASE_URL` is absent — a demo identity must never point at a real database.
- Decision: `scripts/smoke-build.ts` asserts this against the production build: `/`, `/runs` and `/organizations` must answer 307 with a `/login` location even when spoofed `x-organization-id` / `x-user-id` headers are present, and `/login` must answer 200 with `cache-control: no-store`.
- Decision: the client-bundle sweep (`scripts/check-client.ts`) gained the forbidden tokens `@neondatabase/auth`, `better-auth`, `neonauth` and `__Secure-neon-auth`, on top of the existing provider-key and DB-URL patterns.
- Rationale: a control plane that serves tenant data when its identity provider is down is worse than one that serves nothing. Failing closed converts a security defect into an outage.
- Alternatives rejected: falling back to the demo tenant in production (would expose a shared tenant to every unauthenticated visitor); serving a cached page from before the outage (still tenant data).

## 2026-10-29 — W5-AUTH: the `neon_auth` schema is Neon-owned and is never migrated by this repo

- Decision: `packages/db/migrations/0003_auth_identity.sql` contains **only** `CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id)`. The `neon_auth` schema is created and owned by Neon; this repo never writes to it and never alters it.
- Rationale: `memberships` PK is `(organization_id, user_id)` and cannot serve the reverse "which organizations may this caller see?" lookup, which the membership reader performs on every request. The index is the only schema change the feature needs.
- Alternatives rejected: replicating Neon Auth's tables into `public` (two identity stores that can disagree); writing to `neon_auth` from application code (Neon owns its schema and may re-create it).

## 2026-10-29 — W5-AUTH: the shared root `bun.lock` is the only cross-agent conflict point

- Decision: `apps/web` gained a runtime dependency (`@neondatabase/auth@0.7.0-beta`), so the root `bun.lock` is updated on `task/w5-auth`. CI installs with `--frozen-lockfile`, so the lockfile **must** be committed for the pipeline to pass.
- Rationale: `bun.lock` is a single root file shared by every worktree — the one file class AGENTS.md reserves for the coordinator. W4-SBX and W4-WRK also carry uncommitted `bun.lock` changes (Modal / Mastra dependencies), so the coordinator must reconcile the three lockfile deltas rather than let the last merge win.
- Alternatives rejected: committing the app change without the lockfile (CI's `--frozen-lockfile` install fails, so the branch would be unmergeable); vendoring the SDK (the dependency is already published and version-pinned).

## 2026-10-30 — W6.1: Meta Model API is the dev/pre-production inference path; Baseten is production

- Decision: `INFERENCE_PROVIDER` accepts `none | meta | baseten`. `meta` uses `https://api.meta.ai/v1` with `META_API_KEY` and exactly `muse-spark-1.3-contributor`; `META_MODEL_ID` may only repeat that id (any other value fails closed). `baseten` stays the production path with `meta-models/muse-spark-open-1026`.
- Rationale: agentic plan tests should run on Meta's contributor access while it is available; Baseten credits are reserved for production and a single pre-production pass.
- Consequences: both providers share the same Mastra runtime factory and tool wiring; only the model config differs. Neither provider is auto-selected: the worker fails closed when the selected provider's key is missing.
- Verified: one bounded Meta agent turn produced a 74-character plan with 103 prompt / 367 completion tokens (including reasoning) in 4.5 s; the usage row was recorded and cleaned up.
- Alternatives rejected: a single provider with a runtime-overridable model id (silent model drift); hard-coding a Meta/Baseten switch on `NODE_ENV` (deployment-specific and easy to get wrong).

## 2026-10-29 — W6: Meta Muse Spark Open `1026` is the only inference model

- Decision: `BASETEN_DEFAULT_MODEL_ID` is `meta-models/muse-spark-open-1026`; `BASETEN_MODEL_ID` exists only to pin the same family, not to select another vendor/model. The legacy `MODEL_PROVIDER`/`LLM_*` gateway block was removed from `.env.example`, and no code path reads it.
- Rationale: the grant is restricted to Muse Spark Open, and an accidental fallback to another model is a spend and policy failure. One hard-coded default plus a fail-closed key check removes the selection surface.
- Confirmation: the bounded Phase D call listed 20 models and the target id was present; the one Phase E completion returned HTTP 200 with 148 prompt / 16 completion tokens.
- Alternatives rejected: keeping a general `MODEL_ID` env with no validation (silent provider/model drift); adding a router (outside the grant; more moving parts).

## 2026-10-29 — W6: task context is persisted on `tasks`, not derived from the compiled plan

- Decision: migration `0004_task_context.sql` adds `tasks.goal`, `tasks.acceptance_criteria` (jsonb array) and `tasks.file_ownership` (jsonb array). Submission persists them; the worker's `loadTaskContext` reads them in one tenant-scoped join with `repositories`.
- Rationale: the compiled plan describes *how* the workflow runs, not *what* "done" means. Goal/acceptance/ownership are authored task inputs, and the prompt builder needs exactly those. Persisting them on the task row also makes a redelivered job reproduce the same context.
- Consequences: `submitTaskSchema` requires a goal and bounds the arrays. Existing rows default to `''`/`[]`, which the worker still executes (the prompt says "none provided").
- Alternatives rejected: stuffing the fields into the job payload (a mutable queue row is not the system of record); deriving them from `compiled_plans.plan` (the plan has no goal/ownership semantics); a separate `task_contexts` table (one row per task with no independent lifecycle).

## 2026-10-29 — W6: the worker binds one sandbox backend per job through the runtime factory

- Decision: `CodingAgentRuntimeFactoryOptions` gains `sandboxBackend` and `toolContext`. The handler builds the backend from the handle it just provisioned and passes it with the job's organization/task ids; the Baseten factory wires `wireSandboxTools(backend).forTask(...)`.
- Rationale: tools must be bound to exactly one sandbox and one task. Putting the handle in the factory options keeps the handler provider-agnostic and closes the wave-4 gap where `SandboxToolBackend` had no handle to bind.
- Consequences: the backend sends every call through `executeCommand`, so the injected `CommandPolicy` still decides executable, argv shape, timeout, output cap and egress. The default policy allows `cat`, `ls`, `grep`, read-only `git` shapes and `bun test`/`bun run test|typecheck|lint`; everything else is `POLICY_DENIED` before the provider sees it.
- Alternatives rejected: giving the tool layer a `SandboxProvider` directly (the model-adjacent layer would own provisioning); one global backend (leaks handles across tasks).

## 2026-10-29 — W6: Google sign-in uses the proxied callback exchange, not a direct SDK redirect

- Decision: `startGoogleSignIn` asks the server SDK for a provider URL (`disableRedirect: true`) with a same-origin `callbackURL` of `/auth/callback`. The browser visits Google; Neon returns to `/auth/callback` with the session verifier; `processAuthMiddleware` exchanges it for first-party session cookies, which the route relays as raw `Set-Cookie` headers.
- Rationale: the SDK and the cookie secret must stay server-side, and the OAuth challenge cookie must be first-party. The verifier exchange is the SDK's documented completion step for a proxied flow.
- Consequences: the app origin must be in Neon's trusted-domain list (`http://localhost:3000` added for development). Production uses the deployment origin plus either Neon's shared Google provider (development) or own Google credentials with `{NEON_AUTH_BASE_URL}/callback/google` as the Google redirect URI.
- Alternatives rejected: letting the browser talk to the Neon host directly (third-party cookies, SDK in the client bundle); trusting a client-supplied `callbackURL` (open redirect).

## 2026-10-29 — W6: no cross-schema foreign key between `public.users` and `neon_auth.user`

- Decision: the identity bridge stays a shared UUID value; the repository does not add `public.users.id REFERENCES neon_auth.user(id)`.
- Rationale: `neon_auth` is Neon-managed and may be re-created or altered without a migration in this repo. A cross-schema FK would make test databases without that schema fail and couple platform migrations to an external lifecycle.
- Consequences: the invariant is enforced by `toIdentity` (UUID parse) and `users.email UNIQUE`. `memberships.user_id`, `tasks.created_by` and `workflow_versions.created_by` keep real FKs to `public.users`.
- Alternatives rejected: mirroring auth tables into `public` (two identity stores); writing to `neon_auth` (forbidden); a mapping table (the id is already the same value).


## 2026-10-30 — W7: wave 7 is execution truth, not a UI wave

- Decision: wave 7 closes the execution path (seed → clone → edit → commit → lifecycle → approval gate) and deliberately excludes UI redesign, functional run/approval pages, and test-execution gates. Those are wave 8.
- Rationale: the platform can route, authorize and bill a task but cannot yet produce a coded change. Building a product surface before the lifecycle/approval/artifact contracts settle would force a rewrite of every page when those contracts change.
- Consequences: approval decisions are exercised offline through the service/repository layer; a human cannot click "approve" until wave 8. The worker still persists the approval and pauses correctly, so wave 8 is surface work, not a new backend.
- Alternatives rejected: doing design and execution in one wave (two moving contract surfaces, neither stable); skipping lifecycle and going straight to UI (a dashboard over a task that never leaves `queued`).

## 2026-10-30 — W7: the Git credential travels as create-time sandbox env, never argv or URL

- Decision: the clone credential is passed in `SandboxSpec.env` and consumed by Git through `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0` (`http.extraheader`). The repository URL stays credential-free. `TaskWorkspaceGit` never accepts a token parameter.
- Rationale: argv, process listings, `git remote -v`, error text and event payloads are all observable surfaces. A token in a clone URL leaks into `.git/config` and logs; a token in argv leaks into process metadata. Create-time env is the smallest surface that still works with the Modal adapter (it already forwards `env` at sandbox creation).
- Consequences: the token is present for the sandbox lifetime, so it must be short-lived (installation token, ≤60 min), repo-scoped and least-privilege. `assertToolchain` runs before clone so an unsupported image fails before any network use.
- Alternatives rejected: token-in-URL (persists in `.git/config`); `-c http.extraHeader=...` in argv (process metadata); a host-side clone copied into the sandbox (breaks the execution-plane boundary).

## 2026-10-30 — W7: approval pause uses `awaiting_approval` + a `resume_task` job

- Decision: when push is enabled, the approval is requested **before** execution during `planning`, bound to the exact `{repoUrl, branch}` payload SHA. A pending approval moves the task to `awaiting_approval` and acks the job as complete (not retry). A `resume_task` job re-enters the handler only for an approved, unexpired record with the same SHA; rejection/expiry moves the task to `failed`.
- Rationale: sandboxes are destroyed at job end, so a commit made in a paused sandbox would be lost. Retrying the job would provision a second sandbox and spend credits while a human thinks. Acking is the only queue state that stops redelivery. Re-checking the SHA on resume preserves the "approval is bound to the exact action" invariant.
- Consequences: the approved payload is the repository and branch, not the future commit SHA; the worker re-checks the branch it pushes matches the approved branch. A paused task holds no lease and no sandbox. A duplicate pending approval is treated as idempotent success (partial unique index).
- Alternatives rejected: pausing after execution and keeping the sandbox alive (hours of idle spend) or bundling the commit into an artifact and restoring it on resume (a second storage/lifecycle surface); approving by mutating the task row without a resume job (the worker never wakes).

## 2026-10-30 — W7: diffs are bounded inline artifacts, not object storage

- Decision: `artifacts` gains a nullable `content text` column with a 256 KiB byte CHECK. Wave 7 stores the bounded patch inline with `storage_ref = inline:<sha256>`; object storage stays out of scope.
- Rationale: the platform needs a reviewable diff artifact now; introducing object storage would add credentials, lifecycle policy and a second failure mode before there is a UI that reads it. A 256 KiB bound is enough for review metadata and keeps Neon rows small.
- Consequences: oversized diffs are truncated with an explicit `truncated` flag and the artifact sha covers the stored bytes. Wave 8 must add object storage if full patches are required.
- Alternatives rejected: storing diffs only in `run_events` (unbounded JSON, no artifact lifecycle); adding S3/R2 now (extra credentials and deployment work).

## 2026-10-30 — W7: the validation gate is "diff present + ownership honored"

- Decision: wave 7 transitions `executing → validating → review_ready` on a non-empty diff whose paths stay inside `fileOwnership`. Running the repository's formatter/lint/typecheck/tests as a gate is wave 8.
- Rationale: a per-repository command contract (which commands, which working directory, which timeouts, which failures are repairable) is its own design surface. Pretending `bun test` is universal would produce false gates on non-Bun repositories. The lifecycle and event vocabulary already support the full gate, so wave 8 adds semantics, not plumbing.
- Consequences: `review_ready` means "the agent produced an in-bounds change", not "the change passes CI". The PR remains approval-gated.
- Alternatives rejected: hard-coding `bun test` (wrong for most repositories); blocking wave 7 on a command-contract design (delays the execution path).

## 2026-10-30 — W7: frontend design starts after wave 7 merges, as wave 8

- Decision: begin the visual/product design work when the wave-7 backend contracts are on `main` — specifically once task lifecycle transitions, run events, attempts, bounded diff artifacts, approvals and repository onboarding reads exist as stable server contracts. That is wave 8, performed in parallel with live GitHub/deployment wiring.
- Rationale: design needs real states (queued → planning → executing → validating → awaiting_approval → review_ready → failed/cancelled), real event payloads and a real approval object. Designing before these exist produces mock states that do not survive contact with the backend.
- Consequences: wave 8 starts with a token/design-system pass and a run-detail page, not a greenfield app. The current UI is a functional control surface and should not be polished incrementally before the data model is visible.
- Alternatives rejected: designing now against placeholder data (rework); a full redesign before wave 7 (freezes the contract work behind visual decisions).

## 2026-10-30 — Worktree pruning policy

- Decision: after a lane merges, remove its worktree and delete its branch. `git worktree remove` is forced only when `git diff --ignore-space-at-eol` proves the working copy differs solely by CRLF noise; otherwise the worktree is left in place and investigated.
- Rationale: merged worktrees accumulate `node_modules`, stale `.env` files and EOL noise; leaving them invites edits against a dead branch. The EOL guard prevents force-removal from hiding real uncommitted work.
- Consequences: `git worktree list` shows only active lanes plus `main`; wave-5/6 trees were pruned on 2026-10-30 after both branches were confirmed merged.
- Alternatives rejected: keeping every worktree forever (disk and confusion); deleting on merge without the EOL check (could discard real work).

## 2026-10-30 — W7 integration: queue vocabulary, seed, and credential wiring

- Decision: `resume_task` is added to `JobType` and the `jobs_type_check` constraint in `0005` (drop + add, idempotent) rather than emulated in the worker. `scripts/seed-workspace.ts` (`bun run seed`) creates the repository + workflow definition/version using raw SQL because no workflow-definition writer repository exists yet; it validates membership and compiles the graph before inserting.
- Decision: `runtime-composition.ts` binds the DB lifecycle and `createTaskWorkspaceGit` when a real sandbox provider is selected, and builds the GitHub broker only when all three `GITHUB_APP_*` values are present. The per-job `resolveSandboxEnv` returns `GIT_CONFIG_*` (`http.extraheader`) values for a repo-scoped installation token; `pushEnabled` requires both a real sandbox and a broker and is opt-out via `GITHUB_PUSH_ENABLED=false`.
- Rationale: the queue's vocabulary and the worker's handler registration must agree at the database, not just in TypeScript; a local worker union would pass typecheck and fail on the first real enqueue. Seed data is the precondition for any Postgres submission, and credential wiring must be fail-closed on partial configuration.
- Consequences: a partial GitHub configuration stops worker boot with `MISSING_CONFIG`; a public repository still clones without a broker. `0005` must be applied before the seed/worker paths that touch `artifacts.content`, `resume_task` or the new unique indexes are usable.
- Alternatives rejected: widening only the worker's type union (runtime failure at enqueue); a full workflow-authoring repository/UI in wave 7 (wave 8 surface work); passing the token in the clone URL (leaks into `.git/config`).

## 2026-10-30 — W7 close: migration applied and one bounded Meta + Modal pass

- Decision: apply `0005_execution_truth.sql` to Neon `isolate-platform` (`br-steep-poetry-ar5iwdkb`) through the Neon MCP in a single transaction, after a read-only precondition check confirmed zero pending approvals and zero duplicates. No temporary branch was used because the statements are additive and idempotent.
- Decision: run exactly one sequential live pass with `META_LIVE=1 MODAL_LIVE=1` and caps `MAX_TOKENS_PER_TASK=2048`, `MAX_SANDBOX_SECONDS=60`, `MAX_COST_USD_PER_TASK=1`: one Meta plan turn (1024 output cap) and one Modal sandbox (`0.125 CPU / 512 MiB / 60 s`, `echo isolate-ok`). No Baseten call, no GitHub call, no retries.
- Measured: Meta **103 prompt / 429 completion tokens** in **6.1 s**; Modal exit 0; sandbox destroyed; `client.sandboxes.list()` returned **0** running; temporary usage organization and rows cleaned. `cost_usd` stays null because no trusted price table is configured.
- Rationale: the migration is the precondition for the new lifecycle and seed paths, and the bounded pass proves both configured providers still work after the wave-7 composition changes without spending Baseten credits or touching GitHub.
- Consequences: `0005` is now part of the live schema; the live DB suite can exercise the new lifecycle test when `DATABASE_URL` is present. The next external dependency is the GitHub App credential set, which remains unconfigured.
- Alternatives rejected: running the migration without the duplicate-pending check (the partial unique index would fail); adding a Baseten call for symmetry (unnecessary spend); retrying the pass to "confirm" (policy forbids retries after success).

## 2026-10-30 — W7: the GitHub key accepts multiline, escaped, and file-path forms

- Decision: `createGitHubAppTokenProvider` normalizes PEM text (real newlines, literal `\n`, CRLF, surrounding quotes) before parsing, and the worker composition accepts `GITHUB_APP_PRIVATE_KEY_PATH` as a server-side alternative to the inline value. A complete inline key still wins; an incomplete inline key requires the path.
- Rationale: Bun's dotenv parser treats an unquoted multiline value as a single line, so a pasted PEM arrives truncated at `-----BEGIN PRIVATE KEY-----` and no parser change can recover the rest. The path form uses the PKCS#8 file the operator already has, without hand-editing hundreds of `\n` escapes. The file is read once at worker boot and never logged.
- Consequences: `.env` can carry either a quoted multiline PEM, a `\n`-escaped one-liner, or `GITHUB_APP_PRIVATE_KEY_PATH`. A partial key configuration fails closed with `MISSING_CONFIG`; an incomplete inline value with no path fails with an explicit "quote the multiline value or set GITHUB_APP_PRIVATE_KEY_PATH" message.
- Alternatives rejected: custom `.env` parsing to reassemble unquoted multiline values (reads a secrets file outside the app's normal env contract and is fragile); requiring base64 (still a manual one-line transformation); silently using the truncated key (guaranteed auth failure at the first token mint).

## 2026-10-30 — W7: allowlist egress omits `blockNetwork`

- Decision: `ModalSandboxProvider` maps `egress: {mode:"allowlist"}` to `outboundDomainAllowlist` **without** a `blockNetwork` field; `egress: {mode:"deny"}` maps to `blockNetwork: true`. The normalized `ModalCreateParams.blockNetwork` is optional and the real client emits it only when defined.
- Rationale: Modal rejects an allowlist combined with `blockNetwork` even when it is `false`; the d.ts states the two are mutually exclusive. Omitting the flag is the only valid representation of "network on, confined to these domains".
- Consequences: the first live allowlist clone/push attempt failed before a sandbox was created; after the fix, the parameter shape is covered by fake-client tests. The corrected live rerun awaits explicit authorization because the credit policy forbids retrying after a failure without asking.
- Alternatives rejected: sending `blockNetwork: true` with the allowlist (rejected by Modal and would block the clone); removing the allowlist (would leave network unrestricted).
