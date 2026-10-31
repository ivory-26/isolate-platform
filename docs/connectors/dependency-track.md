# Dependency-Track connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0, verified 2026-10-31; self-hosted, no paid tier required |
| Auth | `X-Api-Key` for reads; webhook HMAC secret for inbound |
| Inbound | Native webhook with `X-Webhook-Signature` (5.2.0+), or a signed bridge for older versions |
| Read | REST API v1 project / component / finding / vulnerability endpoints |
| Writes | None in scope; analysis decisions are proposed as `scoped_write` |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

Dependency-Track (DT) is an OWASP project that analyses SBOMs, tracks components and vulnerabilities across a portfolio, and evaluates policy. It is the system of record for "which project is affected by which component vulnerability", which makes it a better trigger than a raw scanner when the organisation already uploads SBOMs to it.

## 1. Role in the agent

DT answers "which project and component does this vulnerability belong to, and has an analyst already triaged it". It adds portfolio context that a single CI scan cannot: project, component coordinates, analysis state and policy violations.

Kinds proposed: `new_vulnerability` (a vulnerability newly identified for a project), `vulnerability_retracted` (advisory withdrawn), `policy_violation` (a defined policy failed).

Severity mapping:

| DT severity | `IncidentSignal.severity` |
|---|---|
| `CRITICAL` | `critical` |
| `HIGH` | `high` |
| `MEDIUM` | `medium` |
| `LOW` | `low` |
| `INFO` | `info` |
| `UNASSIGNED` | `info` |

`UNASSIGNED` must not be guessed upward. The notification level (`INFORMATIONAL`, `WARNING`, `ERROR`) is a separate axis: it controls delivery verbosity, not vulnerability severity, and must not be used as the signal severity.

Fingerprint: `dependency-track:<projectUuid>:<componentUuid>:<vulnerabilityUuid>`. A re-analysis or a redelivery maps to the same key. The webhook delivery id, if any, is traceability only.

Evidence: project name/version, component name/version/purl, vulnerability id/source/severity, analysis state, and the project URL. Raw component hashes and the full SBOM are not evidence for the model.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | Apache-2.0 | [S1] |
| Cost | Free; you pay for the container host, PostgreSQL and storage | [S1], [S2] |
| Database | PostgreSQL 14 or newer, with the `pg_trgm` extension | [S2] |
| SaaS | Not required; the project is self-hosted | [S1] |
| API rate limit | No API quota is documented for the self-hosted server — **UNVERIFIED** as a number | [S3] |
| Webhook signature | `X-Webhook-Signature` is available in **5.2.0 and later**; earlier versions send unsigned requests | [S4] |

Self-host cost caveats: PostgreSQL is mandatory and must be tuned; vulnerability data is mirrored locally and grows over time; the API server and front end are separate containers in the usual deployment. No metered vendor cost exists, but database size and mirror jobs are real operational costs.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| Read | `X-Api-Key: <key>` | API keys are long-lived and intended for machine-to-machine use [S3] |
| Write (not in scope) | Separate API key | Never reuse the read key |
| Inbound | HMAC signing secret | Configured as a managed secret on the webhook publisher [S4] |

DT authorises by named permissions attached to a user, team or service account. In 5.2.0 and later, a **service account** is the intended identity for automation: it holds its own permissions and API keys and can be suspended without deleting the key [S5]. Older deployments use team API keys, which carry the team's permissions.

Least privilege: create a service account (or a dedicated team) with only the permissions needed to read projects, components, findings and vulnerabilities; never grant portfolio management, policy management or access management to the connector. Enable Portfolio Access Control so the key sees only the projects in scope [S5].

Rotation: create the second key, deploy it, verify reads, then revoke the first. For the webhook secret, rotate on the publisher and the receiver together; there is one active secret.

## 4. Inbound trigger

DT has a **native webhook publisher**, configured per alert: choose groups, level, project/tag limits, optional CEL filter, and the destination [S4], [S6]. With a signing secret set, each request carries:

| Property | Value |
|---|---|
| Header | `X-Webhook-Signature: sha256=<hex>` |
| Algorithm | HMAC-SHA256 over the exact request body bytes |
| Signed timestamp | Not documented — **UNVERIFIED**; assume none |
| Replay control | Source-stable fingerprint plus the platform's 30-minute dedupe bucket |
| Body cap | 64 KiB (platform default) |
| Retries | Not documented on the publisher page — **UNVERIFIED** |

Two implementation options:

1. **Dedicated mode.** Add a third verifier selected by `x-webhook-signature`, like the GitHub mode. This is a transport contract change and must be committed before the adapter: a new mode selector, raw-body HMAC verification, and a normalizer to `IncidentSignal`. Older DT versions send no signature; for those the receiver must not create a task from the body.
2. **Bridge.** A small service verifies the DT header, then re-signs the normalized `IncidentSignal` with the generic transport (`x-isolate-timestamp` + `x-isolate-signature` over `${timestamp}.${body}`, ±300 s, 64 KiB). This is the only option that works unchanged with the receiver that exists today.

If the version is older than 5.2.0, treat the webhook as a **hint** and re-fetch the finding through the API before creating a task. Never create a task from an unsigned payload alone.

Beware the fail-open filter expression: DT documents that if a filter expression fails to evaluate, the alert matches the notification anyway [S6]. Do not rely on a filter to exclude a project; enforce scope again in the adapter.

`dependency_track` must be added to `INCIDENT_SOURCES` in a contract commit before any of this is enabled.

## 5. Read-only context

| Need | Endpoint | Fields used | Source |
|---|---|---|---|
| Project | `GET /api/v1/project/{uuid}` | name, version, uuid, tags, active | [S3] |
| Findings for a project | `GET /api/v1/finding/project/{uuid}` | component, vulnerability, analysis, attribution | [S3] |
| Vulnerabilities for a project | `GET /api/v1/vulnerability/project/{uuid}` | source, vuln id, severity, CVSS, description, references | [S3] |
| Component | `GET /api/v1/component/{uuid}` | name, version, purl, group, hashes (not prompted) | [S3] |

Pagination uses `pageNumber` and `pageSize` (default 100); `offset`/`limit` is also supported on some endpoints. One page per resource, at most **4** calls per bundle. Caps: 100 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout. A `404` sets `truncated: true`; a `403` drops that resource; `429` fails the bundle with `RATE_LIMITED`.

Never read: component hashes as text, full SBOM/BOM exports, the vulnerability description in full, or attachment contents. The vulnerability description is provider text and is bounded and redacted like any other.

Analysis state is the key triage field: `NOT_SET`, `EXPLOITABLE`, `IN_TRIAGE`, `FALSE_POSITIVE`, `NOT_AFFECTED`, `RESOLVED`. Include it so the agent does not re-open a finding an analyst already dismissed, and do not treat `FALSE_POSITIVE` as proof unless it has an attribution.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/dependency-track/` |
| Source enum | Add `dependency_track` to `INCIDENT_SOURCES` before the adapter |
| Tools | `dependency_track.get_finding` (`read_only`), `dependency_track.list_project_findings` (`read_only`), `dependency_track.set_analysis` (`scoped_write`, proposed) |
| Risk bands | Analysis decision is `scoped_write` and audited. Policy changes and project/component deletion are `destructive` and out of scope |
| Env names | `DEPENDENCY_TRACK_URL`, `DEPENDENCY_TRACK_TOKEN`, `DEPENDENCY_TRACK_WEBHOOK_SECRET` |
| Sandbox | Server-side only. No API key in the sandbox; no SBOM upload from the sandbox; egress deny |
| Tests | Fake API, signature vectors (valid/tampered/old version), pagination, `403`/`404`/`429`, analysis-state mapping, tenant isolation |

`DEPENDENCY_TRACK_URL` must be an absolute https URL with no userinfo, query or fragment. `DEPENDENCY_TRACK_TOKEN` is the `X-Api-Key` value and is never placed in a URL or a tool result.

## 7. Operator setup checklist

1. Confirm the DT version. Use a signed webhook only on 5.2.0 or later; otherwise plan the bridge and re-fetch path.
2. Create a service account (or dedicated team) with read-only portfolio permissions and one API key. Enable Portfolio Access Control if available.
3. Create an alert for `NEW_VULNERABILITY` (and optionally `VULNERABILITY_RETRACTED`) at the level you need; restrict it to the in-scope projects.
4. Configure the webhook publisher with the receiver URL, a managed signing secret, and TLS verification on.
5. If using a bridge, set the generic HMAC secret and point the bridge at `https://<host>/api/webhooks/dependency-track`.
6. Add `dependency_track` to `INCIDENT_SOURCES` and the payload schema; deploy the contract before the adapter.
7. Send one test notification from a disposable project; confirm one task, one dedupe no-op, and no unsigned acceptance.
8. Rotate the API key and the webhook secret once to prove the procedure.

```dotenv
# Names only. Values are server-side and never documented here.
DEPENDENCY_TRACK_URL=
DEPENDENCY_TRACK_TOKEN=
DEPENDENCY_TRACK_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Signature fixtures: valid, tampered body, missing header, unsigned legacy payload (must not create a task).
- [ ] Normalizer: `NEW_VULNERABILITY` creates one signal; retraction updates, does not create.
- [ ] Severity mapping including `UNASSIGNED`; notification level is ignored for severity.
- [ ] Reader caps, pagination, `truncated`, and redaction of description/references.
- [ ] Tenant isolation: a project UUID from another organization returns `NOT_FOUND`.

Live (opt-in, local, free):

- [ ] One local container smoke: DT with PostgreSQL, one project, one SBOM upload, one alert.
- [ ] One signed delivery from DT to the receiver or bridge; one task; one redelivery deduped.
- [ ] No metered spend; record container images and database size.

## 9. Risks and never in model context

- **Never**: the API key, webhook signing secret, database URL, SBOM contents, component hashes as text, attachment contents.
- **Never**: the full vulnerability description or every reference URL; take an allowlisted summary and the canonical advisory link.
- Fail-open filter expressions can deliver out-of-scope projects; re-check scope in code.
- Unsigned legacy payloads can be forged; they are hints only, never triggers.
- Provider text (vulnerability descriptions, component names) is untrusted and can contain injected instructions.
- Portfolio data reveals supplier and dependency structure; keep excerpts minimal and per-tenant.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [DependencyTrack/dependency-track](https://github.com/DependencyTrack/dependency-track) (Apache-2.0) |
| S2 | [Database requirements](https://docs.dependencytrack.org/reference/configuration/database/) |
| S3 | [Dependency-Track API v1 specification](https://github.com/DependencyTrack/docs/blob/main/docs/reference/api/openapi-v1.yaml) |
| S4 | [Notification publishers: Webhook](https://docs.dependencytrack.org/reference/notifications/publishers/#webhook) |
| S5 | [Access control, service accounts and API keys](https://docs.dependencytrack.org/concepts/access-control/) |
| S6 | [About notifications](https://docs.dependencytrack.org/concepts/notifications/) |
| S7 | [Notifications integration](https://docs.dependencytrack.org/integrations/notifications/) |
