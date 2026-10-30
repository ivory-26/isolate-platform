# @isolate/worker

Durable worker: claims `jobs`, runs the task-execution / resume / pull-request
handlers, writes spend rows, and emits structured metrics through the shared
`Logger`.

## Trusted price table (`COST_PRICE_TABLE`)

Cost is configuration, never a guess. Set a JSON document validated by the
shared `costPriceTableSchema`:

```json
{
  "models": [
    {
      "modelId": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "promptTokenUsdPerMillion": 0.27,
      "completionTokenUsdPerMillion": 0.85
    }
  ],
  "sandbox": { "cpuSecondUsd": 0.00005, "gibSecondUsd": 0.00001 }
}
```

- Absent/blank → `null`: model and sandbox `usage_records.cost_usd` rows stay
  `null` ("unknown"), boot still succeeds.
- Present but invalid → boot fails closed with a bounded
  `VALIDATION_FAILED` error (`apps/worker/src/pricing.ts`); the raw value is
  never logged.
- Model rows are priced with `modelCallCostUsd` from measured tokens; the
  sandbox row uses `sandboxCostUsd` over measured wall seconds and the
  provisioned CPU/memory.

## Branch lease and acceptance semantics

- A `run_task`/`resume_task` job holds one row lease per
  `(organization, repository, branch)` (`branch_locks`). The handler renews it
  on its per-turn heartbeat points, at most once per
  `BRANCH_LOCK_RENEW_INTERVAL_MS` (5 minutes; the default lease is 15), and
  never acquires a second lease. A failed renewal returns the bounded
  `retry`/`LEASE_LOST` verdict; the sandbox is destroyed and the lease is
  released (a no-op if it was already taken over).
- `content_matches` acceptance checks are **literal substring** tests
  (`text.includes(pattern)`), not regular expressions. Patterns such as
  `a+`, `^done$` or `([a-z` are matched character for character; regex
  metacharacters have no special meaning. The shared field name `pattern` and
  its 200-character bound are unchanged, and no pattern is rejected.

## Metric vocabulary (`isolate.metric`)

Every metric is one log record: `logger.info("isolate.metric", { metric, ... })`
(`apps/worker/src/metrics.ts`). Only bounded fields are emitted — ids, counts,
durations, codes and outcomes. Unknown keys are dropped by the writer, so a
prompt, a path or tool arguments can never reach a metric record.

| Metric | When | Fields |
| --- | --- | --- |
| `worker.job.claimed` | job claimed from the queue | `jobId`, `taskId`, `jobType`, `attempt` |
| `worker.job.completed` | handler returned `complete` | `jobId`, `taskId`, `jobType`, `outcome` |
| `worker.job.failed` | handler failed (retried or not) | `jobId`, `taskId`, `jobType`, `code`, `requeued` |
| `worker.job.dead_letter` | queue dead-lettered the job | `jobId`, `taskId`, `jobType`, `code` |
| `worker.turn.latency_ms` | one agent turn finished | `turn`, `durationMs` |
| `worker.sandbox.seconds` | sandbox torn down | `seconds` (measured wall time) |
| `worker.validation.outcome` | validation gate decided | `outcome` (`passed`/`failed`/`skipped`), `durationMs` |
| `worker.pr.outcome` | pull-request job decided | `taskId`, `outcome` (`created`/`recorded`/`failed`/`skipped`), `code` |

## Run summary

`createConfiguredWorkerComposition(...).summarizeTask({ organizationId, taskId })`
reads `usage_records` (exact-decimal totals), `task_attempts` (attempt count,
measured `sandboxSeconds` and the validation outcome) and `artifacts` (count),
and returns the shared `RunSummary` — or `null` for a missing/foreign task.
The pure assembly lives in `apps/worker/src/run-summary.ts`; the API consumer is
wired by the coordinator.
