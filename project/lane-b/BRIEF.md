# Sprint B — Runtime & Orchestration Plane (lane brief)

> **RESUME AMENDMENT (2026-10-27, repo migration):** Sprint work now happens in the NEW event repo `C:\Users\Sahil\Documents\isolate-platform` (fresh history, event-week-only code). Your worktree becomes `C:\Users\Sahil\Documents\worktrees-platform\<task-dir>` on branch `task/<name>`. Your transplanted work is already on disk there; first action on resume: run your gates, fix known defects listed in your coordinator handoff, finish remaining DoD, commit with `feat(...): ...`, never push. Brief text below applies otherwise unchanged.

Sprint B owns runtime execution: the worker (B1), Mastra agent/workflow runtime (B2), the visual workflow compiler (B3), and GitHub integration contracts (B4). Lane integration branch is `sprint/b-runtime`.

## Hard rules (no negotiation)
1. Your session owns a narrow file set (below). Never touch other directories, never `package.json`, `bun.lock`, root configs, root `project/*.md`, `.github/*`, or other packages. Report instead.
2. Never read/print `.env*`. Tests that need `DATABASE_URL` auto-skip; you may run `bun --env-file ../isolate/.env test` from your worktree root but never print values.
3. Sprint A concurrently implements `@isolate/db` repositories — code to the INTERFACES in `packages/db/src/repositories/*` and the ALREADY-STATED semantics (transition guard, atomic claim, payload-bound approvals). Do not import concrete implementations or add anything to packages you don't own.
4. If a shared contract is missing/wrong for your needs, extend it in your REPORT with a proposed diff text, not by editing `packages/shared`.
5. All loops bounded (state budgets, attempt counters, timeouts). No "keep trying until success".

## Shared operating procedure
- Commands from your worktree root (`C:\Users\Sahil\Documents\worktrees-platform\<name>`).
- Gates before commit: `bunx biome check --write <your-dir>` → `bunx biome check <your-dir>` → `bunx --bun tsc -p <your-dir>/tsconfig.json --noEmit` → `bun test <your-dir>`.
- Tabs, double quotes; re-read narrow file slices after each edit (recorded lesson).
- Mastra questions: the installed d.ts is authoritative (`node_modules/@mastra/core/dist/**`); docs may drift (recorded lesson). Use Context7 via your `execute` MCP tools for orientation, then verify against the installed types.

## Task B1 — Durable worker loop (worktree `sb1-worker`, branch `task/sb1-worker`)
Owner of: `apps/worker/src/**`.
1. Real `WorkerLoop` (replace the bootstrap stub in `main.ts`): bounded poll tick (`pollIntervalMs`), claim → run handler with heartbeat ctx → ack/ackFail protocol per `contracts.ts`, graceful AbortSignal/INT/TERM stop, reaper ticker (`reaperIntervalMs`) calling `queue.requeueExpiredLeases(Date.now())`.
2. Retryable verdicts → `ackFail` (dead-letter decision is the queue's job); non-retryable short-circuits; heartbeat-on-long-tick keeps leases alive without spamming (≈ half lease seconds).
3. Errors: catch everything, map unknown errors to `INTERNAL` (from `@isolate/shared`), sanitize messages (no payloads/stacks/URLs with keys), structured logs only via `Logger` (redacting).
4. Tests: in-memory fake queue + fake handler covering claim/heartbeat/ack/ackFail/retry/dead-letter/lease-expiry/clean-shutdown paths. No real DB required.
Deliverables: worker loop with tests; report includes lifecycle diagram text.

## Task B2 — Mastra agent + bounded SDLC workflow (worktree `sb2-mastra`, branch `task/sb2-mastra`)
Owner of: `packages/mastra/src/**`.
1. Verify the installed `@mastra/core` d.ts for: Agent config forms (openAI-compatible model object uses `{ providerId, modelId, url, apiKey }` in the installed 1.79.0), workflow primitives, tool/createTool signatures, suspend/resume. Cite d.ts file paths in your report.
2. B2 design ruling (from verified d.ts, keep it): the SDLC machine maps to `planning → executing → dountil(gateStep, cond) → review_ready(suspend) → pull_request_created` — the loop body's execute runs validation then (on failure + budget remaining) one repair turn; budget enforced by `repairAttemptsUsed` persisted via workflow state, never raw retry; terminal failure short-circuit.
3. Implement `createSdlcWorkflow` on real Mastra workflows implementing ARCHITECTURE.md §9 with suspend-on-approval and bounded repair via persisted attempt counter.
4. Type the tools registry over approved tool wiring against the PolicyDecision gate from `tools/policy.ts` (deny-by-default snapshot; sensitive actions route to approval, never silently allowed).
5. Model-agnostic fake: tests never hit a real provider/network. Fake runtime per installed types; assert turn budget bounds + suspension/resume + policy denials + turn recording.
Deliverables: compiling workflow with mocked-provider tests + report on installed d.ts evidence.

## Task B3 — Visual workflow registry/validation/compiler (worktree `sb3-wf-schema`, branch `task/sb3-wf-schema`)
Owner of: `packages/workflow-schema/src/**`.
1. Expand the node registry: per-type Zod configs (task.agent needs agent id + prompt template refs; tool.call needs tool name that MUST exist in a supplied allowlist; approval.gate needs action + risk; condition.switch gets enumerated branches — no free expressions; validate.loop needs bounded `maxAttempts` referenced to task budget).
2. `validateDefinition`: duplicate ids, missing edge endpoints, unreachable required terminal step, cycle policy (back edges to executed set unsupported → error), node-type-specific config validation, `UNSAFE_CONFIG` on undeclared fields.
3. `compileWorkflow`: topological/scanned order, performed from the version-pinned definition; reject unvalidated input; annotate steps with validated config. No `eval`, no `new Function`, no arbitrary TS, no dynamic codegen.
4. Tests: valid minimal graph + each rejection class + cycle rejection + version pinning + compiler determinism.
Deliverables: tested registry validate+compile + report (supported subset list + explicitly rejected shapes).

## Task B4 — GitHub connector foundations (worktree `sb4-integrations`, branch `task/sb4-integrations`)
Owner of: `packages/integrations/src/**`.
1. Real REST client via Bun.fetch implementing `PullRequestCreator.createPullRequest` with: credentials injected (never logged), Zod-validated spec+response, error mapping (404→NOT_FOUND, 403→POLICY_DENIED, 429→RATE_LIMITED, network/5xx→INTEGRATION_UNAVAILABLE retryable), approval gating built-in (spec must carry approvalId+payloadSha256 for sensitive paths else APPROVAL_REQUIRED), audit hook via injected audit-shaped interface (mocked in tests), redaction proof test (fabricated token-like message never propagates).
2. Structure modules cleanly (`github/` + `mcp/` + index barrel). No new dependencies — zod + @isolate/shared only.
Deliverables: compiling connector + mocked tests + report (endpoint/permission list + redaction proof).
