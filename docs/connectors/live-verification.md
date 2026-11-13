# Connector live verification

Observed on 2026-11-13/14 against a local stack (web on `localhost:3000`, Postgres durable queue on Neon, worker, and the paired `Verification relay` device) and the fixture repository `ivory-26/isolate-e2e-fixture`. Every delivery below is a real signed-bridge request; every evidence call is a real device-to-provider request.

## How a run is made

1. An enabled integration subscription for the connector (Trigger rules on `/integrations/<id>`) points at `ivory-26/isolate-e2e-fixture`, environment `production`, minimum severity `high`, event kinds empty (connector default), autonomy A2.
2. The web server runs with `DEVICE_GATEWAY_ENABLED=true` and a per-run `WEBHOOK_BRANCH`.
3. A synthetic `IncidentSignal` for `source: <vendor>` is POSTed to `/api/webhooks/<vendor>` signed with HMAC-SHA256 over `<timestamp>.<body>` (`WEBHOOK_SIGNING_SECRET`, `x-isolate-timestamp`, `x-isolate-signature: sha256=<hex>`). A `202` carries `{taskId, jobId, deduped}`.
4. The worker — **also started with `DEVICE_GATEWAY_ENABLED=true`** — loads the normalized signal row, enqueues exactly one `<source>.context.fetch` call with `{incidentFingerprint, service, kind}`, the paired relay executes it against the vendor, and the bundle is attached to the task context. Any failure degrades to "no evidence" and the task still runs.
5. A2 pauses before the push; approving the push (and later the pull request) in `/approvals` lets the resume job clone, fix the fixture's three bugs, pass `bun test`, push the task branch and open the PR.

## Results

| Vendor | Fingerprint | Task | Evidence call | PR | Outcome |
|---|---|---|---|---|---|
| New Relic | `newrelic:4180be0c…3fc3:run2` | `0f0f772c` | `newrelic.context.fetch` completed 2,044 ms, 1 item, truncated | #4 | **complete** — evidence + PR |
| Honeycomb | `honeycomb:test:e2e-trigger:triggered` | `8dfe6955` | `honeycomb.context.fetch` failed `INTEGRATION_UNAVAILABLE` twice (4.9 s, 7.4 s); agent `honeycomb.get_trigger` returned `NOT_FOUND` | #5 | **complete** intake → branch → PR, **no evidence** (zero datasets) |
| Axiom | `axiom:e2e-monitor` | `1e0c62e2` | `axiom.context.fetch` completed twice (7.7 s, 54.6 s end-to-end), 1 item, truncated | #6 | **complete** — evidence + PR |
| Kubernetes (run 1) | `k8s:kind-isolate-demo:isolate-demo:pod/crash-demo:ImagePullBackOff` | `0bdfdaac` | `k8s.context.fetch` failed `INTEGRATION_UNAVAILABLE` in 63 ms (stale ServiceAccount token → API `401`); the resume job first hit the 900 s budget (`LEASE_LOST`, requeued) | #7 | **complete** — branch + PR, **no evidence** |
| Kubernetes (run 2, token refreshed) | `…:ImagePullBackOff:run2` | `eadd9a37` | `k8s.context.fetch` completed 5.0 s, **2 items** (warning events + pod logs), truncated | none | evidence loaded, then the resume job exhausted the **agent turn budget** (`BUDGET_EXCEEDED`) |
| Datadog (rerun) | `datadog:344490966` | `b85ae690` | `datadog.context.fetch` completed twice (6.5 s, 5.2 s), **0 items** (synthetic monitor id) | none | resume job hit the 900 s job budget (`BUDGET_EXCEEDED`) |
| Datadog (legacy, pre-subscription) | — (NULL provenance) | `74dc905c` | none — fired before the subscription existed | #3 | PR created, **no evidence path** |
| SigNoz | `signoz:e2e-rule-0001` | `654176d3` | `signoz.context.fetch` completed three times (3.9–4.1 s), **0 items** — workspace has no alert rules (`signoz.list_rules` returns `null`) | none | resume job hit the 900 s job budget (`BUDGET_EXCEEDED`) |

Every PR above is a real pull request on `ivory-26/isolate-e2e-fixture` created from the per-task `task/incident-*` branch after the fixture's failing tests were fixed.

## Findings from the live runs

- **The worker needs `DEVICE_GATEWAY_ENABLED=true` too.** The web flag only exposes `/api/device/claim`; without the flag on the worker the connector context loader is never constructed, so an incident task runs silently with no `connector_calls` row. The first New Relic attempt showed this; restarting the worker with the flag fixed it.
- **A paired Kubernetes credential can silently expire.** The first Kubernetes delivery failed in 63 ms with `INTEGRATION_UNAVAILABLE`; the stored ServiceAccount token file answered `401`. Minting a fresh token (`kubectl -n isolate-demo create token isolate-reader --duration=24h`) and rewriting the same file made the next delivery return 2 real items in 5.0 s, with no daemon restart. Stored token files are read per call, so rotation needs no re-pairing — but nothing currently warns before the token stops working.
- **Honeycomb evidence returned `INTEGRATION_UNAVAILABLE`.** The workspace (`karpesahil2007-gettingstarted`, environment `test`) has **zero datasets** — the Datasets page is empty — so the bounded query produces a bundle that fails the shared context contract. The task degrades to no-evidence and continues; this is a data-availability limitation, not a transport failure.
- **The job execution budget, not the token cap, is what binds.** Four runs dead-lettered with `BUDGET_EXCEEDED` while token spend stayed far below `WORKER_MAX_TOKENS_PER_TASK=800000`: New Relic run 1 and Datadog/SigNoz hit `WORKER_JOB_TIMEOUT_MS` (600 s, later 900 s) and Kubernetes run 2 exhausted the per-task **agent turn budget**. The wall-clock/turn budgets are the real limit for incident tasks that carry weak or empty evidence; the token cap only matters for large prompts.
- **Empty evidence is what makes runs wander.** Runs with a non-empty bundle (New Relic, Axiom, Kubernetes run 2) reached a push in a few turns. Runs whose bundle was empty (Honeycomb, SigNoz, Datadog rerun) spent their turns re-querying the vendor — `signoz.list_rules` was called four times in one resume job — and ran out of budget. A task prompt that tells the model "evidence is empty, proceed" would bound this.
- **Cost is unmetered without `COST_PRICE_TABLE`.** Every model row has `cost_usd = NULL`, the sandbox row too, and the worker logs one `USD cap cannot bind without COST_PRICE_TABLE` warning per job. The USD cap is structurally present but cannot bind until a price table is configured.

## Spend (measured from `usage_records`, model rows only; every `cost_usd` is NULL)

| Task | Vendor | Model rows | Prompt tokens | Completion tokens |
|---|---|---|---|---|
| `74dc905c` | Datadog (legacy) | 6 | 355,319 | 26,965 |
| `764e8046` | New Relic run 1 (dead-lettered) | 6 | 425,531 | 37,287 |
| `0f0f772c` | New Relic run 2 | 6 | 336,684 | 21,917 |
| `8dfe6955` | Honeycomb | 6 | 354,585 | 21,116 |
| `1e0c62e2` | Axiom | 6 | 357,015 | 24,249 |
| `0bdfdaac` | Kubernetes run 1 | 11 | 691,873 | 50,943 |
| `eadd9a37` | Kubernetes run 2 (turn budget) | 9 | 569,996 | 39,070 |
| `b85ae690` | Datadog rerun (job budget) | 6 | 363,524 | 24,177 |
| `654176d3` | SigNoz (job budget) | 6 | 305,406 | 20,594 |

No provider key was read or printed; no secret appears in any request, log or fixture. The only live vendors used here are the free-tier ones already paired to the relay; no paid provider (Baseten, Modal) was exercised beyond the sandboxes each approved agent run provisions, and every sandbox was terminated by the worker.

## Known residual gaps

- SigNoz has no PR: its workspace has no alert rules, so there is no fingerprint an alert could name, and the run could not ground a fix in evidence.
- The Honeycomb and Datadog bundles are empty for the same class of reason (no datasets / no such monitor). A future acceptance should create one fixture dataset or monitor so the bundle carries real rows.
- Kubernetes run 2 proved the evidence path end to end but did not reach a PR; the earlier run's PR (#7) covers the intake → branch → PR path.
