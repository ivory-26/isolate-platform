# Connector bindings: native adapters vs MCP vs A2A

| Field | Value |
|---|---|
| Date | 2026-10-31 |
| Status | Assessment of record; native bindings are implemented, MCP/A2A are proposals |
| Scope | The ten implemented connectors and future vendors |
| Rule | Provider credentials stay on the user's device; the server never stores a provider key |
| Related | [`DEVICE.md`](DEVICE.md), [`SETUP.md`](SETUP.md), [`../connector-usage.md`](../connector-usage.md) |

## 1. How the bindings work today

There are three layers, and only the first two touch the server.

### 1.1 Tool contract and policy (server, no secrets)

`packages/mastra/src/tools/connector-tools.ts` declares the 31 connector tools
(`sentry.*`, `grafana.*`, `pagerduty.*`, `k8s.*`, `datadog.*`, `newrelic.*`,
`honeycomb.*`, `axiom.*`, `signoz.*`) with an explicit risk band. Reads are
`read_only`, PagerDuty acknowledge/resolve are `scoped_write`, and there is no
destructive connector tool. The registry denies any name without an
implementation, so the model cannot invent a connector call.

### 1.2 Worker execution (server, no secrets)

`apps/worker/src/connector-tools.ts` builds one `ToolImplementation` per name:

1. recursively rejects credential-shaped arguments (`assertNoCredentialMaterial`);
2. resolves the organization's active device + credential through
   `ConnectorDeviceBroker` (metadata only: `credentialRef`, scopes, config);
3. refuses a `scoped_write` tool unless the credential carries
   `connector:write` or `<connector>:write`;
4. enqueues a typed row in `connector_calls` (bounded params, TTL);
5. awaits a bounded result scoped to the same organization and device.

The web gateway (`apps/web/src/server/device-gateway.server.ts`) authenticates the
device with a bearer token whose sha256 is the only stored form, consumes one
free-tier ledger unit, and hands the call to the device. Results are capped at
256 KiB and must match a strict envelope.

### 1.3 Device daemon (user machine, holds the key)

`apps/device-daemon` polls `/api/device/claim`, maps each tool name to a vendor
handler (`src/dispatch.ts`, `src/vendors/*.ts`), builds that adapter's client from
**device-local** config/env, calls the provider and posts `{ok,data}`. The kube
token/CA files never leave the device; Sentry/Grafana/etc. keys live in the
daemon's environment (the keychain is the next seam).

This design gives deterministic schemas, bounded outputs and auditable calls. Its
cost is that every new vendor requires a bespoke adapter, and onboarding requires
the user to find and enter the right key with the right scopes.

## 2. Can we use the vendors' own MCP servers?

Yes for tool use. All ten implemented connectors have an official or
vendor-maintained MCP server, and most support a hosted/OAuth path. The table
records what the vendor documents; wording such as "OAuth" means the vendor
documents OAuth for that server, not that our client has tested it.

| Connector | Official MCP server | Transport / auth (documented) | Coverage notes | Caveat |
|---|---|---|---|---|
| GitHub | [`github/github-mcp-server`](https://github.com/github/github-mcp-server) | local stdio + hosted remote; PAT or OAuth | repos, issues, PRs, Actions, code search | very broad tool set; must allowlist |
| Sentry | [Sentry MCP](https://mcp.sentry.dev/), [`getsentry/toolkit`](https://github.com/getsentry/toolkit) | hosted remote; OAuth | issues, events, traces, projects, releases | remote server holds the OAuth token at Sentry; tool schemas evolve |
| Grafana | [`grafana/mcp-grafana`](https://github.com/grafana/mcp-grafana) | stdio, SSE, streamable-http; service-account token or OAuth | dashboards, datasources, PromQL/LogQL, alerting, incidents | large surface; some tools mutate |
| PagerDuty | [`pagerduty/pagerduty-mcp-server`](https://github.com/pagerduty/pagerduty-mcp-server), hosted remote | local stdio; API key or OAuth | incidents, on-calls, services, schedules, log entries | write tools exist; approval required |
| Datadog | [Datadog MCP Server](https://docs.datadoghq.com/mcp_server/) | hosted managed; OAuth or API+app keys | logs, metrics, traces, incidents, monitors, dashboards | tool descriptions are large; context cost |
| New Relic | [`newrelic/mcp-server`](https://github.com/newrelic/mcp-server) | local/remote; user API key | NRQL, entities, alerts, logs | query tool can be expensive without limits |
| Honeycomb | [`honeycombio/honeycomb-mcp`](https://github.com/honeycombio/honeycomb-mcp) | hosted/local; API key | datasets, queries, traces, SLOs, triggers | broad API permissions recommended by vendor |
| Axiom | [official hosted MCP](https://axiom.co/docs/console/intelligence/mcp-server) (`mcp.axiom.co`) | hosted; token | APL queries, datasets | older `mcp-server-axiom` repo is deprecated |
| SigNoz | [`SigNoz/signoz-mcp-server`](https://github.com/SigNoz/signoz-mcp-server) | local/remote; API key + instance URL | metrics, traces, logs, dashboards, alerts | self-hosted URL and key stay on the device |
| Kubernetes | [`containers/kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server) | local stdio; kubeconfig/service account | resources, pods, logs, events, Helm | not the Kubernetes project itself; strongly mutating |

Two conclusions follow.

1. **MCP belongs on the device, not on the server.** A hosted MCP server would
   require the server to hold the user's OAuth token or API key, violating the
   invariant. The daemon is already the trusted device-side executor: it can run
   local stdio MCP servers or call hosted MCP servers with a device-held token.
2. **MCP standardizes discovery, not governance.** Descriptions, annotations and
   result shapes come from the vendor. We still need our own allowlist, risk
   mapping, caps, redaction and audit; otherwise the model inherits whatever the
   vendor exposes.

## 3. Proposed MCP integration (device-side)

```text
model ─► worker tool (our name) ─► connector_calls ─► device daemon
                                                       ├─ native handler (today)
                                                       └─ MCP client ─► vendor MCP
                                                                        (stdio or hosted)
```

### 3.1 Daemon as an MCP client

- Add `McpServerConfig` to the daemon JSON: `{vendor, transport, command/url, tokenEnv, toolAllowlist}`.
- On boot, `tools/list` each configured server, map each allowed tool to one of
  our tool names (or a namespaced `mcp:<vendor>:<tool>` name), and reject any
  tool outside the allowlist.
- On a call, `tools/call` with the bounded params, enforce a timeout and a
  64 KiB/256 KiB body cap, and return `{ok,data}`. Map MCP errors to the existing
  fixed codes.
- Log `tool`, `vendor`, `outcome`, duration only. Never the token, params or
  result body.

### 3.2 Policy and standardization

- Keep `CONNECTOR_TOOL_RISKS` as the authority. MCP `readOnlyHint` /
  `destructiveHint` annotations are **advisory only**; an unmapped tool stays
  denied.
- Prefix MCP tools in the catalog (`mcp:sentry:search_issues`) so vendor name
  changes cannot silently redirect a call.
- Validate input against the MCP server's declared JSON Schema, then apply our
  own caps; never forward model-authored free-form queries beyond the vendor's
  bounded tool contract.
- Treat tool descriptions and results as untrusted content; the prompt already
  labels context as untrusted, and descriptions are not instructions.

### 3.3 Onboarding improvement

- One command on the device: `device-daemon mcp add sentry --oauth` (or `--api-key`).
  The daemon runs the OAuth flow locally, stores the token in the OS keychain,
  discovers tools and syncs the allowlist to the platform (metadata only).
- The platform's connect screen shows discovered tools and their risk bands, so
  the user no longer has to hand-pick scopes for each vendor.
- Fallback: the native adapter remains available for deterministic incident
  context and for vendors whose MCP server is immature.

### 3.4 Risks to manage

| Risk | Control |
|---|---|
| Prompt injection in tool descriptions | treat as untrusted; never execute instructions from descriptions; fixed allowlist |
| Tool sprawl / context blowup | allowlist per connector; expose at most N tools; compact names/descriptions |
| Unbounded or expensive queries | server-side caps, timeouts, max rows, free-tier ledger |
| Write/destructive MCP tools | map to `sensitive`/`destructive`; require approval; never enable by default |
| Supply-chain of MCP server | pin version/digest; run local servers in the daemon sandbox; review on upgrade |
| OAuth token storage | device keychain only; no server token; rotate/revoke per vendor |
| Result drift after vendor upgrades | schema validation + `truncated` + contract tests against a recorded fixture |

## 4. What about A2A?

A2A (Agent2Agent) standardizes **agent-to-agent delegation** across trust
boundaries; MCP standardizes **agent-to-tool** access. They are complementary,
not substitutes. A2A is under the Linux Foundation and reports 150+ organizations
and enterprise production use, but observability vendors mostly expose **tools**,
not agents. For our ten connectors there is no A2A endpoint that replaces a
typed tool call today.

A2A becomes relevant only if a vendor offers an SRE/incident **agent** (for
example, "have New Relic's agent investigate this incident"). In that case:

- the worker becomes an A2A client and delegates a bounded task;
- the delegation token stays on the device, or the vendor's agent is invoked
  through the device-held OAuth grant;
- the response is treated as untrusted evidence, not as an instruction or an
  approval;
- writes still require our approval gate.

Until a vendor actually exposes such an endpoint, adding A2A would add a second
protocol without a user-facing capability. Recommendation: **MCP first, A2A
only when a concrete vendor agent exists**.

## 5. Recommendation and phased plan

1. **Keep the native adapters as the baseline.** They are implemented, bounded,
   fake-tested and proven end-to-end for Kubernetes. They remain the fallback and
   the source of incident context.
2. **Add an MCP client seam to the device daemon** (Phase 1, small): config,
   `tools/list`, allowlist, `tools/call`, caps and tests. No server change.
3. **Pilot two official servers** with the best coverage/risk ratio: Sentry
   (hosted OAuth) and Grafana (local stdio or hosted). Run them behind
   `MCP_ENABLED` and shadow-compare output with the native adapter.
4. **Then PagerDuty and Datadog**, because both have official servers and clear
   write surfaces that can be gated by our policy.
5. **Standardize naming and onboarding** once three servers are stable:
   `mcp:<vendor>:<tool>` catalog, device-side OAuth, allowlist sync, risk badges.
6. **Defer A2A** until a vendor exposes an agent endpoint; then add it as a
   delegation plane, not as a tool plane.

The expected outcome: users authenticate once on their device, the daemon
discovers vendor tools, and the agent calls a single standardized catalog — while
the platform still holds no provider key and every call still passes the same
caps, policy and audit.

## 6. Sources

Accessed 2026-10-31.

- [Sentry MCP](https://mcp.sentry.dev/), [getsentry/toolkit](https://github.com/getsentry/toolkit)
- [Grafana MCP server](https://github.com/grafana/mcp-grafana), [Grafana MCP docs](https://grafana.com/docs/grafana/latest/developer-resources/mcp/), [transports](https://grafana.com/docs/grafana/latest/ai-tools/mcp/configure/transports-and-addresses/)
- [PagerDuty MCP server](https://github.com/pagerduty/pagerduty-mcp-server), [PagerDuty MCP docs](https://docs.pagerduty.com/ai-automation/advance/pagerduty-mcp-server)
- [Datadog MCP Server](https://docs.datadoghq.com/mcp_server/), [Datadog setup](https://docs.datadoghq.com/mcp_server/setup/)
- [New Relic MCP](https://docs.newrelic.com/docs/agentic-ai/mcp/overview/), [newrelic/mcp-server](https://github.com/newrelic/mcp-server)
- [Honeycomb MCP](https://docs.honeycomb.io/integrations/mcp/concepts), [honeycombio/honeycomb-mcp](https://github.com/honeycombio/honeycomb-mcp)
- [Axiom MCP](https://axiom.co/docs/console/intelligence/mcp-server)
- [SigNoz MCP server](https://github.com/SigNoz/signoz-mcp-server), [SigNoz docs](https://signoz.io/docs/ai/signoz-mcp-server/)
- [Kubernetes MCP server](https://github.com/containers/kubernetes-mcp-server)
- [GitHub MCP server](https://github.com/github/github-mcp-server)
- [A2A at the Linux Foundation](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), [MCP vs A2A](https://www.truefoundry.com/blog/mcp-vs-a2a)
