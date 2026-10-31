# Grafana connector

| Field | Value |
|---|---|
| Status | **Design only — no connector code exists in this repository** |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.5 (P3 default metrics backend) |
| Trigger | Grafana Alerting webhook |
| Context | Query results from Prometheus/Loki through `/api/ds/query`, alert labels/annotations |
| Writes | None in scope (silences, annotations, alert-rule changes are a later wave) |

Nothing below is implemented.

## 1. Role in the agent

Grafana is a query front end, not a system of record. It gives the agent one HTTP API over whatever data sources the org already runs — usually Prometheus for metrics and Loki for logs — plus Alerting webhooks that say which rule fired and for which labels.

Use it after the failing run or issue is known, to answer "how bad and since when". If the platform already has direct network access and credentials for Prometheus/Loki, query them directly; `/api/ds/query` is the right choice when Grafana is the only allowed ingress.

## 2. Auth model

| Item | Design |
|---|---|
| Header | `Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>` [S53] |
| Identity | Service account, per tenant; Viewer-equivalent role [S54] |
| Basic auth | Available on-premises only; Grafana Cloud uses service-account tokens [S53] |
| Storage | Server-only, encrypted at rest, `(organization, connector)` keyed |
| Rotation | Create a second service-account token, deploy, then delete the first |

Do not use an admin token. A Viewer service account is enough for `datasources:read` and queries.

## 3. Minimal scopes

| Scope | Needed for |
|---|---|
| `datasources:read` | Querying a data source through `/api/ds/query` [S56] |

Writes (silence, annotation, alert-rule change) require separate identities and approval; they are not part of this connector.

## 4. Inbound webhook

| Property | Value |
|---|---|
| Header | Configurable "Header" field in the contact point [S55] |
| Algorithm | HMAC-SHA256, hex-encoded [S55] |
| Signed string | `HMAC(timestamp + ":" + body)` [S55] |
| Timestamp | Optional timestamp header; enables replay protection [S55] |
| Replay | Enforce a 5-minute window; make the timestamp header mandatory for this receiver; constant-time compare |
| Payload | Alertmanager-compatible: `receiver`, `status`, `alerts`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`; per alert `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `fingerprint`, `generatorURL` [S55] |
| Retries | Not documented on the retrieved page — **UNVERIFIED** |

The timestamp header is optional in Grafana, so the receiver must reject a delivery without it rather than silently weakening replay protection.

## 5. Read endpoints for a ContextBundle

| Need | Endpoint | Notes |
|---|---|---|
| Metrics / logs query | `POST /api/ds/query` | `queries` carry a data source UID and expression; `from`/`to` bound the window; requires `datasources:read` [S56] |
| Data source discovery | Data sources API | Exact endpoint not extracted — **UNVERIFIED** |
| Alert metadata | Webhook payload | Use labels/annotations; do not fetch alert-rule history |
| Alert rules | Provisioning API | Exact read path not extracted — **UNVERIFIED** |
| Deploy history | Annotations API | Exact read path not extracted — **UNVERIFIED** |
| Runbook | Alert annotation convention (`runbook_url`) | Not standardized; fall back to the repository runbook — **UNVERIFIED** |

Planned sequence: use the webhook payload for alert identity and labels; issue at most two `/api/ds/query` calls (one metric query, optionally one log query). Bound every query with a time range, max data points and max series in the query template; the model never authors a query.

## 6. Rate limits, pagination, retention

| Constraint | Value | Handling |
|---|---|---|
| API rate limits | No documented numeric limits for Grafana OSS; Cloud limits are plan-dependent — **UNVERIFIED** [S53, S56] | Per-connector bucket; one retry |
| Query size | `/api/ds/query` accepts `queries` and `from`/`to`; the query must bound points and series [S56] | Max data points and max series fixed in the template |
| Retention | Determined by the backing data source (Prometheus/Loki), not by the Grafana API — **UNVERIFIED** | Narrow time window |
| Pagination | Not applicable to `/api/ds/query` | Bound the query instead of paginating |

## 7. What must never enter model context

- Service-account tokens.
- Raw Loki log lines with PII; only a bounded, redacted excerpt.
- Full Prometheus label sets (user ids, emails, customer ids); select only the labels the query needs.
- `generatorURL` query parameters if they contain credentials or internal hostnames.
- Silence comments and free-form annotations without redaction.

## 8. Data retention notes

- Grafana itself does not define retention here; Prometheus and Loki do. The connector must state the window it queried and treat older data as absent.
- Store only a summarized excerpt (≤1,500 characters or 20 points) with a hash; no raw series or log lines. Excerpt TTL 30 days in the survey design.
- Alert labels are the main PII vector; select explicitly rather than returning the whole label set.
- Delete stored excerpts by organization; DSAR support is required.
- Residency follows the Grafana stack and the inference provider.

## 9. Phased implementation checklist

1. **Decide** Cloud vs self-hosted, the data sources (`Prometheus`/`Loki` UIDs), and the query templates.
2. **Transport**: `verifyGrafanaWebhook` with mandatory timestamp header, HMAC over `timestamp:body`, 64 KiB cap, 5-minute window, constant-time compare.
3. **Contract**: map an Alertmanager alert to `IncidentSignal`; severity from a label convention agreed with the user; fingerprint from `alerts[].fingerprint` plus rule identity (not the delivery id).
4. **Reader**: fixed two-query plan; max data points and max series; structural allowlist for logs; `truncated` on any drop.
5. **Tests**: fake fetch; missing timestamp header rejected; stale timestamp rejected; oversized body rejected; query templating cannot be influenced by payload text.
6. **Offline gates** twice with providers disabled; no keys.
7. **Live acceptance** only with explicit authorization: one bounded query and one signed fixture, no retries, spend recorded.
8. **Writes**: silences/annotations/alert rules are out of scope and need a separate identity plus approval.

## 10. Open questions for the user

1. Grafana Cloud or self-hosted, and which data sources are queryable through it?
2. Are there existing query templates/dashboards that encode the right bounds, or must they be written?
3. Which label names carry service, environment, severity and runbook URL?
4. Is a Viewer service account acceptable, or is a narrower data-source-only identity available?
5. May redacted metric/log excerpts leave the region to the inference provider?
6. What retention applies to Prometheus and Loki, and what TTL do you want for stored excerpts?
7. Should the connector query Grafana, or Prometheus/Loki directly?

## 11. Sources

All accessed 2026-10-30; copied from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9.

| ID | Source |
|---|---|
| S53 | [Authentication for the HTTP API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/authentication/) |
| S54 | [Service accounts](https://grafana.com/docs/grafana/latest/administration/service-accounts/) |
| S55 | [Webhook notifier for Alerting](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/) |
| S56 | [Data source HTTP API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/) |
