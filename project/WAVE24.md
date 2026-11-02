# Wave 24 — connector verification, vendor selectors, landing truth

Status: implemented and merged (2026-11-02); final gates and known gaps are in [`STATUS.md`](STATUS.md)
Predecessor: [`WAVE23.md`](WAVE23.md) and the known-gap list in [`STATUS.md`](STATUS.md)

## Goal

Close every honest gap that is code or documentation, without inventing a
capability. The blocking gap is connector verification: a paired credential is
stored on the relay but stays `pending_validation` because the relay never
captured the vendor's non-secret selectors and the server never asked for the
one bounded read.

## Gaps addressed

| Gap | Disposition |
|---|---|
| Connector verification + vendor selectors | **Implemented** in this wave: per-connector local pairing fields, selector-aware vendor resolution, `connector.verify`, server status transition, UI verify action |
| A1 investigate unsupported | **Still unsupported.** A0/A2/A3 remain honest; A4 is out of scope. Documented, not claimed |
| GitHub App operator env | **Deployment requirement** (no secret can be added here): `GITHUB_APP_SLUG`, `GITHUB_APP_STATE_SECRET` (>= 32 chars), plus the existing App id/key. Code already fails closed with `GITHUB_APP_NOT_CONFIGURED`; docs now name the secret-manager entries |
| Datadog canonical re-fetch | **Design-only.** A Datadog webhook remains an untrusted hint; the signed generic bridge or a future canonical re-fetch is required before autonomous use |
| Kafka bridge | **Design-only.** No consumer process is added in this wave |
| Authenticated visual QA / stale landing capture | **Landing capture refreshed** with the wave-23 Home composition and synthetic data. Authenticated live-DB visual QA is still unavailable in this environment and is not claimed |

## Lanes

| Lane | Worktree | Owning paths | Deliverable | Commit |
|---|---|---|---|---|
| W24-DEVICE | `w24-device` / `task/w24-device` | `apps/device-daemon/**` | Vendor pairing fields and selectors, per-credential resolution, `connector.verify` probes, tests | `8ce7f81` (merge `5033578`) |
| W24-VERIFY | `w24-verify` / `task/w24-verify` | `apps/web/src/server/connector-verification.server.ts`, `device-gateway.server.ts`, server tests | Enqueue/await the verify call, promote/deny status, allow verification before activation | `c3ef687` (merge `3233544`); `0afe701`; `41b9e68` |
| W24-UI | `w24-ui` / `task/w24-ui` | `apps/web/src/features/integrations/**`, integration detail route | Real verify action, honest pending/invalid/active copy, no "route has not landed" placeholder | `770b1df` (merge `ee9ec7b`) |
| W24-LANDING | `w24-landing` / `task/w24-landing` | `apps/web/public/images/**`, temporary preview route | Recapture overview + panel images from the wave-23 Home, update provenance | `a91633f` (merge `3dff8f9`) |
| W24-DOCS | `w24-docs` / `task/w24-docs` | `docs/**` | Pairing fields, verification flow, GitHub App secret-manager checklist, known limits | `b0eab5e` (merge `f1f2f63`) |

## Frozen contracts

- `packages/shared/src/types/connector.ts`: `CONNECTOR_VERIFY_TOOL_NAME = "connector.verify"`, `CONNECTOR_VERIFY_REASON_CODES`, `connectorVerifyDeviceResultSchema`.
- `apps/web/src/server/connector-verification.server.ts`: `ConnectorVerificationResult`, `ConnectorVerificationView`, `verifyConnectorCredential`, `isConnectorVerificationEnabled`.
- `buildPairingLocalUrl(code, port, connectorId?)` adds `&connector=<id>` as a non-secret rendering hint; the claim response remains authoritative.
- Device verification returns a success envelope with `{ verified, reasonCode }` for provider outcomes; only transport/config failures use the device error envelope.

## Verification semantics

| Outcome | Credential status | Reason |
|---|---|---|
| 2xx bounded read | `active` + `last_validated_at` | `OK` |
| 401/403 | `invalid` | `AUTH_FAILED` |
| 404 / missing selector | `invalid` | `CONFIG_REQUIRED` |
| 429 | unchanged | `RATE_LIMITED` |
| 5xx / other 4xx | `invalid` | `PROVIDER_ERROR` |
| network / timeout | unchanged | `UNREACHABLE` |

Only `active` is displayed as Connected. A timeout never claims verification.

## Gates (2026-11-02, after all merges)

- `bun scripts/typecheck-all.ts` — **9/9 projects**.
- `bun test --no-env-file` — **3118 pass / 10 skip / 0 fail** (3128 tests, 219 files), twice, identical.
- `bunx biome check apps packages scripts` — **0 errors**, 10 pre-existing warnings.
- `bun --no-env-file scripts/acceptance-offline.ts` — **7/7 PASS** with zero provider credentials.
- `bun run security:check` — **PASS** (550 source/migration files, 948 tracked files).
- `apps/web` production build — success; `check:build` PASS; client sweep **34 checks / 105 files**.
- No provider keys, no live vendor calls, no `.env` contents used.
