# Device-held connectors - end-to-end runbook

| Field | Value |
|---|---|
| Audience | Operators and platform engineers wiring the device transport |
| Status | Runbook for the wave-17 device model; endpoint availability is marked per step |
| Rule | Provider keys stay on the user's device. The server stores only a sha256 device-token hash and connector metadata |
| Sources of record | [`../connector-onboarding.md`](../connector-onboarding.md), [`../connector-usage.md`](../connector-usage.md), [`SETUP.md`](SETUP.md) |

## 1. The flow in one picture

```text
owner/admin                browser/server                     user device (daemon)
    │                           │                                   │
    ├─ register device ────────►│ store token_hash, status active   │
    │                           ├───────────── token shown once ────►│ OS keychain
    │                           │                                   │
    ├─ connect vendor ─────────►│ metadata: device_id, connector_id, │
    │  (credential_ref only)    │ auth_kind, credential_ref, scopes  │
    │                           │                                   │
    │                     task runs; worker enqueues a typed call  │
    │                           ├──── connector_calls (queued) ────►│ poll /api/device/claim
    │                           │                                   ├─ provider call (key local)
    │                           │◄─── /api/device/calls/{id}/result ─┤
    │                           ├─ bounded result to the model       │
```

Two planes meet here: the **trigger/context plane** (webhooks and context bundles) and the
**live tool plane** (typed calls during a task). This runbook covers the second one; the
first is in [`../connector-usage.md`](../connector-usage.md) §2.

## 2. Endpoint inventory

| Endpoint | Auth | Purpose | Availability |
|---|---|---|---|
| `POST /api/device/register` | user session, `member:manage` | create a device, return the token **once**, status active | **implemented** |
| `GET /api/device/list` | user session, `organization:read` | list devices for the organization (no hashes) | **implemented** |
| `POST /api/device/revoke` | user session, `member:manage` | revoke a device; idempotent | **implemented** |
| `POST /api/connectors/connect` | user session, `member:manage` | store metadata + opaque `credential_ref` | **implemented** |
| `GET /api/connectors/list` | user session, `organization:read` | list connected metadata | **implemented** |
| `POST /api/connectors/revoke` | user session, `member:manage` | revoke one connection | **implemented** |
| `POST /api/device/claim` | device bearer token | claim one queued call | **implemented** |
| `POST /api/device/calls/{id}/result` | device bearer token | post the bounded result | **implemented** |
| `POST /api/device/heartbeat` | device bearer token | touch `last_seen_at` | **implemented** |

Server env: `DEVICE_GATEWAY_ENABLED=true` is required; when it is absent every device route
returns `503`. The gateway never reads a provider key.

## 3. Device token lifecycle

1. **Create.** The owner/admin posts a display name. The server generates 256 bits of
   randomness (base64url), stores only `sha256(token)` in `connector_devices.token_hash`,
   sets the device `active` immediately, and returns the plaintext once with
   `Cache-Control: no-store`. There is no separate activation step.
2. **Store.** The device writes the token to its OS keychain (or a file readable only by the
   daemon user). It is never written to the server, the repo, a log or a prompt.
3. **Use.** Every claim/result/heartbeat sends `Authorization: Bearer <token>`. The server
   hashes the presented token and compares in constant time against active rows.
4. **Rotate.** Register a new device, move the daemon config to the new token, revoke the
   old device. Revocation is immediate for new calls; an in-flight call completes or expires.
5. **Revoke.** `POST /api/device/revoke` flips the device to `revoked`. The broker refuses to
   resolve it, so connected metadata tied to that device becomes unusable.

## 4. Connecting a vendor (metadata only)

`POST /api/connectors/connect` accepts:

```json
{
  "deviceId": "<uuid>",
  "connectorId": "sentry",
  "displayName": "Sentry prod",
  "authKind": "api_key",
  "credentialRef": "keychain:isolate/sentry/prod",
  "scopes": ["event:read", "project:read", "org:read"]
}
```

- `connectorId` must be one of the ten implemented connectors.
- `credentialRef` is an **opaque device-side name**. It is never a secret: the server rejects
  values that look like GitHub/Slack/AWS tokens or private-key blocks, and values longer than
  200 characters.
- `metadata` may hold non-secret selectors (base URL, org slug, datasource UID, dataset,
  namespace, region). Provider keys do not belong here.
- The row starts `pending_validation`; the first successful device call or a device-side check
  promotes it to `active`.

`docs/connectors/SETUP.md` has the exact key-creation path and scope list for each of the ten.

## 5. Daemon configuration

The daemon (`apps/device-daemon`) reads `ISOLATE_DEVICE_CONFIG` or `~/.isolate/connectors.json`:

```json
{
  "serverUrl": "https://<isolate-host>",
  "deviceTokenEnv": "ISOLATE_DEVICE_TOKEN",
  "pollIntervalMs": 2000,
  "vendors": {
    "sentry": { "secretEnv": { "token": "SENTRY_API_KEY" }, "baseUrl": "https://sentry.io" },
    "kubernetes": {
      "secretEnv": { "tokenFile": "K8S_TOKEN_FILE" },
      "apiUrl": "https://127.0.0.1:6443",
      "namespace": "isolate-demo",
      "caFile": "C:/Users/<you>/.isolate/k8s-ca.pem"
    }
  }
}
```

Provider secrets are read from device-local environment variables (or the OS keychain once the
keychain adapter lands). The server URL must be https. Non-secret selectors may live in the
JSON; secrets must not.

Polling behavior: claim, execute, post result, sleep. `401/403` stops with a clear message
(no retry loop); `429`/`5xx`/network errors back off exponentially with jitter. The daemon logs
only `tool`, `connector`, `outcome` and duration - never params, results or the token.

## 6. Offline and failure behavior

| Situation | Result |
|---|---|
| Device offline | calls expire; the worker surfaces `INTEGRATION_UNAVAILABLE`; nothing is retried forever |
| Device revoked mid-call | result post is rejected; the call expires |
| Provider `401/403` | bounded error code; operator must rotate the device-held key |
| Provider `429` | `RATE_LIMITED`; the daemon backs off, the worker does not spin |
| Result too large | rejected at 256 KiB; the call fails with `VALIDATION_FAILED` |
| Gateway disabled | every device route returns `503` |

## 7. Free-tier guard

Every connector declares a free-tier profile. The platform keeps a durable counter in
`connector_usage_ledger` and stops at roughly 80% of the provider's free allowance. The stop is
a user-visible error, not a silent overage and not an automatic upgrade. Trial-only vendors
(Confluent, Redpanda, Elastic Cloud, SigNoz Cloud, Rootly) are not default choices; the ten
implemented connectors all have a free or self-hosted path.

## 8. Testing

```bash
# offline: gateway, queue, token hash, bounds, replay
bun test --no-env-file apps/web/src/server apps/worker/src packages/db/src/repositories

# local Kubernetes read (kind, gated by K8S_ACCEPTANCE=1)
bun run acceptance:k8s-local

# local device loop: enqueue a call and wait for the running daemon
LIVE_DEVICE=1 bun --env-file .env scripts/acceptance-device-local.ts
```

Local proof (2026-10-31): a seeded device + Kubernetes credential, the web gateway and
`apps/device-daemon` ran together; call `538a0a2a-…` (`k8s.list_events`) was claimed,
executed against the local kind cluster and completed with a 903-byte result. The usage
ledger recorded one request. The provider token existed only in the daemon's environment.

Every accepted call must leave one `connector_calls` row ending `completed` or `failed`, and
one `tool_invocations` row in the worker. No test may read a provider key from the server.

## 9. What never leaves the device

- Provider API keys, OAuth tokens, service-account JSON, bot tokens, private keys, kubeconfigs.
- Raw provider responses and log bodies beyond the bounded excerpt the adapter returns.
- The device token in plaintext (the server only has its hash).
