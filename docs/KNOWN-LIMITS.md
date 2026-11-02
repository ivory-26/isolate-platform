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
| Datadog canonical re-fetch | **Design-only.** Datadog does not sign webhooks; a delivery is a hint. The bridge must verify its own token and re-fetch the incident or monitor before creating a task. The canonical re-fetch path is not implemented. |
| Kafka bridge | **Design-only.** Kafka has no inbound webhook; the consumer bridge is specified, not built. |
| Other unsigned vendors | A signed bridge is required before trusting a payload. Per-vendor webhook routing and canonical re-fetch are not implemented for every vendor. |
| Signed vendor intake | Sentry, Grafana and PagerDuty have signed modes. Their tenant-scoped routing and subscription rules are not all live-proven; GitHub remains the end-to-end live path. |

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
- **Landing capture provenance.** The landing screenshot may predate a UI change;
  treat the running app as the source of truth.

## 5. Deployment dependency

The GitHub App identity is deployment-level. If any required App setting is
missing, install and connect return the fixed `GITHUB_APP_NOT_CONFIGURED` error
instead of starting a partial flow. `GITHUB_APP_SLUG` and
`GITHUB_APP_STATE_SECRET` are never per-tenant. See [`DEPLOYMENT.md`](DEPLOYMENT.md).

## 6. Explicitly not claimed

- A1 investigate.
- A4 production mutation.
- Datadog canonical re-fetch.
- The Kafka consumer bridge.
- Per-vendor webhook routing for every documented vendor.
- A subagent or delegation tree.
- Live SaaS connector acceptance beyond GitHub, or authenticated live-data visual QA.
