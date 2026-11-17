# Benchmark plan — connector intake and evidence pipeline

**Replay evidence (2026-11-17):** the integrated wave-28 branch passes all 24
connector scenarios twice with zero provider calls. The cached ITBench-AA
Scenario-16 replay retains entity recall 1.00 and decisive-token recall 1.00,
full condition-token recall 0.29, 3 items / 1,077 bytes, and deterministic digest
`6e05b5e44139b69e`. These numbers measure evidence extraction with fakes/snapshots;
they do not measure model success, production incident resolution or live SaaS
performance. No paid benchmark was run.

Status: wave 25 planning artefact plus an executable offline harness.
Owner: benchmark task branch. No provider credential is read, requested or used.

## What "benchmarking our project" means here

`isolate-platform` is two different systems, and they need different benchmarks:

1. **The deterministic pipeline.** A signed webhook is detected, verified,
   normalized to an `IncidentSignal`, deduped, checked against the trigger
   policy / autonomy level / per-org cap, and submitted as a durable task. Later,
   the task's incident fingerprint selects one connector reader, which assembles
   a bounded, redacted `ContextBundle`. None of this needs a model, a sandbox or
   a vendor key. It can be measured exactly, offline, on every commit.
2. **The agent.** An LLM plans turns, edits a repository in a sandbox, runs
   validation, and optionally opens a PR. This needs a paid inference provider
   and (for most connectors) a real vendor API or a paired device. It can only
   be measured in an explicitly approved keyed wave.

The executable harness in `scripts/bench-connectors.ts` benchmarks layer 1. It
does not pretend to score layer 2. The metrics table below says which layer each
number belongs to and how layer 2 would be measured when it is authorised.

## Benchmark repository comparison

| Repository | URL | What it measures | Offline / cheap with fakes? | Fit for this project |
| --- | --- | --- | --- | --- |
| SWE-bench | https://github.com/swe-bench/SWE-bench | Resolves real GitHub issue/PR pairs by applying a patch and running the repo's tests (2,294 instances in the original set). | No: Docker per instance, repo environments, and model calls. Harness ideas only. | External comparability for the agent, not the connector pipeline. |
| SWE-bench-Live | https://github.com/microsoft/swe-bench-live | Same task shape, continuously refreshed; the Lite split is 300 recent, uncontaminated instances. | No: containers, network and model calls. | Best external regression signal for coding quality; run on an approved keyed wave. |
| mini-SWE-agent | https://github.com/SWE-agent/mini-swe-agent | A ~100-line agent scaffold on SWE-bench; isolates model quality from harness complexity. | Partly: the scaffold runs locally, but grading still needs repos/tests and inference. | Useful control baseline; confirms our agent's score is not harness theatre. |
| terminal-bench | https://github.com/laude-institute/terminal-bench (now https://github.com/harbor-framework/terminal-bench-1) | Containerised terminal tasks (setup, debugging, file edits) with task-level pass/fail. | No: Docker/Harbor and model calls. | Closest public proxy for our sandbox/tool-use loop; adopt for sandbox regressions. |
| Aider polyglot | https://aider.chat/docs/leaderboards/ (harness: https://github.com/Aider-AI/aider) | 225 Exercism exercises across C++, Go, Java, JavaScript, Python and Rust; edit-format and pass-rate. | No: Exercism fixtures are local, but grading is language toolchains plus model calls. | Useful only if we expand beyond TypeScript; not a product-shape match today. |
| SWE-smith | https://github.com/SWE-bench/SWE-smith | Generates synthetic bugs at scale by mutating real repos, then measures whether an agent fixes them. | Task generation can run locally; execution/grading needs environments and inference. | Best way to build a private, repo-local resolution benchmark without leaking our history. |
| AgentBench | https://github.com/THUDM/AgentBench | Multi-environment agent ability (OS, DB, knowledge graph, card games, web). | No: multiple service backends. | Too broad; not incident-shaped. |
| OSWorld | https://github.com/xlang-ai/OSWorld | 369 real computer-use tasks in VMs, judged by execution scripts. | No: VM images and GUI control. | Out of scope (we do not drive a desktop). |
| AIOpsLab | https://github.com/microsoft/AIOpsLab | End-to-end AIOps lifecycle: detect, diagnose and mitigate faults in a microservice deployment; benchmark suite is interactive. | No by default: Kubernetes cluster plus an LLM. | Strong domain match; candidate for a cluster-backed incident campaign. |
| ITBench | https://github.com/itbench-hub/ITBench | Real-world IT automation and incident scenarios in Kubernetes, with remediation scoring. | No: Kubernetes environments. | Domain match for SRE scenarios; heavier than our current acceptance setup. |
| OpenRCA | https://github.com/microsoft/OpenRCA | Root-cause localisation over telecom, bank and market telemetry datasets (component, reason, time). | Partly: datasets are downloadable; baseline/oracle runners exist, but answering needs a model. | Good for evidence-quality research; not a pipeline regression gate. |
| ai-incident-response-benchmark | https://github.com/VishakhaVB/ai-incident-response-benchmark | On-call SRE behaviour under noisy alerts, misleading signals and partial context. | Small and scriptable; model calls still dominate. | Closest scenario vocabulary to ours; useful prompt-design reference. |
| DevSecOps / SRE evals generally | No single standard repository as of this plan | Vendor evals (Datadog, PagerDuty, Grafana) are not reproducible benchmarks; academic work is split across AIOpsLab/ITBench/OpenRCA. | Not applicable. | Do not adopt a "DevSecOps benchmark" claim; cite the three named suites instead. |

## Chosen approach

Two layers, adopted in this order:

1. **Adopt now — offline connector benchmark (`scripts/bench-connectors.ts`).**
   It drives production seams with fakes:
   - signed webhook → `acceptIncident` → the real per-mode verifier/normalizer
     (`github`, `sentry`, `grafana`, `pagerduty`) or the signed generic bridge
     (`datadog`, `newrelic`, `honeycomb`, `axiom`, `signoz`, `kubernetes`);
   - the real 30-minute dedupe store, per-org cap, managed subscription
     pipeline and autonomy gate;
   - the real `createTaskService` + in-memory task/queue/compilation stores, so
     a task and its queue job are actually created;
   - the real connector readers (`fetchGitHubIncidentContext`,
     `fetchSentryContext`, `fetchGrafanaContext`, `fetchPagerDutyContext`,
     `fetchDatadogContext`, `fetchNewRelicContext`,
     `fetchHoneycombIncidentContext`, `fetchAxiomIncidentContext`,
     `fetchSignozContext`, `fetchKubernetesContext`) with injected transport;
   - the real worker `createConnectorContextLoader` refusal path when no device
     or signal exists.
2. **Adopt with approval — agent-resolution benchmarks.**
   Freeze a private set of SWE-smith-style bugs generated from this repository
   (SWE-smith is the generator, the tasks stay local) and, separately, a
   SWE-bench-Live Lite slice for external comparability. Grade with the repo's
   own gates (`bun run validate`) inside the sandbox. Run only in a bounded,
   keyed acceptance wave with caps, then record spend from `usage_records`.

Deliberately not adopted: OSWorld/AgentBench (wrong shape), Aider polyglot
(mostly non-TypeScript, edit-format specific), and any claim of a standard
"DevSecOps benchmark" (none exists).

## Scenarios in the offline harness

24 scenarios, all with fabricated secrets and synthetic payloads:

- **Intake (13):** `github-workflow-failure`, `sentry-issue-created`,
  `grafana-firing-alert`, `pagerduty-triggered`, generic-bridge for `datadog`,
  `newrelic`, `honeycomb`, `axiom`, `signoz`, `kubernetes`,
  `bad-signature-rejected`, `replay-deduped`, `autonomy-a1-unsupported`.
- **Evidence (11):** one bundle per connector above (GitHub included), plus
  `empty-device-degrades`, which proves the loader returns `null` and enqueues
  no call when no device/signal exists.

Each scenario reports pass/fail, task and job counts, evidence item count,
excerpt bytes, an estimated token count, item kinds and a stable SHA-256 digest
of kinds + excerpts. The digest excludes `fetchedAt`, URLs, task ids and all
wall-clock values, so two runs compare byte-for-byte.

Run:

```bash
bun scripts/bench-connectors.ts                 # offline; zero keys
BENCH_LIVE=1 bun scripts/bench-connectors.ts    # prints "skipped: live mode requires explicit approval"
bun test scripts/bench-connectors.test.ts       # determinism + coverage
```

## Metrics

| Metric | Layer | How it is measured | Offline today |
| --- | --- | --- | --- |
| Intake → task latency | pipeline | Monotonic timer around `acceptIncident` (in-process, queue-backed submission). Excluded from the compared JSON because it is not deterministic; reported separately when a wall-clock run is wanted. | Yes, but not in the digest |
| Evidence bundle items / bytes / tokens | pipeline | Real reader output: item count, UTF-8 bytes of excerpts, `ceil(bytes / 4)` token estimate. | Yes |
| Dedupe / cap / autonomy decisions | pipeline | Result shape and delivery-ledger reason (`AUTONOMY_LEVEL_UNSUPPORTED`, `DUPLICATE_DELIVERY`, throttled) plus task/job counts. | Yes |
| Turns to diff | agent | Count `run.turn` events until the first workspace diff; requires the worker loop and a model. | No |
| Validation pass | agent | `bun run validate` exit code and per-gate results inside the sandbox, captured as lifecycle artifacts. | No (fakes can assert the path, not the result) |
| PR outcome | agent | Merge/open/closed state and review comments of the created PR; needs the GitHub App and a real repository. | No |
| Token spend | agent | Sum of `usage_records.prompt_tokens` / `completion_tokens` and computed cost; never estimated silently. | No |
| Sandbox lifetime / teardown | agent | `created_at` → `destroyed_at`, plus a zero-running-sandbox assertion. | No |

## Baseline (offline, fixture-defined)

These are pipeline-shape numbers from the synthetic fixtures, not quality
claims. They establish the comparison baseline for future reader changes.

| Evidence scenario | Items | Excerpt bytes | Est. tokens |
| --- | --- | --- | --- |
| github | 10 | 943 | 236 |
| sentry | 4 | 1,038 | 260 |
| grafana | 3 | 503 | 126 |
| pagerduty | 3 | 548 | 137 |
| datadog | 4 | 920 | 230 |
| newrelic | 2 | 407 | 102 |
| honeycomb | 3 | 324 | 81 |
| axiom | 2 | 250 | 63 |
| signoz | 2 | 543 | 136 |
| kubernetes | 5 | 602 | 151 |
| empty-device-degrades | 0 | 0 | 0 |

Intake baseline: every positive scenario creates exactly one task and one queue
job; `bad-signature-rejected` creates none; `replay-deduped` creates one task
across two deliveries; `autonomy-a1-unsupported` records an ignored delivery
with reason `AUTONOMY_LEVEL_UNSUPPORTED` and creates no task.

## What cannot be measured without paid providers

Honest limits:

- **No model quality.** Turns-to-diff, patch correctness, validation pass rate
  and PR acceptance cannot be produced by fakes. They need Baseten or another
  authorised inference provider and a sandbox provider.
- **No sandbox behaviour.** Startup time, tool-call latency, OOM limits,
  cancellation and teardown are only exercised by the sandbox fakes in
  `scripts/acceptance-offline.ts`; real timings need Modal.
- **No token spend.** `usage_records` is populated only by real model calls.
  The offline token estimate is `bytes / 4`, a deterministic planning heuristic,
  not a provider tokenizer.
- **No vendor contract drift.** The connector readers are driven by injected
  fake transports, so the benchmark proves parsing, redaction, caps and
  degradation — not that a live Datadog/New Relic/Honeycomb/Axiom/SigNoz schema
  still matches, nor that app keys/scopes are valid.
- **No device claim/return path.** Datadog, New Relic, Honeycomb, Axiom, SigNoz
  and Kubernetes evidence normally travels through the device call queue; the
  offline harness exercises the server-side reader and the fail-closed loader.
  A live device round-trip needs a paired daemon and is covered by
  `scripts/acceptance-connector-live.ts`, not by this harness.
- **No GitHub write.** PR creation, branch push and review handling require the
  GitHub App and a real installation. The prior measured run
  (`ivory-26/agent-bank#1`, wave 8) is recorded in `project/TASKS.md`.
- **Wall-clock intake latency is not in the compared payload.** It can be
  printed, but including it would make the two-run determinism gate flaky.

## Where live measurements are recorded

`docs/connectors/live-verification.md` exists and is the authoritative log:
thirteen measured live runs (New Relic, Axiom, Kubernetes ×2, Datadog ×3,
Honeycomb ×4, SigNoz ×2) with the task id, evidence call, PR number and
`usage_records` token spend for each, plus the residual gaps. Earlier wave
records remain in `project/TASKS.md` (for example the wave 15 run: 170,818
prompt / 13,101 completion tokens, one 244-second Modal sandbox). A benchmark
result that contradicts the live log is wrong; the live log wins.

## Recommended adoption

1. **Adopt now:** `scripts/bench-connectors.ts` + `scripts/bench-connectors.test.ts`
   as the per-commit regression gate for intake and evidence.
2. **Adopt next (offline task generation):** SWE-smith to generate a private,
   repository-local bug set; keep the tasks and fixtures in-repo.
3. **Adopt for external comparability (keyed):** SWE-bench-Live Lite (300
   instances) and terminal-bench for sandbox/tool-use regressions.
4. **Evaluate later (cluster-backed):** AIOpsLab or ITBench for end-to-end
   incident lifecycle, and OpenRCA for evidence/root-cause quality. **First
   offline alternative (below): ITBench-AA**, which needs no cluster.
5. **Reject:** OSWorld, AgentBench and Aider polyglot as primary benchmarks for
   this product; they measure different surfaces.

## Measured baseline (2026-11-14)

`bun scripts/bench-connectors.ts` run from a directory with no `.env`, so no
provider variable is visible to the process:

```
scenarios=24 passed=24 failed=0 providerCalls=0
evidence/{axiom,datadog,github,grafana,honeycomb,kubernetes,newrelic,pagerduty,sentry,signoz}
intake/{generic-*,github-workflow-failure,grafana-firing-alert,pagerduty-triggered,
        replay-deduped,sentry-issue-created,bad-signature-rejected,autonomy-a1-unsupported}
```

Every connector in the product registry is exercised through the same
`createConnectorContextLoader` the worker binds, and every intake scenario runs
the real signed-delivery path against in-memory repositories. The run refuses to
start while `BASETEN_*`/`MODAL_*` are present (verified: invoking it from the
repo root aborts with `REFUSED: provider environment variables are set`).

## Verified additions (2026-11-15)

A Firecrawl-backed survey (search + page fetch) re-checked every repository
named above and looked for newer ones. Changes to the table above:

- **ITBench-AA is the one runnable, labelled, offline benchmark that matches a
  connector we ship.** [Hugging Face dataset](https://huggingface.co/datasets/ArtificialAnalysis/ITBench-AA)
  publishes per-scenario Kubernetes snapshots plus `ground_truth.yaml`; the
  `sre/Scenario-16` files are a 44.2 MB `k8s_objects_raw.tsv`, a 1.45 MB
  `k8s_events_raw.tsv` and a 1.32 kB `ground_truth.yaml`. No cluster is
  needed, so the "ITBench: No — Kubernetes environments" row above is
  superseded for this variant.
- **`terminal-bench-1` is stale.** Current: [harbor-framework/terminal-bench](https://github.com/harbor-framework/terminal-bench),
  with [Terminal-Bench 3](https://github.com/scaleapi/terminal-bench-3-public)
  and [Terminal-Bench 4](https://artificialanalysis.ai/evaluations/terminalbench-4-0)
  as later generations.
- **Three dedicated SRE/incident benchmarks were missing from this plan**:
  [SREGym](https://github.com/SREGym/SREGym),
  [Incident-Arena](https://github.com/abundant-ai/incident-arena) and
  [ORCA-bench](https://arxiv.org/html/2607.28545v2) (paper only — no
  authoritative code repository was found, so treat it as unreproducible until
  one is confirmed). [OpenRCA 2.0](https://arxiv.org/abs/2606.27154) now has
  500 step-annotated instances.
- **Nothing new measures the nine SaaS connectors** (GitHub, Sentry, Grafana,
  PagerDuty, Datadog, New Relic, Honeycomb, Axiom, SigNoz). That gap is real
  and remains the argument for the contract-replay harness described above.

**Implemented and measured (2026-11-15).** `scripts/bench-itbench-k8s.ts --data <scenario-dir>`
runs the ITBench-AA pilot against the real `fetchKubernetesContext`. Scenario 16
(`otel-demo`, group `shipping-deployment-1` → real `Deployment/shipping`) scores:

| Run | Items | Bytes | `truncated` | Entity recall | Decisive condition token recall | Digest |
|---|---|---|---|---|---|---|
| before the env fix | 3 (pod, deployment, replicasets) | 834 | false | 1.00 | **0.00** | `b0e34180…` |
| after the env fix | 3 (same) | 1,077 | false | 1.00 | **1.00** | `6e05b5e4…` |

Both runs are byte-deterministic across two executions, use no cluster, no
network and no model. The ground-truth condition is `QUOTE_ADDR` set to port
`0000`; the reader rendered replicas, generation and conditions but not the
container env, so the deciding tokens were invisible. `schemas.ts` now models
`spec.template.spec.containers[].env` (literal `value` only — `valueFrom` is
dropped, so a Secret ref can never be resolved) and the deployment excerpt
renders a bounded env line under the rule documented in
[`docs/connectors/kubernetes.md`](../docs/connectors/kubernetes.md) §9.
`packages/integrations/src/kubernetes/context.test.ts` pins the rendering and
the credential suppression.

Original design of the pilot (kept for reference):
`scripts/bench-itbench-k8s.ts --data <cache>` parses the two TSVs
into an index, implements `KubernetesHttpClient` over that index (the interface
in `packages/integrations/src/kubernetes/types.ts` unchanged), calls the real
`fetchKubernetesContext`, and scores two numbers separately — root-cause
**entity recall** and ground-truth **condition token recall** — alongside bytes,
`truncated` and a content digest, run twice for byte equality. One correction
found while implementing: ITBench-AA group ids (`shipping-deployment-1`) are
synthetic labels, and the API name is `shipping`; the pilot resolves a group's
regex filter against the snapshot instead of passing the id to the API. No
model and no provider key is involved; cache the dataset outside the
repo and commit only a namespace-pruned fixture.

## Security and cost posture

The harness refuses to run when `BASETEN_*` or `MODAL_*` variables are present,
never imports a provider SDK, and injects every transport. `BENCH_LIVE` is
inert by design: it prints `skipped: live mode requires explicit approval` and
exits 0 rather than contacting a vendor. A live benchmark requires a separate,
bounded authorisation with mandatory caps (`MAX_TOKENS_PER_TASK`,
`MAX_SANDBOX_SECONDS`, `MAX_COST_USD_PER_TASK`), sequential calls, sandbox
destruction in `finally`, and recorded spend.
