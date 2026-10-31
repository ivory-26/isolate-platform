# OWASP ZAP connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0, verified 2026-10-31; free |
| Auth | None for the CI scan; optional API key for the ZAP daemon |
| Inbound | None native; CI baseline/full scan through a signed bridge |
| Read | JSON/HTML report artifact, or the ZAP API if a daemon is reachable |
| Writes | None in scope |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

ZAP (Zed Attack Proxy) is an open-source dynamic application security testing (DAST) tool. It scans a running web application, not source code, and produces alerts. It is a CI tool, not a service that calls back.

## 1. Role in the agent

ZAP answers "which web application weakness was observed at this URL, with what risk and confidence". It is the trigger for DAST findings in a pipeline and the context source when a task is about a failing security scan.

Kinds proposed: `dast_alert` (baseline or full scan alert), `scan_failure` (the scan itself failed, not a finding).

Severity mapping:

| ZAP risk | `IncidentSignal.severity` |
|---|---|
| High | `high` |
| Medium | `medium` |
| Low | `low` |
| Informational | `info` |

ZAP has no `Critical` risk level. Do not invent one from CVSS or from the alert name. Confidence is a second axis: a `High` risk alert with `Low` confidence should be `low` or `info` after policy, and the reason must be stated. The default bridge rule is: keep the risk level, but downgrade one band when confidence is `Low` or `False Positive`.

Fingerprint: `zap:<target-host>:<pluginid>:<normalized-path>`. Strip query strings, fragments and session ids from the path; the same alert on `/cart?sid=…` must not create a task per session.

Evidence: plugin id, alert name, risk, confidence, normalized URL, parameter name, CWE/WASC id, and a bounded remediation excerpt. Never the full request/response pair or the evidence string if it contains a token.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | Apache-2.0 | [S1] |
| Cost | Free; you pay for CI minutes and the target application | [S1], [S2] |
| SaaS | None required; ZAP runs as a Docker image or desktop app | [S2] |
| API limit | No vendor quota; scan duration and target rate limits are the practical bounds | [S2] |
| Retention | None vendor-side; the report lives in the CI artifact store | [S2] |
| Webhook | No native webhook in the Automation Framework jobs reviewed — **UNVERIFIED** as a product-wide statement | [S4] |

Cost caveats: a full active scan can take hours and generate significant traffic. It must run against a disposable environment, never production, and with a request-rate limit. CI minutes are the dominant cost.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| CI scan | None for an unauthenticated target | Use a test account only if the scan needs authentication |
| Authenticated scan | Test user credentials | Scoped to the test environment; never a real customer account |
| ZAP daemon API | API key (`X-ZAP-API-Key`) | Only if a long-running daemon is used; exact header **UNVERIFIED** on the pages read |
| Bridge | HMAC secret | Generic signed transport |

The scan target must be an allowlisted host. ZAP will follow links and submit forms; an unrestricted target can attack third-party systems or mutate test data. Keep the scan in a disposable environment and never give the CI job production credentials.

Rotation: the test account password and the ZAP API key follow the normal rotation; the bridge HMAC secret rotates independently.

## 4. Inbound trigger

ZAP has **no native webhook**. The Automation Framework exposes jobs such as `activeScan`, `spiderAjax`, `passiveScan-wait` and `exitStatus`, but no webhook job was found in the reviewed job list [S4]. The trigger is the CI job.

Two scan modes:

| Mode | Command | Use |
|---|---|---|
| Baseline | `zap-baseline.py -t https://target -J report.json -r report.html` | Passive + spider; fast; safe for a PR gate |
| Full | `zap-full-scan.py -t https://target -J report.json -r report.html` | Active attack; slow; disposable environment only |

`-J` writes JSON, `-r` writes HTML, `-x` writes XML, and `-I` stops warnings from failing the build [S2], [S3]. Exit codes are `0` success, `1` at least one FAIL, `2` at least one WARN and no FAIL, `3` any other failure [S2]. Do not map exit code `1` directly to a task: parse the report.

The bridge converts the top alerts into `IncidentSignal` deliveries and signs them with the generic transport:

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/<any>` |
| Signature | `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}` |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes |

A JSON report can be megabytes. The bridge must select top alerts by risk and confidence and send bounded signals, never the report. If the report has more alerts than the per-source cap, send the highest-risk ones and mark the omission in the summary.

`zap` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

## 5. Read-only context

| Need | Source | Fields used | Source |
|---|---|---|---|
| Alert metadata | JSON report `site[].alerts[]` | `pluginid`, `alert`, `riskcode`, `riskdesc`, `confidence`, `cweid`, `wascid` | [S5] |
| Affected URL | `instances[].uri` | normalized host + path, no query | [S5] |
| Parameter | `instances[].param` | name only; no value | [S5] |
| Remediation | `solution`, `reference` | bounded excerpt; links https only | [S5] |
| Live daemon (optional) | `GET /JSON/core/view/alerts/` | Alerts for a base URL; exact path **UNVERIFIED** | [S4] |

Fixed plan: zero network calls when the report is stored; at most 2 daemon calls if a live ZAP instance is configured. Caps: 100 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout.

Never read: `instances[].evidence`, `request-header`, `request-body`, `response-header`, `response-body`, or any full message. Evidence strings can contain session tokens, cookies, API keys and personal data. The alert `desc` is HTML and can embed payloads; strip tags and bound it.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/zap/` |
| Source enum | Add `zap` to `INCIDENT_SOURCES` before the adapter |
| Tools | `zap.get_alert` (`read_only`), `zap.list_alerts` (`read_only`) |
| Risk bands | No provider writes. Triggering a full scan is `scoped_write` because it sends attack traffic; it must be target-allowlisted and is not exposed to the model in v1 |
| Env names | `ZAP_URL`, `ZAP_TOKEN`, `ZAP_WEBHOOK_SECRET` |
| Sandbox | Server-side only. ZAP runs in its own CI container, never inside the task sandbox; the sandbox has no target credentials and no egress |
| Tests | Report fixtures for each risk/confidence, URL normalization, evidence stripping, `exit code 3`, dedupe, tenant isolation |

`ZAP_URL` is optional (a daemon API base); `ZAP_TOKEN` is the daemon API key; `ZAP_WEBHOOK_SECRET` belongs to the bridge.

## 7. Operator setup checklist

1. Choose baseline (PR gate) or full scan (nightly, disposable environment). Do not run full scans against production.
2. Pin the image tag; `ghcr.io/zaproxy/zaproxy:stable` is convenient but not reproducible [S2].
3. Allowlist the target host in the CI job and in the bridge; block redirects to other hosts.
4. Run `zap-baseline.py -t <target> -J zap.json -r zap.html` and store the artifacts.
5. Deploy the bridge with a 32+ character HMAC secret; point it at `https://<host>/api/webhooks/zap`.
6. Add `zap` to `INCIDENT_SOURCES`; deploy the contract before enabling the bridge.
7. Send a report with one High and one Informational alert; confirm severity and that only the High creates a task by default.
8. Confirm no request/response body is present in the bundle.

```dotenv
# Names only. Values are server-side and never documented here.
ZAP_URL=
ZAP_TOKEN=
ZAP_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Report fixture parsing: `riskcode`, `confidence`, `pluginid`, `instances[].uri`, `cweid`.
- [ ] Query string and session id stripped from the fingerprint; same alert does not duplicate.
- [ ] Evidence, request and response fields never appear in a bundle.
- [ ] Confidence downgrade rule and its reason are recorded.
- [ ] Exit codes `0`–`3` handled; `3` is a scan failure, not a finding.

Live (opt-in, local, free):

- [ ] One baseline scan against a local disposable app (for example the ZAP test target).
- [ ] One signed delivery; one task; one deduped resend.
- [ ] No metered spend; record scan duration and report size.

## 9. Risks and never in model context

- **Never**: request/response headers and bodies, cookies, session tokens, `evidence`, authentication credentials, the full HTML report.
- **Never**: the target's production data. A DAST scan mutates state; run it against a disposable environment.
- Full scans are intrusive and can be mistaken for an attack; keep the target allowlist and rate limit.
- Alert text and remediation are untrusted HTML; strip tags, bound the excerpt, and never execute or follow embedded links.
- ZAP risk is not CVSS; mapping it upward distorts triage.
- A `-I` build can pass while warnings remain; the connector must still report the warnings at `low`/`info`.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [zaproxy/zaproxy](https://github.com/zaproxy/zaproxy) (Apache-2.0) |
| S2 | [ZAP baseline scan](https://www.zaproxy.org/docs/docker/baseline-scan/) |
| S3 | [ZAP full scan](https://www.zaproxy.org/docs/docker/full-scan/) |
| S4 | [ZAP Automation Framework](https://www.zaproxy.org/docs/automate/automation-framework/) |
| S5 | [Traditional JSON report](https://www.zaproxy.org/docs/desktop/addons/report-generation/report-traditional-json/) |
| S6 | [ZAP documentation](https://www.zaproxy.org/docs/) |
