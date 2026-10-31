# Uptime Kuma connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** (no module, verifier, reader or tool exists) |
| Free tier verified | 2026-10-31 (Uptime Kuma docs and upstream source) |
| Auth | Prometheus API key in an `Authorization` header; inbound uses an unsigned webhook plus a bridge secret |
| Inbound | Notification "Webhook" (unsigned, static headers only) → bridge → our HMAC webhook |
| Read | Prometheus text endpoint `GET /metrics`; no supported REST API |
| Writes | None in scope (no monitor, notification or settings mutation) |

This page follows [`_template.md`](_template.md) and [`README.md`](README.md). Everything below is design; no Uptime Kuma code exists in this repository.

## 1. Role in the agent

Uptime Kuma is a self-hosted, open-source uptime monitor. The connector answers "which internal or external check is down, since when, and what are its current status, response time and uptime ratio". The trigger is the primary value, but the trigger is unsigned; the read path is the trustworthy one. **Recommendation: use the Prometheus `/metrics` path for all reads**, because there is no supported REST API; use the unsigned webhook only as a hint through the bridge.

It must not be used as a generic HTTP scraper, as a Prometheus replacement for application metrics, or to read the SQLite database. Uptime Kuma has no stable public REST API; the connector must not pretend it does.

## 2. Free tier and quotas

| Item | Value | Notes |
|---|---|---|
| License cost | **None**; self-hosted open source | You pay for the host, database and backup [S1] |
| Monitor count / interval | Not a paid-tier limit; bounded by the host and the instance's minimum interval | Exact minimum interval was not extracted — **UNVERIFIED** |
| Metrics endpoint | `GET /metrics` in Prometheus text format | Read-only; no per-request fee [S2] |
| Metrics auth | Prometheus API key in the `Authorization` header; adding the first key disables basic auth for the endpoint | Version 1.21.0+ behavior [S2] |
| Public REST API | **None supported.** The internal API is "not officially supported for third-party integrations" and may change without notice | Do not build against it [S1] |
| Webhook notifications | A generic Webhook notification type exists for developers | No signing [S3] |
| Retention | Heartbeat retention is configurable in the instance settings; the default was not extracted — **UNVERIFIED** | The connector does not query history |
| Rate limits | No documented numeric API limit for `/metrics`; the practical limit is the scrape cost and the instance's CPU | One scrape per bundle [S1] |
| Trial / credits | Not applicable; there is no vendor plan | The platform supplies the compute |

The "free" claim is about software licensing, not operations: a self-hosted instance needs a public HTTPS endpoint for the bridge, a persistent volume, and a backup. Do not describe it as a zero-cost SaaS.

## 3. Auth and least privilege

| Item | Design |
|---|---|
| Read credential | Prometheus API key, created under Settings → API Keys; sent as `Authorization` on `GET /metrics` [S2] |
| Key scope | Metrics only. There is no separate REST scope because there is no supported REST API [S1] |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | Create a second key, deploy, verify one scrape, delete the first; one active key |
| Inbound secret | A separate 32+ character bridge secret (path or static header); never the Prometheus key |
| Base URL | Operator-configured, absolute `https://`, exact host allowlist; no redirects; no model-supplied URL |

The basic-auth behavior on `/metrics` changes when the first API key is added. Document that transition in the operator runbook; an existing scrape that used basic auth will start failing. Never put the key in the scrape URL, a log line or an error message.

## 4. Inbound trigger

Uptime Kuma notification providers include a generic Webhook. It is a notification sink, not a signed event feed.

| Property | Value |
|---|---|
| Method / content | HTTP POST; content type selectable; request body template [S3] |
| Fields | Post URL, content type, additional headers, and a body template. The default JSON contains `heartbeat` and `monitor` objects; exact fields are version-dependent — **UNVERIFIED** [S3] |
| Signature | **None.** The provider adds no HMAC or signature; additional headers can carry a static secret only [S3] |
| Retries | Not documented; assume none — **UNVERIFIED** |
| Bridge requirement | High-entropy path plus optional static header; then **re-scrape `/metrics`** with the API key to confirm the monitor is DOWN; then sign with our generic HMAC |
| Receiver | `POST /api/webhooks/uptime-kuma` with `X-Isolate-Timestamp` and `X-Isolate-Signature` over `${timestamp}.${body}` |
| Body cap | 64 KiB at the bridge and receiver |
| Trigger filter | Only a DOWN transition (`monitor_status == 0`) creates a task. UP and PENDING do not |
| Dedupe | Fingerprint `uptimekuma:<monitorID>:down`, 30-minute bucket; there is no delivery ID |
| Severity | `high` for an allowlisted production monitor; `medium` otherwise and dropped before submission |

The webhook body is untrusted and version-dependent. The bridge must extract only the monitor ID, then look up the authoritative status in `/metrics`; it must not map arbitrary body fields into the signal. A forged webhook therefore cannot invent a monitor or a status unless the monitor is already DOWN in the instance.

## 5. Read-only context

| Need | Endpoint | Parameters and bounds | Source |
|---|---|---|---|
| Monitor status and ratios | `GET {UPTIME_KUMA_BASE_URL}/metrics` | `Authorization` header with the Prometheus key; parse text; no query parameters; one scrape | [S2] |
| Monitor identity | Same scrape | Labels `monitor_id`, `name`, `type`, `url`, plus configured tags | [S5] |
| Uptime ratio | Same scrape | `monitor_uptime_ratio` with a `window` label (for example 24h/30d/1y); select at most two windows | [S5] |
| Response time | Same scrape | `monitor_response_time` / `monitor_response_time_seconds`; select at most 60 samples | [S5] |
| Certificate | Same scrape | `monitor_cert_days_remaining`, `monitor_cert_is_valid`; do not use as an incident trigger | [S5] |
| Heartbeat history | Not fetched | The internal API and database are unsupported; no history is read | [S1] |

Verified metric names: `monitor_status`, `monitor_response_time`, `monitor_response_time_seconds`, `monitor_uptime_ratio`, `monitor_cert_days_remaining`, `monitor_cert_is_valid` [S5]. Labels include `monitor_id`, `name`, `type`, `url`, `hostname`, `port`, and a `window` label where applicable [S5].

Caps: one scrape per bundle; 100 items (shared contract); at most 5 allowlisted monitors; at most 60 response-time samples per monitor; 4,000 characters per context item; 256 KiB total. The reader must not return the whole metrics text. It selects the allowlisted series and summarizes status, two ratios, the latest response time and the certificate fields.

## 6. Framework fit

| Item | Design |
|---|---|
| Module | `packages/integrations/src/uptime-kuma/` (design only) |
| Source enum | Add `uptime_kuma` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a **contract commit before any adapter** |
| Transport | `verifyUptimeKumaBridgeSecret` and `normalizeUptimeKumaAlert` in the operator bridge; `signGenericDelivery` for our HMAC |
| Reader | `fetchUptimeKumaIncidentContext(deps, input)` with injected fetch, clock and Prometheus parser |
| Tools | `uptimekuma.get_monitor_status` (`read_only`) only |
| Risk bands | `read_only`; no notification, monitor or settings write exists |
| Env | `UPTIME_KUMA_BASE_URL`, `UPTIME_KUMA_API_KEY`, `UPTIME_KUMA_MONITOR_ALLOWLIST`, `UPTIME_KUMA_WEBHOOK_TOKEN`, `WEBHOOK_SIGNING_SECRET` |
| Audit | One row per read with org, task, monitor ID, item count, duration and outcome; never the API key or the full metrics payload |

Sandbox implications: the reader runs in the worker; the sandbox has egress deny and no key. `UPTIME_KUMA_BASE_URL` is validated as absolute https with no userinfo, query or fragment, and the host is pinned; redirects are not followed. The model supplies no URL and no label selector. Results are redacted and truncated before the prompt.

Tests (fakes only): a wrong bridge secret is rejected; a forged DOWN body for a monitor that is UP in `/metrics` creates nothing; a missing monitor is `NOT_FOUND`; the parser handles a malformed metric line by dropping it and setting `truncated`; 60-sample and 256 KiB caps hold; the base URL with userinfo or a redirect is rejected; no key appears in an error.

## 7. Operator setup checklist

1. Self-host Uptime Kuma behind HTTPS with a persistent volume. Record the exact base URL.
2. Create a Prometheus API key (Settings → API Keys). Confirm `GET /metrics` works with the `Authorization` header and note that basic auth is now disabled for that endpoint.
3. Add a Webhook notification with a high-entropy path and an optional static `Authorization` header; set a minimal JSON body containing the monitor ID and status.
4. Attach the notification only to the monitors in `UPTIME_KUMA_MONITOR_ALLOWLIST`. Keep the instance's minimum interval aligned with the 5-minute incident cap.
5. Deploy the bridge with the 64 KiB cap, secret check, `/metrics` re-scrape and HMAC signing.
6. Confirm offline gates with no key, then force one DOWN state on a test monitor and verify one task and one dedupe no-op.
7. Add the key last. This page does not authorize a live call.

```dotenv
UPTIME_KUMA_BASE_URL=
UPTIME_KUMA_API_KEY=
UPTIME_KUMA_MONITOR_ALLOWLIST=
UPTIME_KUMA_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

Names only; values are server-side and never committed, logged or placed in a fixture.

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] Bridge: missing/wrong secret rejected with no echo; oversized body `413`; forged DOWN body contradicted by `/metrics` creates nothing.
- [ ] Normalizer: only DOWN; severity high only for allowlisted production monitors; fingerprint stable for repeated notifications.
- [ ] Reader fakes: one scrape, 5 monitors and 60 samples; malformed lines dropped with `truncated`; base URL validation rejects userinfo, query, fragment and redirects.
- [ ] Redaction seeds for bearer tokens, emails, IPv4, URLs with query tokens and certificate subjects.
- [ ] Intake: monitor outside the allowlist is `NOT_FOUND`; third active incident is throttled; replay creates nothing.
- [ ] `bun run validate` twice with providers disabled.

Live (separate explicit authorization; one bounded read, no retries):

- [ ] One `GET /metrics` scrape of the self-hosted instance; parse one allowlisted monitor; record the response size and item count.
- [ ] One signed bridge delivery for a test monitor in DOWN state; verify one task and no second task on replay.
- [ ] Stop at the first cap; no spend to record (self-hosted).

## 9. Risks and what must never enter model context

- The webhook is unsigned. The authoritative status is `/metrics`, so the bridge must always re-read it; otherwise a forged notification can create a task.
- The internal API is explicitly unsupported. A future upgrade can break it; the design must not depend on it.
- `/metrics` exposes every monitor, URL, hostname and port to the key holder. The reader selects allowlisted series only, and still treats labels as untrusted.
- A self-hosted instance can be an SSRF target if the base URL is model-influenced. Keep it operator-pinned, https-only and redirect-free.
- Never in context: API key, bridge secret, full metrics text, heartbeat history, notification settings, SMTP/webhook credentials, customer hostnames beyond the one allowlisted monitor, URLs with query tokens.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Uptime Kuma internal API documentation](https://uptime.kuma.pet/docs/Internal-API/) |
| S2 | [Prometheus API keys (Uptime Kuma wiki)](https://github.com/louislam/uptime-kuma/wiki/Prometheus-API-Keys) |
| S3 | [Webhook notification provider source](https://github.com/louislam/uptime-kuma/blob/master/server/notification-providers/webhook.js) |
| S4 | [Notification methods (Uptime Kuma wiki)](https://github.com/louislam/uptime-kuma/wiki/Notification-Methods) |
| S5 | [Prometheus metrics source](https://github.com/louislam/uptime-kuma/blob/master/server/prometheus.js) |
