# Security loop — connector model (wave 17)

| Field | Value |
|---|---|
| Date | 2026-10-31 |
| Scope | Device-held connector credentials, device queue, webhook intake, ten adapters, tool policy |
| Method | Read-only audit of merged code + `bun run security:check` + targeted tests |
| Rule | No provider key, token, Authorization header, password or private key may be stored server-side |

## 1. Invariant and current state

- Provider keys live on the user's device; the server stores only `sha256(device token)` and connector metadata (`credential_ref` is a name, not a secret).
- Migrations `0010_connectors.sql` and `0011_connector_calls.sql` contain no secret columns.
- Device auth: hash lookup → constant-time re-compare → `active` only; revoked/pending/unknown all return a generic 401; the token is never echoed or logged.
- Queue: atomic `FOR UPDATE SKIP LOCKED` claim; complete/fail scoped to the owning device and a claimed, unexpired row; terminal replay is idempotent; 64 KiB params / 256 KiB result caps.
- Policy: all connector reads `read_only`; PagerDuty acknowledge/resolve `scoped_write`; no destructive connector tool; audit stores only the argument SHA-256.
- End-to-end proof: gateway → `connector_calls` → daemon → local kind cluster → 903-byte result; ledger recorded one request.

## 2. Findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Secret-shaped values could be persisted in call `params`/`result` and credential `metadata` (shallow, top-level checks only) | **FIXED** (`3305bff`): recursive credential-material scan at enqueue, result read/write, `credentialRef`, `displayName`, `metadata`, scopes and worker args; metadata capped at 16 KiB |
| 2 | MEDIUM | Sentry replay window is not authenticated (timestamp outside the MAC) | **MITIGATED**: durable fingerprint dedupe is the control; the timestamp is advisory and documented as such |
| 3 | MEDIUM | PagerDuty acknowledge/resolve admitted without a write scope | **FIXED**: `connector:write` or `<connector>:write` required before enqueue; denied with `POLICY_DENIED` |
| 4 | MEDIUM | `awaitResult` read not scoped by org/device | **FIXED**: optional `{organizationId, deviceId}` scope; worker passes both; foreign scope returns `null` |
| 5 | MEDIUM | Provider responses buffered before the byte cap; redirects followed | **PARTIAL**: `redirect: "error"` on all ten adapter request paths; streaming byte caps remain a follow-up |
| 6 | LOW | Redaction after truncation in a few context builders | Tracked; adapters mostly redact before truncation; follow-up |
| 7 | LOW | Device tokens never expire; no rate limit on auth/claim | Tracked; revocation is immediate. Add token expiry/rotation and bounded auth rate limiting |
| 8 | MEDIUM | Composite tenant constraints absent (separate FKs only) | Tracked; gateway rejects cross-tenant rows; DB-level composite constraints need a migration |

## 3. Verified safe

- Token handling: only hashes stored, unique index, parameterized lookup, constant-time compare.
- Error surfaces: fixed text, no token/body/provider message echo; no logger in gateway/queue/webhooks.
- Intake: raw-byte HMAC, header-only mode selection, per-mode secrets, 503 on missing secret, 64 KiB streamed cap.
- Adapters: https-only base URLs, no userinfo/query, auth header only, bounded excerpts, failure mapping without provider bodies.
- Policy/tools: unbound connector tools deny by default; argument digest only in audit.

## 4. Running the loop

```bash
bun run security:check     # repo-wide credential boundary + migration checks
bun test --no-env-file     # includes gateway, queue, worker and adapter suites
bun run typecheck
```

Re-run all three after every connector, transport or policy change. A finding is only closed when
its regression test exists and passes; document deferred items here, never silently.
