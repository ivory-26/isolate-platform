# Generic signed webhook

| Field | Value |
|---|---|
| Status | **Implemented** (transport + intake); no read API, no writes |
| Code | `apps/web/src/server/webhook-signature.server.ts`, `apps/web/src/server/incident-intake.server.ts`, `apps/web/src/routes/api.webhooks.$.tsx` |
| Contract | `packages/shared/src/types/incident.ts` (`incidentSignalSchema`) |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.7 |

This is the fallback trigger for any system without a native connector: a deploy bot, a cron monitor, an internal scanner. It carries no provider credential and grants no read access. It turns a signed JSON document into one task.

## 1. What actually exists

```
Sender ──► POST /api/webhooks/<anything>
           │  x-isolate-timestamp + x-isolate-signature
           │  HMAC-SHA256 over `${timestamp}.${rawBody}`
           │  ±300 s window, 64 KiB cap
           │  strict IncidentSignal JSON
           │  30-minute fingerprint dedupe
           ▼
        task submitted through the normal submission path (202)
```

No model call and no provider fetch happen in the request. There is no endpoint registry: the path after `/api/webhooks/` is accepted and ignored. Use any stable segment, for example `/api/webhooks/generic`; the splat route expects one. One deployment serves exactly one binding (one organization, one repository). This differs from the survey's per-endpoint id design; see §7 and §10.

## 2. Request format

| Property | Value | Source |
|---|---|---|
| Method / path | `POST /api/webhooks/*` | `apps/web/src/routes/api.webhooks.$.tsx` |
| Mode selector | No `x-github-event` header | `detectIncidentIntakeMode` |
| Timestamp header | `X-Isolate-Timestamp`: Unix seconds, digits only, 1–12 characters | `WEBHOOK_TIMESTAMP_HEADER` |
| Signature header | `X-Isolate-Signature: sha256=<64 hex>` | `WEBHOOK_SIGNATURE_HEADER`, `WEBHOOK_SIGNATURE_PREFIX` |
| Signed string | `${timestamp}.${rawBody}` where `timestamp` is the header string **verbatim** | `verifyWebhookSignature` |
| Algorithm | HMAC-SHA256, constant-time comparison | `verifyWebhookSignature` |
| Freshness | Absolute difference from server time ≤ 300 s (past or future) | `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` |
| Body cap | 64 KiB, checked against `content-length` and the streamed total | `WEBHOOK_MAX_BODY_BYTES`, `readBoundedWebhookBody` |
| Secret floor | 32 characters; shorter or empty means not configured | `WEBHOOK_MIN_SECRET_LENGTH` |
| Content type | JSON body parsed as UTF-8; the signature covers the bytes, not the parsed object | `incident-intake.server.ts` |

A non-hex digest, a missing `sha256=` prefix, a malformed timestamp and an oversized body are rejected before the secret comparison.

## 3. Body contract

The body must be a strict `IncidentSignal`. Unknown fields are rejected.

| Field | Rule |
|---|---|
| `source` | One of `github`, `sentry`, `pagerduty`, `datadog`, `grafana`, `generic` |
| `kind` | 1–64 characters |
| `severity` | `critical`, `high`, `medium`, `low`, `info` |
| `service` | 1–128 characters; used to resolve the bound repository |
| `fingerprint` | 1–128 characters; source-stable, never a delivery id |
| `title` | 1–200 characters |
| `summary` | 0–2,000 characters |
| `links` | ≤10 items, each `{label ≤120, url}` with an https URL ≤512 characters and no userinfo |
| `receivedAt` | ISO-8601 with offset |

Caps: `packages/shared/src/types/incident.ts`. There is no field for an organization, repository, workflow or credential — those come from the server binding only.

Minimal valid body:

```json
{
  "source": "generic",
  "kind": "deploy_failed",
  "severity": "high",
  "service": "checkout-api",
  "fingerprint": "deploybot:checkout-api:prod:2026-10-31T09:00Z",
  "title": "Production deploy failed",
  "summary": "Deploy 8841 exited 1 during migration.",
  "links": [{ "label": "Deploy log", "url": "https://ci.example.com/builds/8841" }],
  "receivedAt": "2026-10-31T09:02:00Z"
}
```

The body is untrusted data. The generated task goal begins with the untrusted-data notice; the signal fields follow as data, never as instructions.

## 4. Signing a delivery

The signed string is exactly `<timestamp>.<body bytes>`. Compute the digest over the bytes you will send, with no added newline. The example reads the secret from the environment and never prints it:

```bash
ts=$(date +%s)
body='{"source":"generic", ...}'
sig=$(printf '%s.%s' "$ts" "$body" \
  | openssl dgst -sha256 -hmac "$WEBHOOK_SIGNING_SECRET" -hex \
  | sed 's/^.*= //')

curl -sS -X POST "https://<host>/api/webhooks/generic" \
  -H "content-type: application/json" \
  -H "x-isolate-timestamp: $ts" \
  -H "x-isolate-signature: sha256=$sig" \
  --data-binary "$body"
```

Use `--data-binary` (not `-d`) so the shell does not alter the payload. Any transformation after signing — re-serialization, trimming, a trailing newline — invalidates the signature.

## 5. Responses

| Status | Body | Cause |
|---|---|---|
| `202` | `{taskId, jobId, deduped}` | Task created, or a replay reused a live prior task |
| `202` | `{deduped:true}` | Same `(org, source, fingerprint)` accepted within 30 minutes |
| `400` | `{error}` | Body is not JSON, or fails the strict signal schema |
| `401` | `{error}` | Missing/malformed headers, stale timestamp or invalid signature |
| `403` | `{error}` | Binding role lacks `task:submit` |
| `404` | `{error}` | `service` does not resolve to the bound repository |
| `409` | `{error}` | Submission conflict |
| `413` | `{error}` | Body above 64 KiB |
| `503` | `{error}` | Intake not configured, secret missing, or database unavailable |

`202` is returned only after the task submission completes; there is no queueing in the HTTP handler beyond the normal submission path. Error bodies are fixed strings and never contain the payload, signature, secret or provider text (`apps/web/src/routes/api.webhooks.$.tsx`).

## 6. Dedupe

- Key: `(organizationId, source, fingerprint)` in the in-memory `IncidentDedupeStore` for 30 minutes (`INCIDENT_DEDUPE_WINDOW_MS`).
- A duplicate returns the original `taskId`/`jobId` with `deduped: true`.
- The submission also carries a deterministic idempotency key derived from `(org, source, fingerprint, 30-minute bucket)`, so a resubmit that bypasses the memory store is idempotent at the submission layer (`incidentIdempotencyKey`).
- The store is process-local. A restart loses it; a multi-instance deployment must inject a SQL-backed store. Generic mode does not write `incident_signals`, so there is no database bucket for it.

## 7. Environment binding

Set by the deployment, read once by the composition root (`apps/web/src/server/incident-intake-runtime.server.ts`). A webhook has no session, so all identity comes from here.

| Variable | Required | Purpose |
|---|---|---|
| `WEBHOOK_SIGNING_SECRET` | yes for this mode | HMAC secret, ≥32 characters |
| `WEBHOOK_ORGANIZATION_ID` | yes | Tenant for the task |
| `WEBHOOK_ACTOR_ID` | yes | Actor recorded on the task |
| `WEBHOOK_ACTOR_ROLE` | no | `owner` / `admin` / `member`; default `member`; must hold `task:submit` |
| `WEBHOOK_REPOSITORY_ID` | yes | The one repository the task may use |
| `WEBHOOK_BRANCH` | yes | Branch the task works on |
| `WEBHOOK_WORKFLOW_DEFINITION_ID` | yes | Pinned workflow |
| `WEBHOOK_WORKFLOW_VERSION` | yes | Pinned workflow version |
| `WEBHOOK_FILE_OWNERSHIP` | no | Comma-separated owned paths; empty means the agent may not write |
| `WEBHOOK_SERVICE` | no | If set, the signal's `service` must equal it; otherwise any service routes to the repository |
| `WEBHOOK_MAX_AGENT_TURNS` | no | Bounds the agent loop for incident tasks |
| `DATABASE_URL` | yes | Task storage; the intake fails closed without it |

There is no per-endpoint secret and no per-endpoint organization mapping: the binding is deployment-wide. To support two teams, run two deployments (or add a routing layer that is not in this code).

## 8. Rejection codes and operator action

| Code | Meaning | Operator action |
|---|---|---|
| `not_configured` | Secret missing or under 32 characters | Set `WEBHOOK_SIGNING_SECRET` and restart |
| `body_too_large` | Above 64 KiB | Reduce the payload; do not split one logical incident into many deliveries |
| `missing_headers` | Timestamp or signature absent | Fix the sender |
| `malformed_timestamp` | Not 1–12 digits | Send Unix seconds |
| `stale_timestamp` | Outside ±300 s | Fix sender clock; do not widen the window |
| `malformed_signature` | Missing `sha256=` or non-hex | Fix the sender |
| `invalid_signature` | Digest mismatch | Confirm the sender signs the exact bytes and uses the current secret |

## 9. Secret rotation

The receiver supports **one active secret per mode**. The survey's "two active secrets during rotation" is not implemented (`verifyWebhookSignature` accepts a single `secret`).

Rotation procedure:

1. Generate a new secret of at least 32 random characters; store it in the deployment secret manager.
2. Choose a low-traffic window. Update the sender and the receiver in the same change: the old secret stops verifying as soon as the new one is deployed.
3. Send one signed test delivery and confirm `202` with a `taskId`; a `401` means the two sides disagree — roll back to the previous secret value.
4. Record the rotation date. The secret is never written to this repository, a prompt or a ticket.

A staged rotation with overlap requires a code change (a secret list) and is out of scope for this page.

## 10. Operational constraints to know

- **No severity policy.** Unlike GitHub mode, generic mode accepts every severity (`critical` through `info`) and creates a task for any valid signal. It has no production/default-branch rule.
- **No per-organization concurrency cap.** `MAX_ACTIVE_INCIDENT_TASKS` applies to GitHub mode only.
- **No signal row and no task provenance.** `incident_signals` and `tasks.incident_source` / `incident_fingerprint` are written only by GitHub mode; a generic task is indistinguishable from a manually submitted task in those columns.
- **`source` is caller-declared.** A sender can claim `sentry` or `pagerduty`; that value is metadata, not verification. Use `generic` unless a native connector exists.
- **No read API.** The generic connector never fetches anything from the sender's system; evidence must be in the signal or linked for a human.

## 11. Acceptance checklist

- [ ] Missing secret → `503`; short secret → `503`; `x-github-event` absent selects generic mode.
- [ ] Valid signature → `202`; tampered body → `401`; timestamp 301 s old → `401`; future timestamp 301 s ahead → `401`.
- [ ] 65 KiB body → `413` without reading the whole stream.
- [ ] Same fingerprint twice within 30 minutes → second is `202 {deduped:true}` and creates nothing.
- [ ] Unknown JSON field, wrong `source`, non-https link → `400`.
- [ ] Unmapped `service` (with `WEBHOOK_SERVICE` set) → `404`.
- [ ] No secret, signature or payload text in any response or log line.

These behaviors are covered by fake-based tests (`apps/web/src/server/webhook-signature.test.ts`, `apps/web/src/server/incident-intake.test.ts`); no live provider is involved.
