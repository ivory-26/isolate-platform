# Run tracing and streaming observability

| Field | Value |
|---|---|
| Date | 2026-10-31 |
| Status | Primitives and opt-in OTLP/HTTP JSON exporter implemented; trace read model owned by another lane |
| Scope | Every agent run, sandbox action and connector call |
| Rule | Trace attributes are identifiers, counts, durations and outcomes only; never prompts, tool arguments, provider bodies or credentials |

## 1. Trace model

One task run owns one **trace id** (128-bit, W3C compatible). Every span shares it and
records a 64-bit span id plus its parent. The shared primitives live in
`packages/shared/src/observability/trace.ts`:

- `newTraceContext()` / `childTraceContext()` — id generation;
- `formatTraceparent()` / `parseTraceparent()` — W3C `00-<trace>-<span>-<flags>`;
- `createRunTracer(root, {sink})` — spans bound to one run;
- `boundedTraceAttributes()` — drops credential-shaped keys, nested values and long strings;
- `createLoggerTraceSink()` — streams `isolate.trace` records through the redacting logger;
- `createOtlpTraceSink({endpoint, headers?, timeoutMs?})` — opt-in OTLP/HTTP JSON exporter
  (`packages/shared/src/observability/otlp.ts`);
- `createMultiTraceSink([...])` — fans one event out to several sinks without letting one
  failure silence the others.

## 2. Span inventory

| Span | Emitted by | Key attributes |
|---|---|---|
| `task.run` | worker handler | `taskId`, `jobType`, `attempt` |
| `agent.turn` | worker | `turn`, `toolCalls`, `durationMs` |
| `tool.gate` | worker policy boundary | `tool`, `risk`, `outcome` |
| `sandbox.exec` | worker | `exitCode`, `durationMs`, `outputBytes` |
| `connector.enqueue` | worker connector tool | `connector`, `tool` |
| `connector.queue_wait` | worker | `waitMs`, `expired` |
| `connector.claim` | device gateway | `deviceId`, `count` |
| `connector.provider_call` | device daemon | `connector`, `tool`, `status`, `durationMs` |
| `connector.result` | worker/gateway | `status`, `bytes` |
| `validation.run` / `acceptance.run` | worker | `outcome`, `durationMs` |
| `git.push` / `pr.create` | worker | `outcome`, `status` |

Only these bounded attributes cross a sink. The existing `run_events` table keeps the
durable, per-task timeline; the trace sink streams the same facts for live observability.

## 3. Propagation

```text
worker: newTraceContext() ──► span tree
      │
      ├─ formatTraceparent(root) ──► connector_calls.traceparent (0013)
      │
gateway claim ──► returns traceparent alongside the call
      │
daemon ──► parses traceparent ──► logs connector.provider_call with the same trace id
      │
result ──► gateway/worker close connector.result with queue wait + total
```

- `connector_calls.traceparent` is a fixed-shape identifier (migration `0013`, applied by
  the coordinator). It carries no payload.
- A device that cannot parse the header logs a local span with a fresh root; it never
  guesses a parent.
- HTTP services parse incoming `traceparent` only from trusted callers; the worker is the
  root of a run.

## 4. Streaming and storage

- **Live stream:** one `isolate.trace` JSON line per span through the existing logger. The
  logger redacts sensitive keys, and the sink only receives bounded attributes.
- **Durable timeline:** `run_events` remains the source of truth for a task; the trace id is
  added to event payloads so a run can be reconstructed.
- **Read model (planned):** `getTaskTrace(taskId)` joins `run_events`, `tool_invocations`,
  `usage_records` and `connector_calls` into one ordered view; server-only, tenant-scoped.
- **Retention:** trace log lines follow the deployment log retention; `run_events` follows
  the database retention. No content is stored in trace attributes, so retention carries no
  secret risk.
- **OTLP (opt-in):** setting `OTEL_EXPORTER_OTLP_ENDPOINT` makes the worker compose the
  OTLP/HTTP JSON exporter next to the logger sink. One span becomes one
  `resourceSpans[0].scopeSpans[0].spans[0]` record with `traceId`, `spanId`,
  `parentSpanId`, `startTimeUnixNano`/`endTimeUnixNano`, status and bounded attributes.
  The base URL gets `/v1/traces`; https is required and http is accepted only for
  localhost. `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,...`) is sent on the request and
  never copied into the payload; neither name's value is ever logged. Export is
  fire-and-forget with a bounded abort timeout — a collector outage never changes a
  task's outcome. With the endpoint unset the handler keeps its logger default.

## 5. Sampling

Start at 100% for connector calls and agent runs (low volume). When volume grows, sample
reads but always keep: errors, `scoped_write` calls, validation/acceptance outcomes and
approval decisions. Sampling must never change behavior or limits.

## 6. Observability metrics (in addition to `isolate.trace`)

| Metric | Fields |
|---|---|
| `connector.call.enqueued` | `connector`, `tool` |
| `connector.call.queue_ms` | `connector`, `durationMs` |
| `connector.call.outcome` | `connector`, `outcome`, `code` |
| `connector.provider.ms` | `connector`, `durationMs` |
| `connector.stream.bytes` | `connector`, `count` |
| `connector.rate_limited` | `surface`, `outcome` |

The existing worker metrics (`worker.turn.latency_ms`, `worker.sandbox.seconds`,
`worker.validation.outcome`, `worker.pr.outcome`) stay unchanged.

## 7. Implementation status

- Trace primitives and tests: **done** (`packages/shared/src/observability/trace.ts`).
- Migration `0013_trace_context.sql`: **applied** (`connector_calls.traceparent`).
- Worker per-run tracing: **done** — one trace id per job, one `agent.turn` span per turn,
  trace id on turn events and the latency metric.
- Gateway/daemon propagation: **done** — the worker stamps the run traceparent on the call,
  the claim returns it, and the daemon logs `connector call` with the same trace id.
- OTLP/HTTP JSON exporter: **done** — opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`; bounded
  payload, validated endpoint, fire-and-forget with an abort timeout. Tests:
  `packages/shared/src/observability/otlp.test.ts`.
- Trace read model: **done** — `getTaskTrace` + `GET /api/traces/{taskId}` (tenant-scoped, bounded).
- Dashboards: planned.
