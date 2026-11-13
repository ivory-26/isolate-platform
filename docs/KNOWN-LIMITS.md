# Known limits

| Field | Value |
|---|---|
| Audience | Operators, reviewers and anyone reading a status claim |
| Scope | Capabilities that are not shipped, not proven, or deliberately out of scope in wave 24 |
| Date | 2026-11-02 |
| Related | [`USER-SETUP.md`](USER-SETUP.md), [`connector-onboarding.md`](connector-onboarding.md), [`connectors/SETUP.md`](connectors/SETUP.md), [`DEPLOYMENT.md`](DEPLOYMENT.md), [`devsecops-connectors.md`](devsecops-connectors.md) |

This page records the honest limits behind the product copy. If a capability is not
listed as implemented in the code and the wave status, treat it as not shipped.

## 1. Connector verification and live coverage

- Pairing, vendor-specific secret fields and selectors, the encrypted relay-local
  store, and the bounded `connector.verify` read are implemented. A successful
  verify sets `active` and records `last_validated_at`.
- Verification is **one bounded read**. It proves that the relay can authenticate
  and perform that read; it does not prove every enabled tool, every scope, or
  every provider endpoint is usable.
- Among the nine relay connectors, only Kubernetes has a local live proof (a
  `kind` cluster and one bounded event read). The SaaS adapters are fake-tested.
  No live SaaS connector acceptance run has been performed beyond GitHub, so do
  not present another vendor as live-proven.
- GitHub is live-proven for intake, context and the two scoped writes. The writes
  are connector functions, not agent-callable tools.
- Verification is not a substitute for the per-vendor manual acceptance steps in
  [`connectors/SETUP.md`](connectors/SETUP.md) §13. Those rows remain pending until
  a relay credential is registered and one bounded run passes.

## 2. Event intake gaps

| Area | Current status |
|---|---|
| Datadog, New Relic, Honeycomb, Axiom, SigNoz and Kubernetes intake | **No native intake adapter for any of the six.** The intake mode union is `generic`, `github`, `sentry`, `grafana` and `pagerduty`; none of the six vendors has a mode. The only supported trigger is the generic signed bridge: `POST /api/webhooks/<any-path>`, HMAC-SHA256 over `<timestamp>.<body>` with `WEBHOOK_SIGNING_SECRET`, carrying a full `IncidentSignal` whose `source` is the connector id. The receiver never parses a vendor payload. |
| Connector evidence | **Requires a paired relay.** The worker loads connector evidence only when an `active` device, an `active` credential and a stored signal row for `(organization, source, fingerprint)` all exist; it then enqueues exactly one `<source>.context.fetch` device call (`k8s.context.fetch` for Kubernetes), using that row's `service` and `kind`. A credential that exists only through a relay env fallback has no device queue and loads nothing. Any failure - no device, offline relay, missing row, timeout, malformed or mismatched bundle - returns `null`, and the task continues without evidence. |
| Fingerprint prerequisites | A device call is made only for a fingerprint the device parser accepts: `datadog:<monitorId>`, `newrelic:<digest>`, `honeycomb:<dataset>:<triggerId>:<state>`, `axiom:<monitorId>`, `signoz:<ruleId>` and `k8s:<cluster>:<namespace>:<kind>/<name>:<reason>`. An invented id, or an over-length builder form that appends `~<12hex>` (`honeycomb`, `k8s`), fails the parser and yields no evidence. |
| Task provenance | The bridge records `incident_source`/`incident_fingerprint` only when an enabled subscription for the connector id matches the delivery. Without a matching subscription the legacy generic path creates the task without a fingerprint, so the worker loads no connector evidence. |
| Kafka bridge | **Design-only.** Kafka has no inbound webhook; the consumer bridge is specified, not built. |
| Other unsigned vendors | A signed bridge is required before trusting a payload. Per-vendor webhook routing and canonical re-fetch are not implemented for every vendor. |
| Signed vendor intake | Sentry, Grafana and PagerDuty have signed modes. Their tenant-scoped routing and subscription rules are not all live-proven; GitHub remains the end-to-end live path. |

### 2.1 Model stream stalls and cap accounting

- Budget caps are checked **before each turn**, not during a provider call: sandbox
  wall time against `WORKER_MAX_SANDBOX_SECONDS`, cumulative
  `promptTokens + completionTokens` against `WORKER_MAX_TOKENS_PER_TASK`, and
  recorded spend against `WORKER_MAX_COST_USD_PER_TASK`. A turn that starts under
  a cap may finish over it; the next turn is refused. A token, cost or wall-time
  stop fails the task with reason `budget exhausted`.
- A Meta model stream that stalls mid-turn is not interrupted by those caps. The
  worker cuts the handler at the job timeout (`WORKER_JOB_TIMEOUT_MS`, 120,000 ms
  by default), aborts the request, and ack-fails the job with the terminal
  `BUDGET_EXCEEDED` code, which dead-letters it. There is no per-token mid-stream
  interrupt and no partial-result salvage.
- `usage_records.cost_usd` is `null` unless a `COST_PRICE_TABLE` entry prices the
  model and sandbox. Spend accumulates only non-null costs, so without a price
  table the USD cap cannot bind; the token, turn and wall-time caps still apply.

## 3. Autonomy

| Level | Status | Meaning |
|---|---|---|
| A0 Observe | Available | Records and shows the event; no agent task |
| A1 Investigate | **Not supported** | Recorded as `AUTONOMY_LEVEL_UNSUPPORTED`; no read-only investigation task is executed |
| A2 Prepare fix | Available | Clones, edits and validates in a Modal sandbox; no push |
| A3 Propose PR | Available when repository policy allows | Push and PR creation keep the exact-payload approval gates |
| A4 Production mutation | **Out of scope** | No deploy, rollback, merge or production mutation level |

A0, A2 and A3 are the only honest autonomy claims. Do not describe A1 as planned
for a near-term release, and do not present A4 as available.

## 4. Execution and visual QA

- **No subagent tree.** The worker emits no multi-agent delegation events. The run
  detail shows the real task → attempt → agent turn → tool/connector/validation/
  approval/artifact tree. When no `agentId` events exist, it says one agent;
  delegation is not recorded. It must not invent subagents.
- **No authenticated live visual QA.** This environment could not sign in against
  live data. The landing page and `/login` were checked; authenticated pages are
  covered by tests and the production build, not by a live-data visual pass.
  Screenshots and UI claims must not imply otherwise.
- **Landing capture provenance.** The landing capture was refreshed on 2026-11-02
  from the wave-23 Home composition with synthetic data. It is still a static
  marketing image, not a live tenant view; the running app is the source of truth.

## 5. Deployment dependency

The GitHub App identity is deployment-level. If any required App setting is
missing, install and connect return the fixed `GITHUB_APP_NOT_CONFIGURED` error
instead of starting a partial flow. `GITHUB_APP_SLUG` and
`GITHUB_APP_STATE_SECRET` are never per-tenant. See [`DEPLOYMENT.md`](DEPLOYMENT.md).

## 6. Explicitly not claimed

- A1 investigate.
- A4 production mutation.
- Native webhook intake for Datadog, New Relic, Honeycomb, Axiom, SigNoz or
  Kubernetes; the generic signed bridge is the only intake path for those six.
- Connector evidence without a paired relay, or from a fingerprint the device
  parser rejects.
- A USD spend cap that binds without `COST_PRICE_TABLE`, or a mid-stream
  interrupt for a stalled model response.
- The Kafka consumer bridge.
- Per-vendor webhook routing for every documented vendor.
- A subagent or delegation tree.
- Live SaaS connector acceptance beyond GitHub, or authenticated live-data visual QA.
