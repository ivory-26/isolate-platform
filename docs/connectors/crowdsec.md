# CrowdSec connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | MIT, verified 2026-10-31; free, self-hosted |
| Auth | Bouncer API key in `X-Api-Key` for decisions; static header for notifications |
| Inbound | HTTP notification plugin (unsigned) through a signed bridge |
| Read | Local API `/v1/decisions` with a bouncer key |
| Writes | None in scope; adding a ban decision is `sensitive` |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

CrowdSec is an open-source security engine that detects abusive behaviour from logs and shares decisions with remediation components ("bouncers"). It has a local API (LAPI) and no SaaS requirement.

## 1. Role in the agent

CrowdSec answers "which source is being banned, for what scenario, and for how long". It is a network-abuse trigger (brute force, scanning, application attacks), not a code scanner and not a host-integrity tool.

Kinds proposed: `decision_ban` (an IP or range banned), `decision_captcha`, `alert_overflow` (a scenario overflowed without a decision).

Severity mapping (platform mapping; the decision type is the strongest signal):

| CrowdSec decision / alert | `IncidentSignal.severity` |
|---|---|
| `ban` on a range or repeated scenario | `critical` |
| `ban` on a single IP | `high` |
| `captcha` | `medium` |
| `throttle` or no decision | `low` |

Do not use the scenario name to guess severity; scenario names are community-maintained and change.

Fingerprint: `crowdsec:<scenario>:<scope>:<sha256(value)[:16]>`. Hashing the IP/range keeps personal data out of task provenance while remaining stable for the same decision. The decision id and alert id are traceability only.

Evidence: scenario, decision type, scope (`Ip`, `Range`, `Country`), duration, origin, ASN/country if present, and a console link. The raw IP is **not** placed in the title or summary; see §9.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | MIT | [S1] |
| Cost | Free; you pay for the engine host and log volume | [S1], [S2] |
| SaaS | None required; LAPI is local | [S2] |
| Community blocklist | The community sharing service is optional; disabling it is supported | [S2] |
| API limit | No published LAPI quota — **UNVERIFIED** as a number | [S3] |
| Retention | Alerts and decisions live in the local database; retention is operator-configured | [S3] |

Cost caveats: the security engine parses logs continuously; high log volume drives CPU. The local database grows with alerts and decisions, so a retention/cleanup policy is required. Bouncers poll the LAPI; many bouncers with short intervals increase load.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| Bouncer read | API key in `X-Api-Key` | Created with `cscli bouncers add <name>`; a wrong key returns `403` [S3] |
| Notification | Static header (for example `Authorization`) | Configured in the HTTP plugin `headers` [S4] |
| Bridge to platform | HMAC secret | Generic signed transport |

A bouncer key is deliberately limited: bouncers may only use the `/decisions` path [S3]. It cannot read alerts, modify scenarios or administer the engine. That is the correct key for this connector's read path.

The engine's own credentials (machine credentials, `cscli` access) are not used by the connector and must never be stored in it. If the bridge needs to verify a notification header, use a dedicated random value, not a bouncer key.

Rotation: `cscli bouncers add` a second bouncer, deploy the key, verify a decision lookup, then delete the first. Rotate the notification header separately.

## 4. Inbound trigger

CrowdSec ships an **HTTP notification plugin** by default. It posts the alerts that pass a profile's filter to a configured URL [S4]:

```yaml
type: http
name: http_default
format: |
  {{.|toJson}}
url: https://bridge.example.com/crowdsec
method: POST
headers:
  Authorization: Bearer <static-secret>
group_wait: 30s
group_threshold: 10
max_retry: 3
timeout: 10s
```

The body is a JSON list of `models.Alert` objects. The plugin does **not** compute a signature, so the bridge authenticates the caller with a static header or mTLS and then normalizes and re-signs:

| Property | Value |
|---|---|
| Platform endpoint | `POST /api/webhooks/crowdsec` |
| Signature | `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}` |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes |

Batching matters: `group_wait` and `group_threshold` send several alerts in one request. The bridge must split them into individual signals (one fingerprint each), not treat the batch as one incident. If a batch exceeds 64 KiB, split before signing; never truncate the array.

A `max_retry` of 3 is the plugin's retry, not the platform's. Duplicate deliveries must collapse on the fingerprint.

`crowdsec` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

## 5. Read-only context

| Need | Endpoint | Fields used | Source |
|---|---|---|---|
| Decisions for an IP | `GET /v1/decisions?ip={ip}` | `id`, `origin`, `scenario`, `scope`, `type`, `value`, `duration` | [S3] |
| Decision stream | `GET /v1/decisions/stream?startup=true` | new/expired decisions; not used for a single incident | [S3] |
| Alerts | Not available to a bouncer key | Requires machine/`cscli` credentials; **out of scope** | [S3] |

Fixed plan: zero or one decision lookup per bundle. The notification payload is the primary evidence; the lookup confirms whether the decision is still active. Caps: 50 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout.

The bouncer key cannot read alerts, so there is no alert-body fetch and no `cscli` shell-out. Context is the allowlisted alert fields plus the decision lookup. Country and ASN, when present, are useful and lower-risk than the raw IP.

Never read: the engine's local database, raw log lines that triggered the scenario, HTTP request bodies, or the community sharing payload.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/crowdsec/` |
| Source enum | Add `crowdsec` to `INCIDENT_SOURCES` before the adapter |
| Tools | `crowdsec.get_decision` (`read_only`), `crowdsec.list_active_decisions` (`read_only`), `crowdsec.add_decision` (`sensitive`, proposed) |
| Risk bands | Adding a ban is `sensitive` (it blocks traffic); deleting a decision is `destructive`; both are out of scope for v1 |
| Env names | `CROWDSEC_URL`, `CROWDSEC_TOKEN`, `CROWDSEC_WEBHOOK_SECRET` |
| Sandbox | Server-side only. No bouncer key in the sandbox, no `cscli`, no engine socket; egress deny |
| Tests | Fake LAPI, batch notification splitting, hashed fingerprint, missing decision, `403`/`429`, tenant isolation |

`CROWDSEC_URL` is the LAPI origin (default `http://127.0.0.1:8080`); production must use TLS through a reverse proxy or the LAPI's TLS listener. `CROWDSEC_TOKEN` is the bouncer key. `CROWDSEC_WEBHOOK_SECRET` signs the bridge delivery.

## 7. Operator setup checklist

1. Deploy the security engine and confirm `cscli decisions list` works locally.
2. Create a dedicated bouncer: `cscli bouncers add isolate-connector`; store the key server-side.
3. Configure the HTTP notification plugin with the bridge URL, a static header, `group_wait`, `group_threshold` and a timeout.
4. Enable the plugin in the relevant profile (`notifications: [http_default]`).
5. Deploy the bridge with a 32+ character HMAC secret; point it at `https://<host>/api/webhooks/crowdsec`.
6. Add `crowdsec` to `INCIDENT_SOURCES`; deploy the contract before enabling the profile.
7. Generate a test ban with `cscli decisions add -i 192.0.2.10`; confirm one task and one deduped resend.
8. Delete the test decision and confirm no write path is exposed to the agent.

```dotenv
# Names only. Values are server-side and never documented here.
CROWDSEC_URL=
CROWDSEC_TOKEN=
CROWDSEC_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Batch of 3 alerts produces 3 signals, not 1; each has its own fingerprint.
- [ ] Severity map for ban/captcha/throttle; scenario name does not affect severity.
- [ ] IP hashing: same value produces the same fingerprint; raw value absent from title/summary.
- [ ] Decision lookup `404`/empty result degrades to a partial bundle.
- [ ] Wrong bouncer key returns `403`; bridge rejects unsigned or stale deliveries.

Live (opt-in, local, free):

- [ ] One local container smoke: engine + a test ban; one notification to the bridge.
- [ ] One task; one deduped resend; decision lookup confirms active.
- [ ] No metered spend; record container image and database size.

## 9. Risks and never in model context

- **Never**: bouncer keys, machine credentials, the engine database, raw log lines, HTTP request bodies, the community sharing payload.
- **Never**: the raw IP or range in a title, summary or excerpt. IP addresses are personal data in many jurisdictions. Put the hashed value in the fingerprint, country/ASN in the summary, and a console link for the operator.
- A ban decision can block a shared NAT or a legitimate customer; automated blocking is out of scope and requires approval.
- Scenario names and alert messages are community text and untrusted; they can contain injected instructions.
- A bouncer key is read-only for decisions but still sensitive; it must not be reused as the notification header.
- Batched notifications can hide volume; count alerts per batch and apply the per-source cap.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [crowdsecurity/crowdsec](https://github.com/crowdsecurity/crowdsec) (MIT) |
| S2 | [CrowdSec concepts](https://docs.crowdsec.net/docs/concepts) |
| S3 | [Local API for remediation components](https://github.com/crowdsecurity/crowdsec-docs/blob/main/crowdsec-docs/docs/local_api/bouncers-api.md) |
| S4 | [HTTP notification plugin](https://docs.crowdsec.net/docs/next/local_api/notification_plugins/http/) |
| S5 | [Local API introduction](https://docs.crowdsec.net/docs/local_api/intro) |
| S6 | [CrowdSec documentation](https://docs.crowdsec.net/) |
