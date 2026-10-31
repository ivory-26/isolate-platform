# Trivy connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0 for Trivy and Trivy Operator, verified 2026-10-31; no paid tier required |
| Auth | None for the CLI; a Kubernetes ServiceAccount token for Trivy Operator reads |
| Inbound | None native; CI artifact or Kubernetes custom-resource watch through a signed bridge |
| Read | `aquasecurity.github.io/v1alpha1` report custom resources, or the JSON/SARIF artifact |
| Writes | None in scope |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

Trivy is a scanner, not a service. It has no webhook, no incident object and no SaaS control plane. Any trigger is therefore built from a CI job or a cluster watch, and the bridge is part of the connector design, not an afterthought.

## 1. Role in the agent

Trivy answers "which known vulnerability or misconfiguration affects this artifact, and is a fixed version available". It is the natural trigger for dependency and image findings in a supply-chain loop, and the natural context source when a task is already about a failing image build or a Kubernetes workload.

Kinds proposed: `vulnerability_report` (package or image CVE), `config_audit` (IaC/Kubernetes misconfiguration), `exposed_secret` (a secret found in an image or filesystem). Runtime behaviour is **not** Trivy's role; use Falco or Wazuh for that.

Severity mapping (vendor to platform):

| Trivy severity | `IncidentSignal.severity` |
|---|---|
| `CRITICAL` | `critical` |
| `HIGH` | `high` |
| `MEDIUM` | `medium` |
| `LOW` | `low` |
| `UNKNOWN` | `info` |

`UNKNOWN` is common for unfixed or disputed advisories and must never be promoted to `high` to force a task. Fingerprints are stable per finding, never per scan run:

- Image: `trivy:image:<registry>/<repo>:<tag-or-digest>:<vulnID>:<pkgName>`
- Repository: `trivy:repo:<service>:<target>:<vulnID>:<pkgName>`
- Kubernetes: `trivy:k8s:<namespace>/<workload>:<container>:<vulnID>`

Evidence is the report item: vulnerability ID, package, installed and fixed version, severity, primary URL, and the scan target. The raw report is not evidence for the model; a bounded excerpt is.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | Apache-2.0 for `aquasecurity/trivy` | [S1] |
| Operator license | Apache-2.0 for `aquasecurity/trivy-operator` | [S2] |
| Cost | No licence fee, no metered API; you pay for CI minutes, cluster CPU and storage | [S1], [S2] |
| SaaS | None required. The vulnerability database is pulled from a public OCI registry by default | [S3] |
| API rate limit | Trivy documents no API quota; registry pulls and CI concurrency are the practical limits — **UNVERIFIED** as a hard number | [S3] |
| Retention | None vendor-side. Reports live in the CI artifact store or as Kubernetes custom resources | [S4] |

Self-host cost caveats: the Operator runs scan Jobs in the cluster, so it consumes CPU and memory on every workload change; the database is hundreds of megabytes and must be refreshed; air-gapped installs need a mirrored database and `--skip-db-update` or an offline bundle. These are operational costs, not licence costs, and must be sized before enabling cluster-wide scanning.

## 3. Auth and least privilege

| Mode | Credential | Least privilege |
|---|---|---|
| CLI in CI | None for the scan itself; registry credentials only if the image is private | Prefer a read-only registry robot account scoped to the image repository |
| Trivy Operator read | Kubernetes ServiceAccount token | `get`/`list` on `vulnerabilityreports`, `configauditreports`, `exposedsecretreports`, `sbomreports` in named namespaces only |
| Bridge to the platform | HMAC secret for the signed generic webhook | One secret per deployment; 32+ characters; never reused from another connector |

The connector never holds cluster-admin. The ServiceAccount is bound to a namespaced Role, not a ClusterRole, and the operator's own scan Jobs run under their own ServiceAccount. Rotation is a two-step swap: create the second token/secret, deploy it, confirm acceptance, revoke the first. The platform supports one active secret per webhook mode (see [generic-webhook.md](generic-webhook.md) §7).

Never place a kubeconfig, ServiceAccount token, registry password or Trivy database credential in a prompt, fixture, log line or task goal.

## 4. Inbound trigger

Trivy has **no native webhook**. Two supported triggers:

1. **CI artifact** — the pipeline runs `trivy image` or `trivy fs` with `--format json` or `--format sarif`, stores the artifact, and a small bridge converts the findings that pass policy into one `IncidentSignal`.
2. **Cluster watch** — the Operator writes a report custom resource; a bridge watches that resource and converts it. The Kubernetes watch is the trigger, not the platform.

The bridge must not forward a full report. It selects one anchor finding (highest severity, then newest), writes a bounded `IncidentSignal`, and signs it with the generic transport:

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/<any>` |
| Headers | `x-isolate-timestamp: <unix seconds>`, `x-isolate-signature: sha256=<hex>` |
| Signed string | `${timestamp}.${rawBody}` over the exact bytes sent |
| Algorithm | HMAC-SHA256, constant-time compare |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Secret floor | 32 characters |

A SARIF or JSON report is routinely larger than 64 KiB, so the bridge summarizes before signing. If the bridge cannot fit the signal, it sends the top N findings as separate deliveries with distinct fingerprints instead of truncating silently. Dedupe is `(organization, source, fingerprint)` for 30 minutes; the scan run id belongs in `links` or the summary, never in the fingerprint. `trivy` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

## 5. Read-only context

There is no Trivy HTTP API. Read paths are the artifact and the Kubernetes API:

| Need | Endpoint / resource | Fields used | Source |
|---|---|---|---|
| Image findings | `GET /apis/aquasecurity.github.io/v1alpha1/namespaces/{ns}/vulnerabilityreports/{name}` | `report.artifact`, `summary.criticalCount`/`highCount`, `vulnerabilities[].vulnerabilityID`, `resource`, `installedVersion`, `fixedVersion`, `severity`, `primaryLink` | [S4], [S5] |
| Configuration findings | `GET .../configauditreports/{name}` | check id, title, severity, category, remediation | [S4] |
| Exposed secrets | `GET .../exposedsecretreports/{name}` | rule id, severity, target, **not** the secret value | [S4] |
| SBOM | `GET .../sbomreports/{name}` | component coordinates only | [S4] |
| CI fallback | Stored JSON/SARIF artifact | Same fields, allowlisted and parsed | [S3] |

Fixed plan: at most **5** report reads per bundle, one namespace page, one report per workload/container. Caps from the shared contract: 100 items, 4,000 characters per excerpt, 256 KiB total, and a 10 s per-call timeout. A missing report sets `truncated: true`; a `403` drops that resource, not the bundle.

Ignore and unfixed handling:

- `--ignore-unfixed` hides findings with no fixed version. The connector must record that the scan used it, because "no findings" then means "no fixable findings", not "clean".
- `.trivyignore` filters by ID; `.trivyignore.yaml` (loaded with `--ignorefile`) supports `expired_at`, so a suppression can expire and the finding re-surfaces [S3].
- Suppression is a repository change, not a connector write. The agent may propose it only through the normal owned-path write and review flow; it must never be silent.
- If a suppressed finding is the trigger, the task summary states the suppression and its expiry.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/trivy/` |
| Source enum | Add `trivy` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a contract commit **before** the adapter |
| Tools | `trivy.get_report` (`read_only`), `trivy.list_reports` (`read_only`), `trivy.request_rescan` (`scoped_write`, creates a scan Job) |
| Risk bands | Suppression via a repo file is `scoped_write`; deleting a report or a workload is `destructive` and out of scope |
| Env names | `TRIVY_URL`, `TRIVY_TOKEN`, `TRIVY_WEBHOOK_SECRET` |
| Sandbox | Server-side tools only. The sandbox gets no cluster token, no registry credential and no report body. Egress denied; the worker fetches and redacts |
| Tests | Fake Kubernetes API, CR fixtures for each kind, redaction seeds for `ExposedSecretReport`, cap tests, `403`/`404`/`429`, tenant isolation |

`TRIVY_URL` is the Kubernetes API base (or a read-only report proxy); `TRIVY_TOKEN` is the ServiceAccount token. Neither is ever sent to the model or into the sandbox.

## 7. Operator setup checklist

1. Choose the mode: CI-only, Operator-only, or both. Do not enable cluster-wide scanning before sizing CPU and memory.
2. For CI, run `trivy image --format sarif --output trivy.sarif` (or JSON), pin the Trivy version, and store the artifact with the run.
3. For Kubernetes, install Trivy Operator with its Helm chart and confirm the report CRDs exist (`kubectl get crd | grep aquasecurity`).
4. Create a namespaced Role/RoleBinding for report reads and a ServiceAccount for the bridge. No ClusterRole.
5. Deploy the bridge, set a 32+ character HMAC secret, and point it at `https://<host>/api/webhooks/trivy`.
6. Add `trivy` to `INCIDENT_SOURCES` and the payload schema; apply the contract before enabling the bridge.
7. Confirm the binding (`WEBHOOK_ORGANIZATION_ID`, repository, workflow, ownership) and that the bridge cannot submit into another tenant.
8. Send one synthetic `UNKNOWN` and one `CRITICAL` signal; confirm severity mapping, one task each, and dedupe on resend.

```dotenv
# Names only. Values are server-side and never documented here.
TRIVY_URL=
TRIVY_TOKEN=
TRIVY_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Bridge unit tests: CR and artifact fixtures, severity map, `UNKNOWN` to `info`, fingerprint stability across rescans.
- [ ] Redaction: `ExposedSecretReport` never yields a value; report URLs are https and display-only.
- [ ] Caps: 5 reads, 4,000-character excerpt, 256 KiB total, `truncated` set on drops.
- [ ] Replay: same fingerprint inside 30 minutes creates no second task; changed digest creates a new one.
- [ ] Fake Kubernetes API only; no cluster and no registry access in CI.

Live (opt-in, local, free):

- [ ] One scan of a disposable local image or a `kind` cluster; no external registry credentials.
- [ ] One synthetic signed delivery through the bridge; one task; audit row for any rescan.
- [ ] No metered spend exists for Trivy; record the scan duration and artifact size instead.

## 9. Risks and never in model context

- **Never**: `ExposedSecretReport` values, image layer contents, registry credentials, kubeconfig, ServiceAccount tokens, database credentials.
- **Never**: full SARIF/JSON reports. Only allowlisted fields and a bounded excerpt.
- Ignored findings are a governance risk: an expired `.trivyignore` entry must re-surface, and a suppression must be visible in the task.
- `UNKNOWN` severity and stale databases create false confidence; record the database timestamp and scan time.
- Package names, file paths and image digests can reveal internal architecture. Treat them as provider metadata, not instructions.
- Report text (rule titles, remediation) is untrusted data and can contain injected instructions.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [aquasecurity/trivy](https://github.com/aquasecurity/trivy) (Apache-2.0) |
| S2 | [aquasecurity/trivy-operator](https://github.com/aquasecurity/trivy-operator) (Apache-2.0) |
| S3 | [Trivy filtering](https://trivy.dev/docs/latest/configuration/filtering/) |
| S4 | [Trivy Operator overview](https://aquasecurity.github.io/trivy-operator/latest/) |
| S5 | [VulnerabilityReport CRD](https://aquasecurity.github.io/trivy-operator/latest/docs/crds/vulnerability-report/) |
| S6 | [Trivy reporting formats](https://trivy.dev/docs/latest/configuration/reporting/) |
| S7 | [Trivy exit codes](https://trivy.dev/docs/latest/guide/configuration/others/) |
| S8 | [Trivy vulnerability scanning](https://trivy.dev/docs/latest/scanner/vulnerability/) |
