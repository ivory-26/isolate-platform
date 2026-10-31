# OSV-Scanner connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0 for OSV-Scanner and the OSV API, verified 2026-10-31; free, no account |
| Auth | None for the scanner and the public OSV API |
| Inbound | None native; CI job through a signed bridge |
| Read | OSV advisory lookup by ID, or the SARIF/JSON artifact from the scan |
| Writes | None in scope |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

OSV-Scanner is a Google-maintained open-source scanner for lockfiles, source trees and container images. Like Trivy it is a CLI, not a service: there is nothing to call back, and the trigger must be built in CI.

## 1. Role in the agent

OSV-Scanner answers "does this package version have a known OSV advisory, and which version fixes it" with broad ecosystem coverage and an open advisory database. It is a good second opinion to Trivy, not a replacement for image OS-package scanning or runtime detection.

Kinds proposed: `dependency_vulnerability` (lockfile/source scan), `image_vulnerability` (container scan), `license_violation` (only if `--licenses` is enabled).

Severity derives from the CVSS score in the OSV record:

| CVSS score | `IncidentSignal.severity` |
|---|---|
| 9.0–10.0 | `critical` |
| 7.0–8.9 | `high` |
| 4.0–6.9 | `medium` |
| 0.1–3.9 | `low` |
| none / no CVSS | `info` |

Do not infer severity from the advisory summary text, and do not use the ecosystem's own label unless it is a CVSS score. A record with no CVSS is `info`, with the reason stated in the summary.

Fingerprints:

- `osv:<ecosystem>:<packageName>:<version>:<OSV id>`
- For images: `osv:image:<imageRef>:<ecosystem>:<packageName>:<version>:<OSV id>`

The OSV id (for example `GHSA-…`) is stable; the scan run id and the source path are traceability, not identity.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | Apache-2.0 | [S1] |
| Cost | Free; no account, no key, no paid tier | [S1], [S2] |
| API | Public `https://api.osv.dev`; no authentication | [S3] |
| API limit | The OSV API documentation states "currently there are no limits on the API" | [S3] |
| Availability | No SLA is published for the free API — treat an outage as degradation, not as "no vulnerabilities" | [S3] |
| Retention | Advisory data is public and persistent; scan artifacts are yours | [S2] |

"No limits" is a statement about throttling, not a capacity promise. Batch queries with `POST /v1/querybatch` where possible, and never fan out one request per package in a loop. Self-hosting the OSV database is possible through the scanner's offline mode; that removes network dependence at the cost of a scheduled database download.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| CLI / CI | None | The scanner and the public API are keyless |
| Advisory lookup | None | Read-only public data |
| Bridge | HMAC secret | Only the platform webhook secret, not an OSV credential |

There is no scope to minimize because there is no account. The least-privilege work moves to the CI job: run the scanner with a read-only checkout token, no package-registry write credentials, and no secrets in the environment. The `fix` subcommand can execute package managers and follow external registries, so it is **not** part of this connector and must not run in the same job as a credential-bearing step [S2].

If a private registry is scanned, use a read-only pull token scoped to that registry and discard it after the job.

## 4. Inbound trigger

OSV-Scanner has **no webhook**. The only trigger is a CI job. The job runs a scan, stores the artifact, and a bridge converts the anchor finding into one `IncidentSignal` sent over the generic signed transport:

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/<any>` |
| Signature | `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}` |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Secret floor | 32 characters |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes |

A SARIF report with many findings exceeds 64 KiB, so the bridge ranks by CVSS and emits at most a few deliveries, each with its own fingerprint. It must not truncate the JSON and sign the fragment. The `osv_scanner` value must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

Bridge rules:

- Scan artifacts are untrusted input; parse with a schema, do not regex the report.
- The CI run URL is a `links` entry, bounded and https.
- A failed scan (tool error) is not a vulnerability finding; it may create an `info` task only if the workflow explicitly asks for it.
- Re-running the same commit and lockfile must produce the same fingerprint, so the 30-minute dedupe suppresses the duplicate.

## 5. Read-only context

There is no incident API. Two bounded sources:

| Need | Endpoint | Fields used | Source |
|---|---|---|---|
| Advisory metadata | `GET https://api.osv.dev/v1/vulns/{id}` | `id`, `summary`, `aliases`, `severity[].score`, `affected[].package`, `affected[].ranges`, `affected[].database_specific`, `references` | [S3], [S4] |
| Package/version query | `POST https://api.osv.dev/v1/query` | `package.name`/`ecosystem` or `purl`, `version`; `page_token` for large results | [S4] |
| Scan result | Stored JSON or SARIF artifact | OSV URL, package, version, fixed version, source path, CVSS | [S5] |

Fixed plan: at most **4** advisory lookups per bundle; one page per query; no recursive alias expansion. Caps: 100 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout. The advisory `details` field is free text and can be long; take a bounded excerpt and never the whole document.

Do not fetch or display:

- Full `affected` ranges for every ecosystem (summarize the fixed version instead).
- Reference URLs with query tokens; keep only the OSV entry and the advisory home page.
- The scan artifact's full package list; only the packages named in the anchor findings.

The scanner's exit status is not documented on the pages reviewed — **UNVERIFIED**. Gate on parsed findings, not on the process exit code, so a scanner change cannot silently turn a failing scan into a pass.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/osv-scanner/` |
| Source enum | Add `osv_scanner` to `INCIDENT_SOURCES` before the adapter |
| Tools | `osv.lookup_advisory` (`read_only`), `osv.get_fixed_version` (`read_only`) |
| Risk bands | No writes. Opening a fix pull request uses the existing repository tools under `scoped_write`/approval, not this connector |
| Env names | `OSV_SCANNER_URL`, `OSV_SCANNER_TOKEN`, `OSV_SCANNER_WEBHOOK_SECRET` |
| Sandbox | Server-side lookup only. No OSV credential exists; egress deny still applies so the sandbox cannot reach the public API directly |
| Tests | Fake OSV responses, missing CVSS, paginated query, `429`/`5xx`, alias dedupe, tenant isolation |

`OSV_SCANNER_URL` defaults to `https://api.osv.dev`; `OSV_SCANNER_TOKEN` is unused for the public API and must stay blank. Keeping the name reserved avoids a later config change if a private mirror is added. `OSV_SCANNER_WEBHOOK_SECRET` belongs to the bridge, not to the scanner.

## 7. Operator setup checklist

1. Pin the scanner version in CI; run `osv-scanner scan -r .` with `--format sarif` and store the artifact.
2. Decide whether the job uses the public API or `--offline-vulnerabilities` with a downloaded database (`--download-offline-databases`) [S2].
3. Add the `osv_scanner` source enum and payload schema in a contract commit.
4. Deploy the bridge with a 32+ character HMAC secret and a URL of `https://<host>/api/webhooks/osv-scanner`.
5. Map the service name to the bound repository; confirm the binding organization cannot be overridden by the payload.
6. Send a synthetic `critical`, a no-CVSS `info`, and a duplicate delivery; confirm severity and dedupe.
7. Confirm the CI job has no write credentials and that `fix` is not invoked.

```dotenv
# Names only. Values are server-side and never documented here.
OSV_SCANNER_URL=
OSV_SCANNER_TOKEN=
OSV_SCANNER_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Advisory fixtures: CVSS present, CVSS absent, aliased IDs, paginated response.
- [ ] Fingerprint stable across repeated scans of the same lockfile.
- [ ] Caps and `truncated` behavior; advisory `details` excerpt bounded.
- [ ] Bridge rejects an unsigned or stale delivery; no task from an invalid signature.
- [ ] No network in tests; fake fetch only.

Live (opt-in, free):

- [ ] One advisory lookup against a known public CVE/OSV id; one task from a synthetic signed delivery.
- [ ] No spend to record; note request count and latency.
- [ ] Confirm no key was created anywhere; the API is anonymous.

## 9. Risks and never in model context

- **Never**: CI tokens, registry credentials, full lockfiles, full SARIF reports, private package names beyond the anchor finding.
- **Never**: advisory `details` as an unbounded blob, or reference URLs carrying tokens.
- Package names and versions are sensitive inventory data; expose only the affected package, not the whole dependency tree.
- `fix` can execute package-manager scripts and follow external registries; it is excluded from the connector and from the sandbox.
- Advisory text is untrusted; it can contain instructions or misleading remediation. It is context, never policy.
- The public API has no SLA. An outage must degrade to a partial bundle, not to "clean".

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [google/osv-scanner](https://github.com/google/osv-scanner) (Apache-2.0) |
| S2 | [OSV-Scanner usage](https://google.github.io/osv-scanner/usage/) |
| S3 | [OSV API](https://google.github.io/osv.dev/api/) |
| S4 | [POST /v1/query](https://google.github.io/osv.dev/post-v1-query/) |
| S5 | [OSV-Scanner output formats](https://google.github.io/osv-scanner/output/) |
| S6 | [google/osv-scanner-action](https://github.com/google/osv-scanner-action) (Apache-2.0) |
