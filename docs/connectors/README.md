# DevSecOps connectors — operator guide

| Field | Value |
|---|---|
| Audience | Operators who install, bind and rotate connectors |
| Source of record for vendor facts | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) (research, 2026-10-30) |
| Scope | Inbound triggers, read-only context, bounded writes |
| Date | 2026-10-31 |

## 1. What a connector is here

A connector does exactly two things:

1. **Trigger** — accept a signed inbound delivery and turn it into one bounded `IncidentSignal` and one task, through the normal submission path.
2. **Context** — fetch a bounded, redacted, cited `ContextBundle` for that task with a read-only credential.

It is never a generic fetch proxy. Every URL template lives in trusted code; every provider identifier is validated; there is no "fetch this URL" tool. A connector credential is resolved by server code only — it is never placed in a prompt, a tool result, an error message, a URL, or audit details.

An inbound webhook is a **task source, not an execution path**: it can create a task, and it cannot approve, merge, deploy, resolve or comment (`ARCHITECTURE.md` §7–§8, `apps/web/src/routes/api.webhooks.$.tsx`).

## 2. Status matrix

Implemented today: **GitHub** (App auth, incident context, signed intake, two scoped write functions) and the **generic signed webhook**. Every other connector below is design-only with verified free-tier and API facts. Users are expected to connect their **own** accounts; the platform never ships vendor credentials. See [connector-onboarding.md](../connector-onboarding.md) for the per-organization connect flow and [free-tier-catalog.md](free-tier-catalog.md) for the verified free/paid matrix.

| Group | Connectors | Free path | Status |
|---|---|---|---|
| Source control / CI | [GitHub](github.md), [GitHub security alerts](github-security.md) | GitHub App; Dependabot free; code/secret scanning free on public repos, paid on private | GitHub implemented; security alerts design-only |
| Incidents | [Sentry](sentry.md), [PagerDuty](pagerduty.md), [Rollbar](rollbar.md), [Better Stack](betterstack.md), [incident.io](incident-io.md), [Rootly](rootly.md) | Sentry Developer, PagerDuty free (5 users), Rollbar (5k occurrences), Better Stack free; incident.io free excludes API/webhooks; Rootly trial-only | Design-only |
| Metrics / APM | [Grafana](grafana.md), [Datadog](datadog.md), [New Relic](newrelic.md), [Honeycomb](honeycomb.md), [SigNoz](signoz.md), [Axiom](axiom.md), [Elastic](elastic.md), [Splunk](splunk.md) | Grafana Cloud free, Datadog/New Relic/Honeycomb/Axiom free tiers; SigNoz CE and Elastic self-host free; Splunk Free cannot alert | Design-only |
| Logs / traces | [Loki and Tempo](loki-tempo.md), [Prometheus](prometheus.md) | OSS self-host free; Grafana Cloud allowances | Design-only |
| Kubernetes / deploy | [Kubernetes](kubernetes.md), [Argo CD](argocd.md) | OSS self-host free | Design-only |
| Cloud monitoring | [CloudWatch](cloudwatch.md), [Azure Monitor](azure-monitor.md), [GCP Monitoring](gcp-monitoring.md) | Limited always-free allowances; alert webhooks are unsigned (bridge required) | Design-only |
| Uptime | [UptimeRobot](uptimerobot.md), [Uptime Kuma](uptime-kuma.md) | UptimeRobot free (50 monitors); Kuma OSS self-host | Design-only |
| Security scanners | [Snyk](snyk.md), [Semgrep](semgrep.md), [Socket](socket.md), [GitGuardian](gitguardian.md), [Trivy](trivy.md), [OSV-Scanner](osv-scanner.md), [Dependency-Track](dependency-track.md), [DefectDojo](defectdojo.md), [Wazuh](wazuh.md), [Falco](falco.md), [CrowdSec](crowdsec.md), [ZAP](zap.md), [Scorecard](scorecard.md) | OSS free; SaaS free tiers vary; Snyk REST API is Enterprise-only | Design-only |
| Streaming | [Kafka](kafka.md), [Confluent](confluent.md), [Redpanda](redpanda.md), [Aiven Kafka](aiven-kafka.md), [Upstash Kafka](upstash-kafka.md) | Apache Kafka and Aiven free; Confluent/Redpanda trial-only; Upstash discontinued | Design-only |
| Notification | [Slack](slack.md) | Free workspace | Design-only |
| Transport | [Generic signed webhook](generic-webhook.md) | Platform | **Implemented** |

"Design-only" means there is no connector code in this repository. Those pages describe a proposal with verified vendor facts; they must not be read as implemented behavior. The free-tier column is a summary only; each page carries the verified limits, retention and quota caveats.

The GitHub scoped writes were proven live once on 2026-10-31 (one authorized `github.rerun_workflow` call, audit row persisted, run attempt incremented). They are still not registered as agent tools; see [github.md](github.md) §8.3.

## 3. Shared transport rules

Both implemented modes terminate at `POST /api/webhooks/*` (`apps/web/src/routes/api.webhooks.$.tsx`). The mode is chosen from headers alone:

| Mode | Selector | Secret | Signature |
|---|---|---|---|
| GitHub | `x-github-event` is present | `WEBHOOK_GITHUB_SECRET` | `x-hub-signature-256: sha256=<hex>` over the raw body |
| Generic | no `x-github-event` | `WEBHOOK_SIGNING_SECRET` | `x-isolate-timestamp` + `x-isolate-signature: sha256=<hex>` over `${timestamp}.${body}` |

Rules that hold for both (`apps/web/src/server/incident-intake.server.ts`, `apps/web/src/server/webhook-signature.server.ts`, `packages/integrations/src/github/webhook.ts`):

- **Verify the raw bytes.** The HMAC is computed over the body as received, never over a re-serialized object. Comparison is constant-time.
- **Body cap 64 KiB.** The route refuses a declared `content-length` above the cap before reading, and re-checks the streamed total. A larger delivery is `413`.
- **Secret floor 32 characters.** A shorter or empty secret is "not configured" and that mode returns `503`; it is never downgraded to the other verifier.
- **Dedupe.** A delivery is deduplicated by `(organization, source, fingerprint)` for 30 minutes. In GitHub mode the provider delivery id is also stored, for traceability — not as the dedupe key.
- **Audit.** Intake persists the bounded signal row and task provenance for GitHub mode. Connector writes append `audit_events` rows with the `tool.execute` action and bounded `details` (`packages/integrations/src/github/writes.ts`). No raw payload, credential or free-form provider text is recorded.
- **202 before any model work.** The HTTP handler verifies, normalizes, dedupes, resolves the bound repository and submits the task. No inference and no provider fetch happen inside the request. Accepted deliveries return `202` with `taskId`/`jobId`.
- **No echo.** No response, error or log line contains the payload, the signature, the secret, a provider message or a token.
- **Trust.** Webhook payload text is untrusted data. The generated task goal repeats that notice at the top (`UNTRUSTED_INCIDENT_NOTICE`, `apps/web/src/server/incident-intake.server.ts`), and the prompt renders context under an explicit untrusted-data heading (`apps/worker/src/task-execution-handler.ts`).

Recorded per delivery: `incident_signals` row (organization, source, kind, severity, service, fingerprint, delivery id, received time) for GitHub mode only, plus `tasks.incident_source` / `tasks.incident_fingerprint` provenance (`packages/db/migrations/0009_incidents.sql`). Connector writes additionally record `audit_events` through the `tool.execute` action (see [github.md](github.md) §8). There is no raw-payload retention.

## 4. Trust levels

The implemented contract has two levels (`packages/shared/src/types/incident.ts`):

| Level | Meaning | Where it is applied |
|---|---|---|
| `trusted` | Produced by platform code; bound to the task, not to provider text | Reserved by the contract; the GitHub reader emits only `untrusted` |
| `untrusted` | Any provider or repository content | Every GitHub context item (`packages/integrations/src/github/context.ts`) |

Trust is provenance and handling, never authority: no item can grant a permission, select a tool, change a limit or alter ownership. The four-level model in [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §4.3 (`platform`, `repository`, `provider_metadata`, `provider_text`) remains a design proposal; the code does not implement it yet.

## 5. Environment variable names

Names only. Values are server-side, are never documented in this repository, and must never be pasted into a prompt, issue, log or fixture.

| Variable | Used by | Purpose |
|---|---|---|
| `GITHUB_APP_ID` | worker | GitHub App identity |
| `GITHUB_APP_INSTALLATION_ID` | worker | Installation to mint tokens against |
| `GITHUB_APP_PRIVATE_KEY` | worker | Inline PKCS#8 PEM (alternative to the path) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | worker | Server-side file containing the PKCS#8 PEM |
| `GITHUB_API_BASE_URL` | worker | API origin override; default `https://api.github.com` |
| `WEBHOOK_GITHUB_SECRET` | web | GitHub webhook HMAC secret |
| `WEBHOOK_SIGNING_SECRET` | web | Generic-mode HMAC secret |
| `WEBHOOK_ORGANIZATION_ID` | web | Bound tenant (server-side, never from the body) |
| `WEBHOOK_ACTOR_ID` | web | Bound actor for created tasks |
| `WEBHOOK_ACTOR_ROLE` | web | `owner` / `admin` / `member` (default `member`) |
| `WEBHOOK_REPOSITORY_ID` | web | The one repository a delivery may submit into |
| `WEBHOOK_BRANCH` | web | Branch the task works on |
| `WEBHOOK_WORKFLOW_DEFINITION_ID` | web | Pinned workflow definition |
| `WEBHOOK_WORKFLOW_VERSION` | web | Pinned workflow version |
| `WEBHOOK_FILE_OWNERSHIP` | web | Comma-separated owned paths (empty means no writes) |
| `WEBHOOK_SERVICE` | web | Optional service filter; absent routes any service to the repository |
| `WEBHOOK_MAX_AGENT_TURNS` | web | Optional per-incident turn budget |
| `DATABASE_URL` | web | Required by the intake composition root |

Binding rules are in `apps/web/src/server/incident-intake-runtime.server.ts`. There is exactly one binding per deployment: the route path after `/api/webhooks/` is accepted but not used for routing.

## 6. Pages

Cross-cutting documents:

- [connector-onboarding.md](../connector-onboarding.md) — how a user connects an account, how credentials are stored/rotated, how the sandbox agent gets tool access, and the free-tier guardrails.
- [connector-usage.md](../connector-usage.md) — adapter contract, credential broker, multi-connector routing and implementation order.
- [free-tier-catalog.md](free-tier-catalog.md) — verified free/paid matrix and recommended defaults.
- [env-reference.md](env-reference.md) — every connector env name, grouped (names only; values blank).
- [_template.md](_template.md) — checklist for the next connector.

Implemented:

- [github.md](github.md) — App auth, read-only context reader, signed intake, `github.comment` / `github.rerun_workflow`.
- [generic-webhook.md](generic-webhook.md) — signed transport for any system without a native connector.

Design-only, by group:

- Incidents: [sentry.md](sentry.md), [pagerduty.md](pagerduty.md), [rollbar.md](rollbar.md), [betterstack.md](betterstack.md), [incident-io.md](incident-io.md), [rootly.md](rootly.md), [slack.md](slack.md).
- Metrics and APM: [grafana.md](grafana.md), [prometheus.md](prometheus.md), [datadog.md](datadog.md), [newrelic.md](newrelic.md), [honeycomb.md](honeycomb.md), [signoz.md](signoz.md), [axiom.md](axiom.md), [elastic.md](elastic.md), [splunk.md](splunk.md).
- Logs and traces: [loki-tempo.md](loki-tempo.md).
- Kubernetes and deploy: [kubernetes.md](kubernetes.md), [argocd.md](argocd.md).
- Cloud monitoring and uptime: [cloudwatch.md](cloudwatch.md), [azure-monitor.md](azure-monitor.md), [gcp-monitoring.md](gcp-monitoring.md), [uptimerobot.md](uptimerobot.md), [uptime-kuma.md](uptime-kuma.md).
- Security: [github-security.md](github-security.md), [snyk.md](snyk.md), [semgrep.md](semgrep.md), [socket.md](socket.md), [gitguardian.md](gitguardian.md), [trivy.md](trivy.md), [osv-scanner.md](osv-scanner.md), [dependency-track.md](dependency-track.md), [defectdojo.md](defectdojo.md), [wazuh.md](wazuh.md), [falco.md](falco.md), [crowdsec.md](crowdsec.md), [zap.md](zap.md), [scorecard.md](scorecard.md).
- Streaming: [kafka.md](kafka.md), [confluent.md](confluent.md), [redpanda.md](redpanda.md), [aiven-kafka.md](aiven-kafka.md), [upstash-kafka.md](upstash-kafka.md).

## 7. Non-negotiable operator rules

1. Do not put a credential in a prompt, a task goal, a webhook body, a fixture or a ticket.
2. Do not widen an App or API-key scope to make a call succeed; add the narrow scope and record why.
3. Do not enable a write path before its offline tests pass and a single bounded live acceptance has been approved.
4. Rotate secrets on the schedule your organization requires; the receiver supports one active secret per mode (see [generic-webhook.md](generic-webhook.md) §7).
5. Treat every provider response as hostile text. Redaction and caps are enforced in code, not by provider masking.
