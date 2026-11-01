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

## 4. Secret-scanning incident (2026-10-31)

- **What happened**: GitGuardian flagged synthetic JWT-shaped and API-key-shaped test
  fixtures in the Kubernetes, SigNoz, Datadog, New Relic and GitHub suites.
- **Why the local gates missed them**: the CI `secret-scan` job was
  `continue-on-error: true` (advisory), and `scripts/security-check.ts` excluded
  `*.test.ts` and had no JWT/generic-key rule. The fixtures were synthetic
  (`alg`/`sub` plus a short signature), not live credentials.
- **Fix**: every fixture is now built at runtime; `security:check` rejects static JWT-shaped
  literals in tests; `.gitleaks.toml` has an explicit JWT rule; the CI secret scan is
  **blocking**; `.githooks/pre-commit` runs the local check when enabled with
  `git config core.hooksPath .githooks`.
- **History**: rewritten and force-pushed with lease. `origin/main` is `8be851d` and a
  local `gitleaks git --log-opts=main` reports **0 leaks**. Old objects remain locally only
  because the pre-rewrite wave-18 branches still point at the old base; they are rebased
  onto the cleaned main before merge, then purged.
- **Rotation**: no live credential existed in these fixtures, so there was nothing to
  rotate; the repository's real GitHub App key was never committed.

## 5. Wave-18 connector audit (2026-11-01)

Read-only audit of the device-held model. No CRITICAL findings.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | No rate limiting on device/user/webhook surfaces | **FIXED**: `0012` applied; device/user/intake limits and batched claims merged |
| 2 | HIGH | Device tokens never expire or rotate | **FIXED (expiry)**: `0014` applied; registration sets 90 days; verify rejects expired. Rotation endpoint remains a follow-up |
| 3 | HIGH | Webhook cap is non-atomic; capped fingerprints are burned | **FIXED**: transactional `reserveIfNewUnderCap` with a per-org advisory lock; intake wired |
| 4 | MEDIUM | `expireStale` has no caller | **FIXED**: worker reaper tick (60 s) when the device gateway is enabled |
| 5 | MEDIUM | No composite tenant FKs | **FIXED**: `0015` applied (unique org/id + four composite FKs) |
| 6 | MEDIUM | Client controls `requestsPerDay` | **FIXED**: gateway ignores the stored client profile and uses the server guard |
| 7 | MEDIUM | No Origin/CSRF check on cookie POSTs | **FIXED**: guard wired into device register/revoke and connector connect/revoke |
| 8 | MEDIUM | Provider bodies buffered before cap | **FIXED**: bounded stream reader through all ten adapters |
| 9 | MEDIUM | Worker lacked per-tool argument schemas | **FIXED**: all 31 names validated against adapter schemas before enqueue |
| 10 | LOW | `touchSeen` on every request; 250 ms result polling | **PARTIAL**: `touchSeen` throttled to 1/min/device; polling bounded by TTL |
| 11 | LOW | Result re-scan depth 6 vs write depth 8 | Align depths in the call repository |
| 12 | LOW | STATUS claimed registry gated by env | **FIXED**: wording corrected to "implementations are gated" |
| 13 | LOW | Social callback origin trusted without allowlist | Neon rejects untrusted callback hosts; add an explicit allowlist as defense |

Verified safe: bearer-hash device auth, capability-before-write, fail-closed gateway, atomic
queue claim/ownership/expiry, recursive credential scan, no secret columns, https-only
adapters with `redirect:"error"`, worker queue integrity.

## 6. Running the loop

```bash
bun run security:check     # repo-wide credential boundary + migration checks
bun test --no-env-file     # includes gateway, queue, worker and adapter suites
bun run typecheck
```

Re-run all three after every connector, transport or policy change. A finding is only closed when
its regression test exists and passes; document deferred items here, never silently.
