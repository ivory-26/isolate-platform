# Datadog connector

| Field | Value |
|---|---|
| Status | **Design only — no connector code exists in this repository** |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.4 (P3 alternative) |
| Trigger | Datadog webhook (unsigned; treated as a hint) |
| Context | Incidents, metrics, logs, monitor state |
| Writes | None in scope (mute, annotate, incident edits are a later wave) |

Nothing below is implemented.

## 1. Role in the agent

Datadog answers "what changed and how bad is it" after a run or issue has been identified: incident severity, a bounded metric window, a small number of log lines, monitor state. It is not a code-location source; pair it with GitHub.

Pick Datadog when it is the monitoring system of record and scoped application keys are available. Pick Grafana instead when the org already queries Prometheus/Loki through Grafana and you do not want a second vendor relationship (survey §5.4).

## 2. Auth model

| Item | Design |
|---|---|
| Headers | `DD-API-KEY` (API key) and `DD-APPLICATION-KEY` (application key) on most read endpoints [S61] |
| Key semantics | API keys are organization-wide and submit data; application keys grant programmatic access and can be **scoped** to explicit permissions [S45] |
| Scope stability | A scoped application key keeps its scopes even if the owning user's role changes; review the key's scopes independently [S45] |
| Key choice | One dedicated scoped application key per tenant and environment; never a personal full-access key |
| Storage | Server-only, encrypted at rest, `(organization, connector)` keyed; both values are secrets |

## 3. Minimal scopes

| Scope | Needed for |
|---|---|
| `metrics_read` | Timeseries queries [S46] |
| `logs_read_data` | Log search [S46] |
| `incident_read` | Incidents [S46] |
| `monitors_read` | Monitor state [S46] |
| `dashboards_read` | Optional; only if a dashboard definition is evidence |

No write scopes for this connector. Muting a monitor, creating an annotation or editing an incident requires separate credentials and approval.

## 4. Inbound webhook

| Property | Value |
|---|---|
| Signature | **No message signing documented.** Datadog webhooks support HTTP Basic Auth or OAuth 2.0, and custom headers can be configured [S50] |
| Control | Per-connector shared secret in a custom header **plus** an API re-fetch of the monitor/incident before task creation |
| Timeout / retries | 15-second timeout; retried up to 5 times on 5xx or internal error [S50] |
| Replay | No signature and no timestamp; dedupe by monitor/incident id + alert timestamp, reject stale events, re-fetch current state |
| IP allowlist | Not documented in the retrieved page — **UNVERIFIED** |

Because the payload is unsigned, it is a **hint**, not evidence. The authoritative state comes from `GET /api/v2/incidents/{incident_id}` or the monitor API. A forged payload can at most cause a re-fetch of real state.

If a custom-header secret is used, it is still not a signature: it proves the sender knows the header value, not that the body is unmodified. Always re-fetch before creating a task.

## 5. Read endpoints for a ContextBundle

Base host: `https://api.<site>` (US1, US3, EU, or another site). Paths below are from the survey; two read paths could not be extracted.

| Need | Endpoint | Notes |
|---|---|---|
| Incident metadata | `GET /api/v2/incidents`; `GET /api/v2/incidents/{incident_id}` | `title`, `severity`, `state`, `created`, `modified`, `customer_impact` [S49] |
| Metrics query | `POST /api/v2/query/timeseries` | Bounded query with `from`/`to`; return a few series only [S47] |
| Logs search | `POST /api/v2/logs/events/search` | `filter.query`, `from`, `to`, `page.limit`; never return raw lines wholesale [S48] |
| Monitor state | Monitor API (`monitors_read`) | Exact endpoint not extracted — **UNVERIFIED** |
| Deploy history | Datadog deployment/event tracking | Exact endpoint not extracted — **UNVERIFIED** |
| Runbook | No standard field | Check the monitor/incident message for a `runbook_url` convention; otherwise the repository runbook |

Planned sequence: incident (1 call) → monitor state (1) → metrics (≤2) → logs (≤1). Total ≤6 calls, one page each, narrow window (last 15–60 minutes).

## 6. Rate limits, pagination, retention

| Constraint | Value | Handling |
|---|---|---|
| Rate-limit headers | `X-RateLimit-Limit`, `X-RateLimit-Period`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Name` [S51] | Respect them; one retry after reset |
| Metrics query limit | Numeric per-endpoint limit not stated — **UNVERIFIED** | Cap at 6 queries per bundle |
| Logs query limit | Not stated for the search endpoint — **UNVERIFIED** | Cap at one page, 100 records |
| Pagination | Endpoint-specific cursor/page limits — **UNVERIFIED** | One page, 100 records |
| Retention | Metrics 15 months; logs determined by plan; incidents and monitors retained for the account lifetime [S52] | Prefer a narrow time window; never build a corpus |

## 7. What must never enter model context

- Raw log lines containing customer data, PII or request bodies. Datadog logs carry arbitrary attributes; allowlist only `service`, `env`, `status`, `error.kind`, `error.message` and a bounded message excerpt.
- API keys and application keys.
- Full `customer_impact` free text unless redacted and bounded.
- Dashboard/query text that embeds secrets or internal hostnames.
- Full monitor definitions, including notification webhook URLs and secrets.

## 8. Data retention notes

- Provider retention: metrics 15 months, logs plan-dependent, incidents and monitors for the account lifetime [S52]. The connector must not depend on logs older than the plan allows.
- Store only derived excerpts (≤1,500 characters or 20 metric points) with a hash; no raw events. Excerpt TTL 30 days in the survey design.
- Log attributes are the highest PII risk; structural allowlisting runs before truncation.
- Delete stored excerpts by organization; DSAR support is required.
- Data residency follows the Datadog site and the inference provider region; both are open questions.

## 9. Phased implementation checklist

1. **Decide** the Datadog site (US1/US3/EU/other), confirm scoped application keys are enabled, and name the tenant mapping.
2. **Transport**: accept only a custom-header secret plus source IP controls if available; treat the body as a hint and re-fetch canonical state.
3. **Contract**: map an incident or monitor alert to `IncidentSignal`; severity from incident severity; service from the monitor/incident tags.
4. **Reader**: fixed ≤6-call plan; structural allowlist for logs; bounded metric query with max data points; `truncated` on any drop.
5. **Tests**: fake fetch; unsigned/forged payload causes re-fetch, not task creation from payload alone; `429`; plan-level log absence.
6. **Offline gates** twice with providers disabled; no keys.
7. **Live acceptance** only with explicit authorization: one read of a named incident and one bounded metric query, no retries, spend recorded.
8. **Writes**: out of scope; mute/annotate/edit need separate scoped keys and approval.

## 10. Open questions for the user

1. Which Datadog site, and are scoped application keys enabled on the plan?
2. Are logs in scope, or metrics and incidents only? Logs carry the highest PII risk.
3. Which services/environments may create tasks, and at which severity?
4. Is a custom shared header acceptable given there is no documented HMAC?
5. How much metric history is useful — points and window?
6. May redacted log excerpts leave the region to the inference provider?
7. What is the retention requirement for stored excerpts, and is a delete workflow required?
8. Is Datadog the system of record for incidents, or does PagerDuty own them?

## 11. Sources

All accessed 2026-10-30; copied from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9.

| ID | Source |
|---|---|
| S45 | [API and Application keys](https://docs.datadoghq.com/account_management/api-app-keys/) |
| S46 | [RBAC permissions](https://docs.datadoghq.com/account_management/rbac/permissions/) |
| S47 | [Metrics API](https://docs.datadoghq.com/api/latest/metrics/) |
| S48 | [Logs API](https://docs.datadoghq.com/api/latest/logs/) |
| S49 | [Incidents API](https://docs.datadoghq.com/api/latest/incidents/) |
| S50 | [Webhooks integration](https://docs.datadoghq.com/integrations/webhooks/) |
| S51 | [API rate limits](https://docs.datadoghq.com/api/latest/rate-limits/) |
| S52 | [Data retention periods](https://docs.datadoghq.com/data_security/data_retention_periods/) |
| S61 | [API reference index](https://docs.datadoghq.com/api/latest/) |
