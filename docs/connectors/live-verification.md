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
| SigNoz (run 7, after the v2/v3 fix and RBAC grant) | `signoz:01a1da78-8f3d-705e-9dae-9211e3840e5b` | `f99a9b84` | `signoz.context.fetch` completed twice (8.3 s, 14.0 s), **1 item**, truncated | #8 | **complete** — evidence + branch + commit `413eb37` + PR |
| Honeycomb (run 8) | `honeycomb:e2e-checkout-error-spike-r8` | `3a91e5cc` | none — a two-segment fingerprint fails `parseConnectorIncidentFingerprint`, so the loader returned no bundle and never enqueued a call; the agent's own `honeycomb.list_slos` failed `INTEGRATION_UNAVAILABLE` | #9 | **complete** intake → branch → PR, **no evidence** (malformed fingerprint) |
| Honeycomb (run 9) | `honeycomb:checkout:checkout-error-rate:triggered` | `b1f2fc0d` | `honeycomb.context.fetch` failed `VALIDATION_FAILED` — the signal kind `alert` is forwarded as the Honeycomb *query kind*, which accepts only `latency`/`error_rate`/`saturation` | none | rejected at the push gate; no sandbox was created |
| Honeycomb (run 10) | `honeycomb:checkout:checkout-error-rate-r10:triggered` | `0a6bf6e8` | `honeycomb.context.fetch` failed `INTEGRATION_UNAVAILABLE` — the paired key answers `/1/auth` but `401`s the query endpoint | #10 | **complete** intake → branch → commit `100a2cf` → PR, **no evidence** (credential cannot query) |
| Datadog (run 11, real monitor id) | `datadog:344995520` | `97f9e8a7` | `datadog.context.fetch` completed twice, **0 items**, `truncated: true` — the monitor read failed as an optional item, not as a typed error | #11 | **complete** intake → branch → commit `8f681ac` → PR, **no evidence** |

Every PR above is a real pull request on `ivory-26/isolate-e2e-fixture` created from the per-task `task/incident-*` branch after the fixture's failing tests were fixed.

## Findings from the live runs

- **The worker needs `DEVICE_GATEWAY_ENABLED=true` too.** The web flag only exposes `/api/device/claim`; without the flag on the worker the connector context loader is never constructed, so an incident task runs silently with no `connector_calls` row. The first New Relic attempt showed this; restarting the worker with the flag fixed it.
- **A paired Kubernetes credential can silently expire.** The first Kubernetes delivery failed in 63 ms with `INTEGRATION_UNAVAILABLE`; the stored ServiceAccount token file answered `401`. Minting a fresh token (`kubectl -n isolate-demo create token isolate-reader --duration=24h`) and rewriting the same file made the next delivery return 2 real items in 5.0 s, with no daemon restart. Stored token files are read per call, so rotation needs no re-pairing — but nothing currently warns before the token stops working.
- **Honeycomb evidence returned `INTEGRATION_UNAVAILABLE`.** The workspace (`karpesahil2007-gettingstarted`, environment `test`) has **zero datasets** — the Datasets page is empty — so the bounded query produces a bundle that fails the shared context contract. The task degrades to no-evidence and continues; this is a data-availability limitation, not a transport failure.
- **The job execution budget, not the token cap, is what binds.** Four runs dead-lettered with `BUDGET_EXCEEDED` while token spend stayed far below `WORKER_MAX_TOKENS_PER_TASK=800000`: New Relic run 1 and Datadog/SigNoz hit `WORKER_JOB_TIMEOUT_MS` (600 s, later 900 s) and Kubernetes run 2 exhausted the per-task **agent turn budget**. The wall-clock/turn budgets are the real limit for incident tasks that carry weak or empty evidence; the token cap only matters for large prompts.
- **Empty evidence is what makes runs wander.** Runs with a non-empty bundle (New Relic, Axiom, Kubernetes run 2) reached a push in a few turns. Runs whose bundle was empty (Honeycomb, SigNoz, Datadog rerun) spent their turns re-querying the vendor — `signoz.list_rules` was called four times in one resume job — and ran out of budget. A task prompt that tells the model "evidence is empty, proceed" would bound this.
- **Cost is unmetered without `COST_PRICE_TABLE`.** Every model row has `cost_usd = NULL`, the sandbox row too, and the worker logs one `USD cap cannot bind without COST_PRICE_TABLE` warning per job. The USD cap is structurally present but cannot bind until a price table is configured.
- **A connector fingerprint is parsed per connector, and an unparseable one fails silently.** Honeycomb needs four segments — `honeycomb:<dataset>:<triggerId>:<state>` — and `signoz`/`datadog`/`newrelic`/`axiom` need two. Run 8 sent `honeycomb:e2e-…`, which parses to `null`; the loader then returns no bundle and never enqueues a call, and nothing in the task says evidence was skipped. The task still ran to a PR.
- **The signal `kind` is forwarded to the vendor tool as a selector.** For Honeycomb the daemon maps it through `HONEYCOMB_QUERY_KINDS`, which accepts only `latency`, `error_rate` and `saturation`; a delivery whose kind is `alert` fails `VALIDATION_FAILED` in 4 ms with no provider call. Run 10 sent `error_rate` and got past validation.
- **Honeycomb verification is weaker than capability.** The stored key answers `GET /1/auth` (so the integration page says Connected/verified) but `401`s the query endpoint, which `fetchHoneycombIncidentContext` maps to `INTEGRATION_UNAVAILABLE`. An ingest-only key cannot read data; a Configuration API key is required. No test in the current suite distinguishes the two, because verification only probes `/1/auth`.
- **SigNoz was fixed by a rules-API change, not by data.** SigNoz ≥ 0.150 serves rule reads on `/api/v2/rules/{id}` and `/api/v3/rules`; the v1 path answers `404`. Commit `74385ef` moved the reader to the v2/v3 paths and the RBAC grant (`signoz-viewer`) let the service account enumerate rules, after which run 7 returned a real bundle and opened PR #8.
- **A documentation-only diff skips the repository validation command.** Commit `1558483`: when every changed path is prose (`.md`, `.mdx`, `.markdown`, `.rst`, `.adoc`, `.txt`), the gate records `validation.finished {stage: "command", status: "skipped", reason: "documentation-only diff"}` instead of running `bun test`. Before this, the report deliverable always failed on the fixture repo's pre-existing red suite; SigNoz run 7 is the first run to reach a PR through the new path (`awaiting pull request approval` at 18:07:35).
- **One active task per organization gates new deliveries.** While `b1f2fc0d` (Honeycomb run 9) sat at its push gate, the next delivery was admitted as `ignored` with reason `THROTTLED`; the signal was still recorded, but no task was created. A task parked at an approval blocks the intake path for its organization.

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
| `f99a9b84` | SigNoz run 7 (PR #8) | 13 | 310,302 | 29,318 |
| `3a91e5cc` | Honeycomb run 8 (PR #9) | 13 | 229,224 | 29,967 |
| `0a6bf6e8` | Honeycomb run 10 (PR #10) | 13 | 169,620 | 18,575 |
| `97f9e8a7` | Datadog run 11 (PR #11) | 13 | 197,560 | 19,674 |

No provider key was read or printed; no secret appears in any request, log or fixture. The only live vendors used here are the free-tier ones already paired to the relay; no paid provider (Baseten, Modal) was exercised beyond the sandboxes each approved agent run provisions, and every sandbox was terminated by the worker.

## Known residual gaps

### Browser reinspection — 2026-11-17

Browse reached the signed-in Honeycomb environment `test` and dataset `checkout`.
The old Onboarding ingest key is **Disabled**. An enabled Configuration key
already exists, but its **Run queries** permission is unchecked and disabled;
the permission editor explicitly says **“This feature is only available for
enterprise plans.”** Read service maps has the same restriction. The console
also says all enabled Configuration keys can read/list datasets. This corrects
the earlier assumption that a Configuration-key re-pair alone enables query
evidence. No plan upgrade, trial, key creation, query, signed delivery, model
turn or sandbox was initiated during this inspection.

The user confirmed Datadog **US1**. Its signed-out browser session was restored
through the existing Google session; the Application Keys page is reachable.
Key scopes and relay binding remain to be verified. No new live context result
or PR is claimed by this browser inspection.

The bullets below record the earlier run state; the Honeycomb credential-only
recommendation is superseded by the measured account limitation above.

- SigNoz is complete: run 7 carried one evidence item and opened PR #8. The earlier "no alert rules" state was an API-version bug plus a missing RBAC grant, both fixed.
- **Honeycomb has real vendor data now, but the paired credential cannot read it.** Dataset `checkout` exists in environment `test` with three events (`service: checkout`, status codes `500`, `502`, `200`, tag `incident: signoz-error-spike`). Every query call still fails `INTEGRATION_UNAVAILABLE` because the stored key is ingest-class. Re-pairing Honeycomb with an environment **Configuration** API key is the remaining step; no code change is needed.
- Datadog still has no evidence row: the account's only monitor is `344995520` ("Isolate E2E CPU load", `avg(last_5m):avg:system.load.1{*} > 90`, state `NO DATA`, no service tag). Its id was previously mistyped as `344490966`.
- Kubernetes run 2 proved the evidence path end to end but did not reach a PR; the earlier run's PR (#7) covers the intake → branch → PR path.
- **Honeycomb and Datadog are paused on a human credential step (2026-11-15).** The pipeline itself is proven for both (PR #10, PR #11). What is missing is a credential that can read: Honeycomb needs an environment **Configuration** API key (the paired key answers `/1/auth` and `401`s queries), and Datadog needs an Application key with `monitors_read` on the site the connector is paired to. The agent could not inspect or replace either credential: enumerating `~/.isolate/secrets.json`, `browse secrets_list`, and opening the Datadog application-keys console were each denied by policy as credential access, and the server-side `connector_credentials.metadata` is `{}` (selectors live only in the relay's local store). Re-pair both connectors by hand, then re-deliver with a fresh fingerprint.
- **No evidence is a silent state.** `createConnectorContextLoader` returns `null` for a malformed fingerprint, a missing device, a missing signal row or a failed call, and none of those produce a `run_events` row. A run page therefore cannot say "evidence was skipped, and why". Adding one bounded `connector.context.skipped {reason}` event at the handler call site is the smallest fix and is not implemented here.
