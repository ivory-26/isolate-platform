# T3 Code harness study

**Implementation reconciliation (2026-11-17):** the P0 registry, prompt preflight,
failure classification and connector-tool scoping were merged before this wave.
Wave 28 fixes classification through Mastra's bounded error-cause chain and sets
`modelSettings.maxRetries: 0`, making the platform retry wrapper the sole retry
owner. The worker shares `MAX_PROVIDER_RETRY_ATTEMPTS` instead of duplicating its
ceiling. All verification uses fakes; P1 and design-only recommendations below
are proposals, not prerequisites for completing the original research request.

**Status:** research note, docs-only. No source, schema, or configuration change is part of this
document. No provider key was read or used, and no live provider call was made.

**Date:** 2026-11-14

**Subject:** [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) (MIT), `main` branch, read at
the date above. Links below point at `main`; line anchors are to the files as read.

**Question:** which parts of T3 Code's agent/provider harness are worth adopting in
`isolate-platform`, and which parts are product-specific and should stay design-only?

**Our constraints are stricter than T3 Code's.** T3 Code drives agents the user has already
installed and signed in to; it explicitly does not resell tokens
([README.md:32](https://github.com/pingdotgg/t3code/blob/main/README.md#L32)). Our Baseten and Modal
credits are shared and finite, so a harness idea is only adoptable if it reduces or bounds spend and
can be proven offline. This is why the recommendations below are contracts, preflights, and
classification seams, not a multi-provider router.

---

## 1. What T3 Code does

### 1.1 Shape and stack

T3 Code is an open-source control plane for coding agents. The server owns provider processes,
terminals, Git, and project files; web, desktop, and mobile clients control it over authenticated
RPC and render the same threads
([docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)).
It drives Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx,
and any ACP agent ([README.md:28](https://github.com/pingdotgg/t3code/blob/main/README.md#L28)).

The stack is TypeScript in a monorepo (`@t3tools/monorepo`), with Effect as the server's
service/effect layer: `apps/server` depends on `effect`, `@effect/platform-node`, and
`@effect/vitest`. Server features are Effect services; transports decode, call one service method,
and map typed errors
([docs/internals/effect-services.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/effect-services.md)).
This is architecturally useful, but it is not an argument to introduce Effect into our worker.

Orchestration v2 is event-sourced with an outbox:

- `Orchestrator` serializes commands and decides events without doing provider or filesystem work.
- `EventSink` commits events, projections, the accepted command receipt, and outbox effects in one
  database transaction.
- `EffectWorker` performs side effects after that commit and feeds results back into orchestration.
- The event log keeps about a day for reconnect replay; projections are the source of truth; a
  client whose cursor is too old resumes from a snapshot.

Source: [docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md),
[apps/server/src/orchestration-v2/EffectWorker.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectWorker.ts).

### 1.2 Provider abstraction

The boundary is `ProviderAdapterV2`:

- A **driver kind** identifies an integration; an **instance** identifies one configuration and
  account lifecycle. Work is routed by instance so two accounts using the same driver do not share
  mutable session or catalog state
  ([docs/internals/providers.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md)).
- The adapter exposes `getCapabilities` and `openSession`; the session runtime exposes
  `ensureThread`, `resumeThread`, `injectHistory`, `startTurn`, `compactThread`, `steerTurn`,
  `applyModelSelection`, `interruptTurn`, `stopSubagent`, `unloadThread`,
  `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, and `forkThread`. Optional
  methods are guarded by capabilities
  ([ProviderAdapter.ts:692-812](https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/ProviderAdapter.ts#L692-L812)).
- There are two integration shapes: ACP registry entries (no per-agent handling) and native
  adapters for protocols that need more. Provider-specific behavior stays in the adapter, not in
  orchestration or clients
  ([docs/internals/adding-a-provider.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/adding-a-provider.md),
  [docs/user/providers-acp.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md)).
- Setup must not happen as a health-check side effect; updates run only through the installer that
  owns the binary; adapters are proved with recorded transcript replays.

### 1.3 Capability negotiation

Capabilities are typed, versioned, and emitted by the adapter at session start. The groups are
sessions, threads, turns, streaming, tools, approvals, planning, subagents, context, checkpointing,
and identity. Orchestration and clients read capabilities, never the driver kind. Degradation is a
policy decision, not a provider-name conditional: if model switching is unsupported, start a new
provider session; if forking is unsupported, fall back to portable context handoff; if terminal
status is weak, infer it and mark the correlation weak
([docs/orchestration-v2/provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-capability-system.md)).

Two details are directly applicable to us:

- **Honesty is a contract.** A capability left on that fails at runtime is a bug
  ([docs/internals/adding-a-provider.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/adding-a-provider.md)).
- **Capabilities drive the UI.** The client hides actions the provider cannot perform instead of
  offering them and failing later.

### 1.4 Model selection, switching, and handoff

Model selection is a value, not an environment variable:

- `ModelSelection { instanceId, model, options[] }`, with option descriptors for effort, context
  window, fast mode, variant, and similar toggles; helpers compare selections, normalize aliases,
  and resolve custom models
  ([packages/shared/src/model.ts](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/model.ts)).
- A bundled model manifest allows offline startup; a fetched manifest can update metadata between
  releases. A newer bundle wins by `updatedAt`, not fetch time. Entries can require a minimum
  provider version (`minVersion`, `updateRequiredModels`). Providers read the catalog through a
  `ModelCatalog` port, never the manifest directly
  ([docs/internals/model-manifest.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/model-manifest.md)).

Provider switching is a first-class operation on one app thread. The app thread is canonical; each
provider has a native provider-thread handle with explicit coverage. The default when returning to
a provider is to **resume that provider's previous thread and inject a delta summary** of the runs
that happened while it was inactive. A fresh thread plus a full summary is the fallback when resume
fails or the old context is stale
([docs/orchestration-v2/provider-switching-and-context.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-switching-and-context.md)).

Handoffs are explicit, auditable graph data, not hidden prompt concatenation. The same primitive
(thread relationship + source point + optional context transfer) also covers forks, merge-back, and
subagents
([docs/orchestration-v2/thread-lineage-and-context-transfer.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/thread-lineage-and-context-transfer.md)).
Portable handoffs are textual summaries, not native state: each item is compacted to at most 240
characters, and native session, tool, approval, and omitted text are not reconstructed
([docs/internals/context-handoffs.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/context-handoffs.md)).

### 1.5 Parallel execution and isolation

- Each thread can work in its own worktree; the user can also start an additional thread in an
  existing worktree ([README.md:36](https://github.com/pingdotgg/t3code/blob/main/README.md#L36),
  [docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)).
- To send one prompt to several models, Shift-clicking models starts a separate thread and
  worktree per model
  ([docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)).
- The effect worker defaults to four concurrent workers, waits up to 30 seconds for a slot, and
  blocks effects that are tied to the same thread while allowing other threads to proceed
  ([EffectWorker.ts:959-1035](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectWorker.ts#L959-L1035)).
- Effects retry up to five attempts with `min(30_000, 100 * 2^(attempt-1))` milliseconds of
  backoff, and cancellation is observed through the outbox
  ([EffectWorker.ts:719](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectWorker.ts#L719),
  [EffectWorker.ts:901](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectWorker.ts#L901)).
- Checkpoints use hidden Git refs to capture workspace state without adding commits to the user's
  branch; a rollback coordinates filesystem state with the provider conversation
  ([docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)).

### 1.6 Streaming and multiple clients

Clients share one connection owner per environment (`packages/client-runtime`). The supervisor owns
transport retry with jittered exponential backoff capped at five minutes; authentication failures
and offline states wait rather than burning attempts. Transport health and data freshness are
separate concerns; cached projections remain readable offline and must not overwrite newer live
data. Thread subscriptions send only what one thread needs, and reconnect replay uses cursors and
snapshots
([docs/internals/connection-runtime.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md),
[docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)).

### 1.7 What is directly reusable, and what is not

**Reusable shapes:**

- Adapter boundary with capabilities, model descriptors, and optional session methods.
- Capability-honest degradation instead of provider-name branches.
- Typed normalization of provider errors/events at the adapter boundary.
- Per-key serialization (T3 Code uses thread; we would use repository+branch).
- Bounded retry with cancellation and an explicit attempt budget.
- Event log with cursor/replay semantics, separate from projections.
- Prompt/context budgeting and explicit handoff artifacts.

**Not directly reusable:**

- Local CLI process management, installers, ACP registry, and per-account process isolation. We call
  a hosted HTTP model; there is no local agent process to own.
- Multi-provider switching and handoff. That is a product and cost decision first; our current
  decision is one inference model, and a handoff summarizer would itself spend tokens.
- Native provider session resume, rollback, and fork. Our unit of work is a task, not a
  user-controlled thread, and our filesystem rollback would need a provider-conversation contract
  we do not have.
- Remote model manifests and model option descriptors. They add moving parts before we have a
  second model or a picker.
- An Effect rewrite. The useful part is the command/event/outbox separation, not the runtime.

---

## 2. Our harness today

The current path is simple and deliberately imperative:

1. **Submission.** The web control plane accepts `repositoryId`, `branch`, `goal`, acceptance
   criteria, `fileOwnership`, and a turn/repair/timeout budget. There is no model or provider field
   ([apps/web/src/features/tasks/contracts.ts:17-53](../apps/web/src/features/tasks/contracts.ts)).
2. **Queue.** A task becomes a durable `jobs` row; claiming is one `UPDATE ... FOR UPDATE SKIP
   LOCKED` statement with the attempt counter owned by the database
   ([packages/db/src/repositories/queue-repository.ts:130-143](../packages/db/src/repositories/queue-repository.ts)).
3. **Worker pool.** A worker process runs up to `maxConcurrency` jobs (worker cap 16, shared
   default 4), each with its own lease, heartbeat, abort signal, and hard timeout
   ([apps/worker/src/config.ts:22-27](../apps/worker/src/config.ts),
   [apps/worker/src/loop.ts:119-129](../apps/worker/src/loop.ts),
   [apps/worker/src/loop.ts:272-295](../apps/worker/src/loop.ts)).
4. **Execution.** The handler loads task context, takes a per-organization+repository+branch row
   lease, provisions one sandbox, clones the repository, creates the isolated branch, wires
   policy-gated tools, and runs `max_agent_turns` bounded turns
   ([apps/worker/src/task-execution-handler.ts:1080-1194](../apps/worker/src/task-execution-handler.ts),
   [apps/worker/src/task-execution-handler.ts:1997-2018](../apps/worker/src/task-execution-handler.ts),
   [packages/db/src/repositories/branch-lock-repository.ts:222-233](../packages/db/src/repositories/branch-lock-repository.ts)).
5. **Model.** The runtime is a thin Mastra adapter around one `@mastra/core` Agent. It calls
   `agent.generate()` once per turn with `maxSteps` and `maxOutputTokens`, maps provider-reported
   usage, and accumulates tokens
   ([packages/mastra/src/agents/runtime.ts:238-320](../packages/mastra/src/agents/runtime.ts)).
6. **Accounting and teardown.** Usage is persisted per model call through `UsageSink`; sandbox
   wall time is persisted on destroy; the branch lease is released in `finally`
   ([apps/worker/src/task-execution-handler.ts:1032-1055](../apps/worker/src/task-execution-handler.ts),
   [apps/worker/src/task-execution-handler.ts:1961-1969](../apps/worker/src/task-execution-handler.ts),
   [packages/shared/src/types/usage.ts:15-32](../packages/shared/src/types/usage.ts)).

What is already strong and should not be traded away:

- Deny-by-default tool registry and risk-table policy; sensitive actions require a persisted
  approval, destructive actions are denied
  ([packages/mastra/src/tools/registry.ts:24-28](../packages/mastra/src/tools/registry.ts),
  [packages/mastra/src/tools/policy.ts:129-159](../packages/mastra/src/tools/policy.ts)).
- Approvals are bound to a payload SHA and resumed by a follow-up job, not by trusting a model
  ([apps/worker/src/task-execution-handler.ts:2047-2076](../apps/worker/src/task-execution-handler.ts)).
- Usage is reported by the provider, cost comes from a trusted price table, and an unknown price is
  `null`, never a guess
  ([packages/mastra/src/agents/baseten.ts:85-130](../packages/mastra/src/agents/baseten.ts)).
- One sandbox per job, egress allowlists, and argv/timeout/output caps in the command policy.

The rest of this study is about gaps that are real *for this harness*, not gaps in T3 Code's
product.

---

## 3. Gap table

| Area | T3 Code approach | Our current approach (`file:line`) | Concrete change | Effort / risk |
|---|---|---|---|---|
| Provider boundary | `ProviderAdapterV2` service; driver kind vs instance; `getCapabilities` + `openSession`; session runtime with optional methods (`ProviderAdapter.ts:692-812`) | One narrow `CodingAgentRuntime` (`id`, `name`, `runTurn`) at `packages/mastra/src/agents/types.ts:98-111`; provider chosen by an if/else at `apps/worker/src/runtime-composition.ts:331-344` | Introduce a static registry keyed by provider id with a model descriptor and capability record; keep `runTurn` as the first method | S–M / low |
| Capability negotiation | Typed, versioned capability groups; policy-driven degradation; UI reads capabilities, never driver kind | No capability type in `@isolate/mastra`; tools are always wired and `generate` is always used (`runtime.ts:238-320`); no feature is announced as unsupported | Add `ProviderCapabilities` + `ModelDescriptor`; worker rejects a feature request the descriptor does not support; no new provider | S / low |
| Model selection | `ModelSelection {instanceId, model, options[]}`; descriptors for effort/context/variant; catalog + manifest | Deployment env picks provider and model (`runtime-composition.ts:331-344`); model is hard-bound in `defineCodingAgent` (`types.ts:151-211`); submission has no model field (`apps/web/src/features/tasks/contracts.ts:17-53`); `TaskContext` has no model (`types.ts:20-50`) | Add an optional, validated `model` descriptor to the task contract, defaulting to the deployment model; keep it closed to the two configured models | M / medium |
| Multi-model switching | Same app thread can contain runs from multiple providers; resume prior thread + delta summary; explicit handoff artifacts (`provider-switching-and-context.md`) | One runtime per job; one prompt built once and repeated (`task-execution-handler.ts:1074-1194`); no thread relationship, no handoff; `resume_task` is an approval follow-up, not a provider-session resume (`queue-repository.ts:19-24`, handler:2047-2076) | Do not implement now. Define the relationship/transfer contract only if multi-model is funded and a summarizer budget is authorized | XL / high |
| Session / thread state | `ensureThread`, `resumeThread`, `injectHistory`, `compactThread`, `steerTurn`, `interruptTurn`, `readThreadSnapshot`, `rollbackThread`, `forkThread` | Runtime only has `runTurn`; every turn repeats the same prompt; no provider session reference is persisted across jobs (`types.ts:98-111`) | Persist an optional `providerSessionRef` on the task attempt, but do not claim resume until an adapter can honor it; add `interrupt` semantics through the existing abort signal | M / medium |
| Streaming | Typed stream events for assistant text, reasoning, tool output, and plans; capability-gated (`provider-capability-system.md`) | `agent.generate()` is non-streaming (`runtime.ts:256`); only `agent.turn_started` / `agent.turn_finished` are recorded (`task-execution-handler.ts:1139-1185`) | Add an `onDelta` seam and a `agent.stream` path behind a default-off flag; coalesce and redact deltas; keep persisted events turn-level | L / medium |
| Parallel execution / isolation | Worktree per thread; multi-model prompt starts one thread+worktree per model; per-thread effect serialization; worker concurrency 4 | One sandbox per job (`task-execution-handler.ts:933-934`); clone into `workspaceRoot/repo` (`:946-958`); DB row lease per org+repo+branch (`branch-lock-repository.ts:222-233`); worker pool up to 16 (`config.ts:22-27`, `loop.ts:119-129`); queue `SKIP LOCKED` (`queue-repository.ts:130-143`) | Keep sandbox-per-task (stronger isolation than a shared worktree); add an in-process keyed mutex so one worker does not claim several jobs for the same branch and then requeue them | S / low |
| Concurrency / retry | Effect worker concurrency 4; 30 s slot wait; max 5 attempts; `min(30 s, 100 ms * 2^(n-1))` backoff; cancellation observed | Job pool and queue retry (`min(2^attempts, 300 s)`, max attempts in DB) (`queue-repository.ts:93-94`, `:154-165`); unknown handler errors retry as `INTERNAL`; provider errors are not typed (`task-execution-handler.ts:670-700`) | Add a pure provider-failure classifier and a bounded retry decision; default automatic model retry to 0; never retry after usage has been recorded | M / medium |
| Event log / multi-client | EventSink transaction + projections + outbox; event log ~1 day; per-thread subscriptions; replay cursor; snapshot when pruned | Append-only `run_events` (`execution-lifecycle.ts:79`, `workflow-run-repository.ts:66-70`); web reads durable rows and polls (`apps/web/src/features/runs/queries.ts:24`, 10 s stale time); no SSE, cursor, replay, or retention found | Add `afterEventId` cursor reads now; keep SSE and retention as design-only until a data-retention policy exists | M / low–medium |
| Approvals | Per-capability approvals; native request ids; live-only callbacks; subagent approvals; runtime request response | Risk-table policy + deny-by-default registry (`policy.ts:129-159`, `registry.ts:24-28`); sensitive actions require a persisted approval; push/PR approval is payload-SHA-bound and resumed by a job (`handler:2047-2076`) | Keep our model. Do not adopt live-only approval callbacks; they are weaker than a persisted approval bound to a payload hash | n/a / low |
| Context budgeting | Context-window descriptors, compaction, handoff character caps (`model.ts`, `context-handoffs.md`) | Caps are output-per-turn and cumulative task tokens (`types.ts:88-95`, `runtime.ts:239-244`, `handler:1129-1136`); no prompt/context-window preflight | Add optional `contextWindowTokens` to the descriptor; estimate prompt size conservatively and fail before the call when it cannot fit; skip when no window is configured | S / low |
| Model catalog | Bundled + remote manifest; `updatedAt` precedence; `minVersion`; `ModelCatalog` port (`model-manifest.md`) | Model ids are env/config constants (`baseten.ts:11-14`, `meta.ts:12-13`); price table is injected separately (`baseten.ts:85-130`) | Start with a static in-code catalog; remote manifest stays design-only | S / low |
| Error normalization | Adapter normalizes provider protocol into typed events/errors; capabilities describe weak terminal status | Usage and tool names are mapped defensively (`runtime.ts:160-211`), but provider failures bubble to `toVerdict` and become `INTERNAL` retries (`handler:670-700`) | Add a pure `classifyProviderFailure` (`rate_limited`, `auth`, `context_overflow`, `timeout`, `unavailable`, `invalid_request`, `unknown`) and map the result to retry/dead-letter | S–M / low–medium |
| Process / account isolation | Driver vs instance; per-instance processes, credentials, catalogs; ACP registry | Single hosted HTTP provider per deployment; no local processes, no per-account state | None. This is not a gap for our architecture | n/a |

---

## 4. Adopt now (offline, no provider keys, no live calls)

These changes are harness-only. They can be implemented, tested with fakes, and merged with
`INFERENCE_PROVIDER=none` and `SANDBOX_PROVIDER=null`. None of them adds a model, enables a paid
call, or changes the one-model decision in [`DECISIONS.md:66-69`](DECISIONS.md).

### P0-1 — Declarative provider/model registry with capability descriptors

**Problem.** Our provider surface is an if/else over `INFERENCE_PROVIDER` and a runtime interface
with three fields. Adding a second model, or honestly telling the UI what the model can do, means
editing several files and relying on comments. T3 Code's adapter boundary shows the durable shape:
identity, capabilities, and optional session methods behind one contract
([ProviderAdapter.ts:692-812](https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/ProviderAdapter.ts#L692-L812)).

**Change.**

1. Add `packages/mastra/src/agents/registry.ts` with:
   - `ProviderCapabilities` limited to what we can honestly set today: `streaming`, `toolCalls`,
     `approvals`, `session`, `context`. Do not invent subagent/planning/checkpoint flags.
   - `ModelDescriptor` with `instanceId`, `providerId`, `modelId`, `contextWindowTokens`
     (nullable), `maxOutputTokens`, `supportsToolCalls`, `supportsStreaming`,
     `supportsReasoning`, and `priceKey`.
   - A static `MODEL_CATALOG` containing exactly the current two models:
     `meta` / `muse-spark-1.3-contributor` and `baseten` / `meta-models/muse-spark-open-1026`.
   - `resolveModelDescriptor(providerId)` that fails closed on an unknown provider.
2. Refactor `selectRuntimeFactory` (`apps/worker/src/runtime-composition.ts:331-344`) to look up
   the provider in a `Map` and call the same config builder. Preserve the exact current failure
   behavior and message for an unknown provider.
3. Expose `capabilities` on `CodingAgentRuntime` (`types.ts:98-111`), populated by the factory. The
   fake runtime gets an explicit test-only capability record.

**Tests.** Registry lookup for `meta` and `baseten`; unknown provider fails closed; every descriptor
has a non-empty capability record; the existing runtime-factory tests still pass unchanged; a fake
runtime reports capabilities without touching a provider.

**Effort / risk.** S–M (1–2 days) / low. It is a refactor plus new types, with no behavior change.

**Credit guardrail.** No key is read by the registry. Config builders keep their current
`MISSING_CONFIG` behavior. Tests pass synthetic, non-secret env values.

### P0-2 — Prompt/context preflight before a model call

**Problem.** Our caps bound output tokens and cumulative task tokens, but not the prompt size
against the model's context window (`types.ts:88-95`, `runtime.ts:239-244`). A large task context
combined with tool output can produce a call the model cannot accept, after the provider has already
been contacted. T3 Code treats context window as model metadata and budgets accordingly
([model.ts](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/model.ts),
[provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-capability-system.md)).
For a credit-funded provider, a call that cannot fit is pure loss.

**Change.**

1. Extend `AgentTurnCaps` (`types.ts:88-95`) with optional `contextWindowTokens`.
2. In `createMastraAgentRuntime.runTurn`, before `agent.generate`, estimate prompt tokens
   conservatively from UTF-8 bytes (for example `ceil(bytes / 4)`) and require
   `estimatedPrompt + maxOutputTokensPerTurn <= contextWindowTokens`. Throw
   `PlatformError("BUDGET_EXCEEDED", "prompt exceeds configured context window")` before any
   provider call. Do not invent a tokenizer and do not guess a window.
3. Wire the value from an optional `WORKER_MODEL_CONTEXT_WINDOW` in `apps/worker/src/config.ts`
   (positive integer, default unset). Unset means "no preflight", so existing deployments are
   unchanged.
4. Record the rejection in the turn record with a bounded note; do not record usage.

**Tests.** Prompt under the limit; prompt over the limit (assert the fake agent's `generate` was
never called); multibyte prompt; unset window; invalid config rejected at load; abort signal still
wins.

**Effort / risk.** S (0.5–1 day) / low. The estimator is conservative; a false positive is a
fail-closed budget error, not a security or data problem.

**Credit guardrail.** The preflight can only *prevent* a call. It never adds one.

### P0-3 — Typed provider-failure classification and a bounded retry decision

**Problem.** Provider failures are not normalized. An authentication failure, a context overflow,
a 429, and a 500 all surface as a thrown value. The handler treats non-platform errors as
`retry INTERNAL` (`task-execution-handler.ts:670-700`), and the queue retries the whole job up to
the attempt limit. That can spend several sandboxes and several provider calls on an error that will
never succeed. T3 Code normalizes provider failure at the adapter boundary and gives the effect
worker a typed retry decision
([ProviderAdapter.ts](https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/ProviderAdapter.ts),
[EffectWorker.ts:719-901](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectWorker.ts#L719-L901)).

**Change.**

1. Add `packages/mastra/src/agents/failure.ts`:
   - `ProviderFailureKind = "rate_limited" | "auth" | "context_overflow" | "timeout" |
     "unavailable" | "invalid_request" | "unknown"`.
   - `classifyProviderFailure(error)` using structured fields first (`status`, `statusCode`, `code`,
     `name`), then a deliberately small message-pattern fallback. Unknown is non-retryable.
   - `toProviderError(error)` that returns a `PlatformError` with a stable code and
     `retryable` set from the classification: `RATE_LIMITED` for rate limits, `INTEGRATION_UNAVAILABLE`
     for timeout/unavailable, `BUDGET_EXCEEDED` for context overflow, `VALIDATION_FAILED` for an
     invalid request, and non-retryable `AGENT_EXECUTION_FAILED` for auth and unknown.
2. Wrap the `agent.generate` call in `runtime.ts` so the runtime throws the classified
   `PlatformError` instead of an opaque Mastra error. Keep the original error as `cause` only for
   local logging; never serialize it.
3. Add `WORKER_PROVIDER_RETRY_ATTEMPTS` with default `0`. Zero means "classify and fail the turn
   once", which is the current spend behavior. A future authorized phase can raise it for
   `rate_limited`/`timeout`/`unavailable` only.
4. If retries are ever enabled, retry only before usage is recorded and only with the abort signal
   honored. A partially streamed turn is never retried automatically.

**Tests.** A table of synthetic errors maps to the expected kind and retryability; auth and context
overflow never retry; a 429 maps to `RATE_LIMITED`; an unknown error maps to `unknown` and is not
retried; the handler still maps a non-retryable provider error to `dead_letter`; no provider call is
made by the tests.

**Effort / risk.** M (1–2 days) / medium-low. The only real risk is over-broad message matching; the
conservative default (unknown = non-retryable, attempts = 0) contains it.

**Credit guardrail.** The default is no automatic retry. Any future retry budget is an explicit
opt-in and must be justified with measured `usage_records`, not guessed.

### P1-1 — Streaming seam behind a default-off flag

**Problem.** `agent.generate()` returns only when the turn is complete (`runtime.ts:256`), so the
timeline cannot show tokens arriving and a long turn looks idle. T3 Code treats streaming as a
capability with explicit event types
([provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-capability-system.md)).

**Change.** Add an optional `onDelta` callback to `CodingAgentRuntime.runTurn` and a
`WORKER_STREAM_TURNS` flag (default `false`). When enabled and the descriptor says
`supportsStreaming`, call the installed Mastra streaming API, coalesce deltas (for example every
250 ms or 8 KiB), redact with the existing logger/security rules, and emit them to an in-process
sink. Keep persisted events at turn granularity. Record usage exactly once at stream close. Verify
the exact `@mastra/core@1.79.0` stream signature against the installed d.ts before coding, as the
package already does for `generate` (`types.ts:151-162`).

**Tests.** Fake stream yields text and usage; deltas are coalesced and bounded; an aborted stream
does not emit after abort; a non-streaming descriptor falls back to `generate`; usage is recorded
once; the default-off path is byte-for-byte the current behavior.

**Effort / risk.** L (3–5 days) / medium. The risk is Mastra API drift, not security.

**Credit guardrail.** Streaming does not add calls; it changes how one call is observed. Default off
until a UI consumer exists.

### P1-2 — Per-task model selection contract, closed by default

**Problem.** Model choice is deployment-wide. A task cannot say "use the dev model" or replay with
the model that produced it, even though T3 Code's selection is a value carried with the thread
([model.ts](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/model.ts)).

**Change.** Add an optional `model` field to `submitTaskSchema` and `TaskContext`, shaped as
`{ providerId, modelId }` and validated against the static catalog from P0-1. Default `null` means
the deployment model. Add `WORKER_ALLOW_MODEL_OVERRIDE` (default `false`): when false, a non-default
selection is rejected at submission; when true, only catalog entries are accepted. Persist the
resolved selection on the task attempt so a run is reproducible.

**Tests.** Default submission unchanged; unknown provider/model rejected; override disabled rejects
a non-default selection; override enabled accepts only catalog entries; the resolved descriptor is
recorded on the attempt.

**Effort / risk.** M (1–2 days) / medium. The product risk is implying multi-model support before
operations are ready; the default-off flag contains it.

**Credit guardrail.** It enables no new model. It makes the existing choice explicit and auditable.

### P1-3 — In-process keyed serialization for repository+branch

**Problem.** The DB branch lease is correct across workers, but a single worker with
`maxConcurrency > 1` can claim several jobs for the same branch in one poll cycle. All of them load
context, then all but one hit `LOCKED` and requeue (`task-execution-handler.ts:2001-2015`). That is
wasted work and noisy retries. T3 Code serializes effects per thread while allowing other threads to
run (`EffectWorker.ts:955-1035`).

**Change.** Add `createKeyedMutex()` in `apps/worker/src` and a key from the normalized
`organizationId:repositoryId:branch`. Acquire before `runWithSandbox`; if the key is held, return the
same bounded `DEPENDENCY_CONFLICT` retry the DB lease already uses. Release in `finally`. The DB row
lease remains the cross-worker source of truth; the mutex is only a same-process optimization.

**Tests.** Two concurrent jobs on one key: one runs, one retries; different keys run concurrently;
release on throw and on abort; the mutex does not replace or weaken the DB lease.

**Effort / risk.** S (0.5 day) / low.

**Credit guardrail.** It prevents duplicate sandbox provisioning; it cannot increase spend.

### P1-4 — Cursor reads for `run_events`

**Problem.** The web reads durable rows and polls every 10 seconds
(`apps/web/src/features/runs/queries.ts:24`). There is no `afterEventId` read, so a growing timeline
re-reads the same rows and cannot support replay or a future SSE endpoint. T3 Code's reconnect model
is cursor + snapshot, not full re-fetch
([connection-runtime.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md)).

**Change.** Add `listEventsAfter({ organizationId, taskId, after: { occurredAt, id }, limit })` to
`workflow-run-repository.ts` (or the lifecycle reader), ordered by `occurred_at ASC, id ASC` and
tenant-scoped. The current `listEvents` orders by `occurred_at` only
(`workflow-run-repository.ts:70-71`), which is not a stable cursor across equal timestamps; use the
existing `id` column as the tiebreaker rather than adding a schema column. Keep the existing
full-list read for first paint. Do not add SSE in this wave; a polling consumer can use the
composite cursor immediately.

**Tests.** Empty cursor returns from the start; a cursor returns only newer rows; equal timestamps
are handled by the `(occurredAt, id)` tiebreaker without duplicates or gaps; tenant isolation; limit
clamping.

**Effort / risk.** S–M (1 day) / low. This is a read-path change; no schema change is required.

**Credit guardrail.** None needed; it does not touch a provider.

---

## 5. Design-only (do not implement in this wave)

These are recorded so the next wave does not rediscover them, and so nobody mistakes this study for
approval to spend credits. Each requires a product, cost, or data-policy decision first.

### D-1 — Multi-model switching and context handoff

T3 Code's strongest product idea is that one app thread can move between providers while preserving
native provider threads and explicit handoff artifacts
([provider-switching-and-context.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-switching-and-context.md)).
For us this is not a harness refactor; it is a new cost and correctness surface:

- A handoff summary is generated by a model and therefore spends tokens. The current one-model
  decision ([`DECISIONS.md:66-69`](DECISIONS.md)) does not authorize that.
- A portable handoff does not reconstruct native session, tool, approval, or omitted state
  ([context-handoffs.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/context-handoffs.md)).
  We would need to prove that our task invariants (file ownership, approval payload SHA, branch
  lease) survive the transfer.
- The first useful slice is a *deterministic* handoff built from `run_events`, artifacts, and the
  diff, with no model call. Even that should wait until there is a second model.

### D-2 — ACP and external agent drivers

T3 Code's ACP registry is elegant because it turns "add an agent" into a spec entry
([adding-a-provider.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/adding-a-provider.md),
[providers-acp.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md)).
We do not run local agents, and our sandbox is the isolation unit. Adopting ACP would add a second
execution plane and a new credential surface without removing the need for our own policy gate. Not
now.

### D-3 — Subagent orchestration

T3 Code models native and cross-provider subagents as child threads with lifecycle and result
transfers ([thread-lineage-and-context-transfer.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/thread-lineage-and-context-transfer.md)).
Our architecture already plans multi-agent inside one sandbox with disjoint `fileOwnership`
partitions ([ARCHITECTURE.md:124](ARCHITECTURE.md)), and STATUS explicitly says there is no subagent
tree ([`STATUS.md:49`](STATUS.md)). The missing pieces are not the graph types; they are:

- provable disjoint ownership before parallel writes,
- a per-subagent budget and tool gate,
- one combined diff/validation/approval gate,
- an `agentId` on every turn event.

Design the ownership proof and the budget first. The t3code graph shape can be copied once those
exist.

### D-4 — Worktree-per-thread

T3 Code's worktree-per-thread is a good fit for a user who wants to explore a branch without
disturbing their checkout ([README.md:36](https://github.com/pingdotgg/t3code/blob/main/README.md#L36),
[thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)).
Our equivalent is a fresh sandbox plus an isolated branch. That is stronger isolation at a higher
provisioning cost. A shared bare-repo cache or a worktree inside one sandbox would reduce clone cost,
but it would also weaken the "one task, one sandbox" property that makes teardown and egress simple.
Revisit only if sandbox provisioning becomes the dominant latency or cost.

### D-5 — Remote model manifest and option descriptors

The bundled/remote manifest with `updatedAt` precedence and `minVersion` is well designed
([model-manifest.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/model-manifest.md)).
It solves a problem we do not have yet: a large catalog that changes between provider releases. A
static catalog (P0-1) is sufficient until there are several models or a picker. Do not add a remote
fetch to the worker boot path.

### D-6 — SSE, replay, and multi-client projections

T3 Code's per-thread subscriptions, replay cursors, and shared connection runtime are the right
answer for many clients
([connection-runtime.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md)).
We should earn that complexity in stages: (1) cursor reads, (2) a single SSE endpoint with
`Last-Event-ID`, (3) a shared client cache. We do not need projections or a separate command log
because `run_events` is already append-only. Do not put token deltas into durable events; persist
turn boundaries and stream deltas live.

### D-7 — `run_events` retention and compaction

T3 Code keeps about a day and prunes behind its projections
([overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)). We found no
retention or pruning for `run_events`. Before deleting audit history, decide what the execution map,
incident review, and customer audit actually require. A configurable retention window with a
tenant-scoped prune is likely, but it is a data-policy decision, not a harness refactor.

### D-8 — Native provider session resume, rollback, and fork

These are real T3 Code capabilities and they are not available from an OpenAI-compatible
`generate` call. Adding them would require a provider that exposes a conversation handle and a
contract for reconciling it with our filesystem branch. Our current `resume_task` is correctly an
approval follow-up, not a conversation resume. Keep that distinction.

### D-9 — Pause a turn for an approval

T3 Code's `respondToRuntimeRequest` lets a live turn wait for a human
([ProviderAdapter.ts:780-790](https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/ProviderAdapter.ts#L780-L790)).
Our model receives a structured denial and continues; the task-level push/PR approval is a separate
job. A pause-and-resume turn is a larger state-machine change and would need a durable pending-turn
record. Design-only.

---

## 6. Guardrails and non-goals

- **No keys.** None of the P0/P1 work requests, reads, or provisions `BASETEN_API_KEY`,
  `MODAL_TOKEN_ID`, or `MODAL_TOKEN_SECRET`. All tests use fakes and synthetic non-secret values.
- **No live calls.** No recommendation requires a provider request. The live acceptance checklist in
  [`AGENTS.md`](../AGENTS.md) remains the only path to a keyed run, and it is not part of this study.
- **No new model.** The one-inference-model decision stands
  ([`DECISIONS.md:66-69`](DECISIONS.md)). P1-2 makes the existing choice explicit; it does not add a
  second model.
- **No weaker boundary.** Sandbox-per-task, egress allowlists, deny-by-default tools, payload-SHA
  approvals, and per-call usage records are non-negotiable. Do not trade them for T3 Code's
  local-process model.
- **No Effect rewrite.** Adopt the command/event/outbox *separation* only if the worker needs it;
  do not adopt the runtime.
- **No speculative UI.** Streaming and model selection are contract seams first. Do not ship a
  picker or a token-by-token timeline before the descriptors and the read path exist.

Suggested metrics after the P0/P1 work:

- provider failures by `ProviderFailureKind`, and the retry/dead-letter split;
- prompt preflight rejections (should be rare, and should trend to zero as prompts are tuned);
- tokens and cost per task from `usage_records`, split by model;
- duplicate branch-lock misses per worker (should fall after P1-3);
- event read lag and rows re-read per poll (should fall after P1-4);
- p95 turn latency with streaming on vs off.

---

## 7. Executive summary

1. T3 Code is a TypeScript + Effect control plane that owns local agent processes and exposes them
   to many clients; it does not resell tokens, so its economics are not ours.
2. Its durable ideas are a typed adapter boundary, honest capability negotiation, a first-class
   model selection value, explicit context handoffs, and per-thread effect serialization.
3. Our harness is a hosted, single-model task runner with stronger isolation and approvals: one
   sandbox per job, a DB branch lease, deny-by-default tools, and payload-SHA approvals.
4. The largest real gaps are provider/model descriptors, prompt-context preflight, and typed
   provider-failure classification; all three can be closed offline with fakes.
5. P0-1 adds a static provider/model registry and capability descriptors, replacing the if/else
   without adding a provider or a key.
6. P0-2 rejects a prompt that cannot fit the configured context window before the model is called,
   protecting credit-funded calls.
7. P0-3 classifies provider failures and defaults automatic retries to zero, so a non-transient
   error no longer burns several job attempts and sandboxes.
8. P1 adds a default-off streaming seam, a closed per-task model-selection contract, in-process
   branch serialization, and cursor reads for `run_events`.
9. Multi-model handoff, ACP, subagents, worktrees, remote manifests, SSE replay, and native session
   resume are design-only; each needs a product, cost, or data-policy decision first.
10. Adopt the contract shapes and the preflights now; do not copy T3 Code's multi-provider machinery
    or its Effect runtime.
