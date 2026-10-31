# <Vendor> connector

| Field | Value |
|---|---|
| Status | Design only / Implemented (pick one; never imply code that does not exist) |
| Code | Exact paths, or "none — no code exists in this repository" |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §… |
| Trigger | Inbound event or "none" |
| Context | What the reader returns, or "none" |
| Writes | Named tools, or "none in scope" |

## 1. Role in the agent

One paragraph: what question this connector answers and what it must not be used for. State whether the trigger or the context is the primary value.

## 2. Auth model

| Item | Value |
|---|---|
| Header / credential shape | |
| Token or key type | |
| Storage | Server-only, encrypted at rest, keyed by `(organization, connector)` |
| Rotation | One active credential; describe the swap procedure |

## 3. Minimal scopes

| Scope | Needed for | Source |
|---|---|---|
| | | [S#] |

List only what the reader and the transport need. Mark every scope whose exact string was not extracted as **UNVERIFIED**.

## 4. Inbound webhook

| Property | Value |
|---|---|
| Signature header | |
| Algorithm and signed string | |
| Signed timestamp | Yes/no; if no, describe replay control |
| Replay window | |
| Dedupe key | Source-stable fingerprint; delivery id is traceability only |
| Body cap | 64 KiB (platform default) |
| Retries | |

If the vendor has no signature, say so and require a canonical re-fetch before task creation.

## 5. Read endpoints for a ContextBundle

| Need | Endpoint | Fields / notes | Source |
|---|---|---|---|
| | | | [S#] |

Add the planned fixed call order and per-call caps. Mark unextracted paths **UNVERIFIED**.

## 6. Rate limits, pagination, retention

| Constraint | Value | Handling |
|---|---|---|
| Rate limit | | |
| Pagination | | |
| Retention | | |

## 7. What must never enter model context

Bullet list of payload parts, PII, credentials and free text that are excluded or structurally redacted before truncation.

## 8. Data retention notes

- Vendor-side retention and plan dependency.
- Platform-side: bounded excerpt plus hash, 30-day TTL design, deletion by organization, DSAR.
- Residency and inference-provider transfer.

## 9. Phased implementation checklist

1. Decide account, plan, region and credential type.
2. Contract: map the payload to `IncidentSignal`; strict schema; unknown fields rejected.
3. Transport: verifier over raw bytes, caps, dedupe, 202-before-model.
4. Reader: fixed query plan, allowlist, redaction before truncation, `truncated` on omissions.
5. Tests: fakes only; tenant isolation; redaction seeds; `429` and timeout.
6. Offline gates twice with providers disabled. No keys.
7. Live acceptance only with explicit authorization: one bounded call, no retries, spend recorded.
8. Writes: separate credential, separate approval payload, separate wave.

## 10. Open questions for the user

1. Which plan/region/account?
2. Which services or projects may create tasks, at which severity?
3. Which data may leave the region?
4. What retention and delete workflow is required?
5. Is any write ever allowed, and who approves it?

## 11. Sources

Copy the `[S#]` rows used above from [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §9. Do not add a source you did not read.

## 12. Verification log

- Facts checked against code (paths and line-level behavior):
- Facts checked against the survey (section and source ids):
- Facts marked **UNVERIFIED**:
- Divergences found between docs and code (reported, not fixed):
