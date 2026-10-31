# Scaling, load balancing, throttling and chunking

| Field | Value |
|---|---|
| Date | 2026-10-31 |
| Scope | Device transport, connector calls, web/worker replicas |
| Rule | No provider key on the server; every limit is durable and replica-safe |
| Related | [`DEVICE.md`](DEVICE.md), [`../connector-usage.md`](../connector-usage.md) |

## 1. Topology

```text
            ┌───────────────┐   ┌───────────────┐
browser ───►│ web replica 1 │   │ web replica 2 │  (stateless; Neon Auth session)
            └──────┬────────┘   └──────┬────────┘
                   │  Postgres (Neon)  │
            ┌──────┴────────┐   ┌──────┴────────┐
daemon ────►│ claim/result  │   │ worker replicas│
            └───────────────┘   └───────────────┘
```

No component holds sticky state that a request needs:

- sessions are verified by Neon Auth per request (server-side proxy; no client-held secret);
- connector tool arguments, calls, results and free-tier counters live in Postgres;
- rate-limit counters live in Postgres (fixed-window rows), so two replicas share one budget;
- the device gateway caches only a database handle per process, never a call or a token.

## 2. Durable primitives

| Concern | Primitive | Concurrency property |
|---|---|---|
| Call queue | `connector_calls` + `FOR UPDATE SKIP LOCKED` claim | two replicas can never claim the same row |
| Free-tier budget | `connector_usage_ledger.consume` | one statement; `(credential_id, period)` unique |
| Rate limiting | `rate_limit_counters` (`bucket_key`, `window_start`) | one upsert per window; `WHERE count < limit` |
| Device auth | sha256 `token_hash` + unique index | constant-time compare; revoked/pending rejected |
| Idempotency | terminal call replay returns success | duplicate result cannot double-execute |

## 3. Throttling and rate limits

Fixed windows, DB-backed; denied calls return `429` with `Retry-After`. Planned defaults
(tunable per deployment):

| Surface | Key | Default |
|---|---|---|
| Device claim | `device:<id>:claim` | 120/min |
| Device result | `device:<id>:result` | 240/min |
| Device heartbeat | `device:<id>:heartbeat` | 60/min |
| Pre-auth device IP | `ip:<addr>:device` (trusted proxy only) | 600/min |
| Webhook intake | `webhook:<mode>:global` | 600/min |
| Device register | `user:<id>:device:register` | 10/min |
| Device list | `user:<id>:device:list` | 120/min |
| Device revoke | `user:<id>:device:revoke` | 30/min |
| Connector connect | `user:<id>:connector:connect` | 30/min |
| Connector list | `user:<id>:connector:list` | 120/min |
| Connector revoke | `user:<id>:connector:revoke` | 30/min |
| Worker connector calls | `org:<org>:connector:<id>:calls` | 60/min |
| Free tier | `connector_usage_ledger` | credential `requestsPerDay` or `CONNECTOR_FREE_DAILY_CALLS` |

`TRUST_PROXY_HEADERS=true` is required before `x-forwarded-for` is used; otherwise the
pre-auth bucket is a constant and only post-auth per-device limits apply.

## 4. Backpressure

- A denied limit is a recorded `429`, not a retry loop: the daemon backs off with jitter,
  the worker maps `RATE_LIMITED` to the model, and the daily ledger stop is user-visible.
- A device offline leaves calls to expire (`INTEGRATION_UNAVAILABLE`), never an unbounded
  wait.
- One device executes a claimed batch sequentially; the daemon never fans out a burst of
  provider calls.

## 5. Batching

- `claimNext(deviceId, limit)` claims up to 10 calls in one atomic statement; the gateway
  accepts `?limit=` and returns `{calls}` for a batch (`{call}` for one).
- Batching is **queue-level** only. Provider requests stay per-call because the adapters
  already bound, paginate and cap; no vendor is asked to accept an arbitrary batch.
- The daemon processes the batch one call at a time so provider rate limits see the same
  shape as today.

## 6. Chunking

- Provider response bodies are read through a bounded stream reader: chunks are counted as
  they arrive and the reader is cancelled the moment the cap would be exceeded. The
  server never buffers an unbounded body waiting for `Content-Length`.
- Existing caps stay: 64 KiB call params, 256 KiB call results, 256 KiB provider response,
  4,000 chars per context excerpt, 200 log lines.
- A result over the cap fails the call (`VALIDATION_FAILED`); it is not silently truncated
  and replayed.

## 7. Failure and load-balancing behavior

| Event | Behavior |
|---|---|
| Web replica restarts mid-claim | row lease expires; another replica/device reclaims after TTL |
| Two daemons share one token | both poll; atomic claim splits calls; per-device limits apply |
| Provider 429 | adapter/daemon backs off; worker returns `RATE_LIMITED` |
| Neon Auth unavailable | user routes fail closed (401/503); device bearer routes unaffected |
| Postgres failover | claims/limits fail closed; no in-memory fallback |

## 8. Verification

- Unit: rate-limit repo concurrency, batch claim order, gateway 429/`Retry-After`,
  streaming cap cancellation, per-tool schema validation.
- Local: run two web replicas against the same database, one daemon, and enqueue a batch;
  each call is claimed exactly once. (Single-replica proof passed 2026-10-31.)
- Load: not yet measured; the DB row budget is the intended ceiling. Add a k6/autocannon
  run before any production claim.
