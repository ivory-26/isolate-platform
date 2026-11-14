# Security policy

Isolate is an autonomous DevSecOps control plane. Its core invariant is that provider
credentials stay on a customer-controlled relay and are never stored in the server,
browser, prompt, logs or sandbox. Security reports that test that boundary are welcome.

## Supported versions

Isolate is under active development and has no versioned releases. Only the latest
commit on `main` receives security fixes. Older commits, forks and event snapshots are
not supported.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Under **Reporting**, choose **Report a vulnerability**.
3. Include the details listed below.

If the private reporting form is unavailable, email **karpesahil2007@gmail.com** with
the subject `Isolate security report`. Ask for an encrypted channel before sending any
sensitive material.

Please do not test against other tenants, live customer data or production
infrastructure. Use your own account, synthetic data and a local or disposable
deployment.

### What to include

- The affected component (`apps/web`, `apps/worker`, `apps/device-daemon`, a package,
  or a connector) and the commit you tested.
- A clear description of the impact: what an attacker gains, and what they need to
  start.
- Exact reproduction steps or a minimal proof of concept.
- Whether any credential, token, customer record or cross-tenant read was exposed.
- Any suggested fix or mitigation.
- How you would like to be credited, or whether you prefer to stay anonymous.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 3 business days |
| Initial triage and severity decision | 7 business days |
| Progress update while a fix is open | At least every 7 days |
| Coordinated disclosure | By agreement; 90 days if no date is agreed |

We will confirm the issue, explain the severity and planned fix, and coordinate a
disclosure date with you. If a report is out of scope or not reproducible, we will say
so and explain why.

## Scope

### In scope

- Credential boundary: device-held secrets, pairing, token storage, rotation and
  revocation.
- Authentication, authorization, tenant isolation and organization scoping.
- Webhook intake: signature verification, replay handling, deduplication and caps.
- Approval binding and any path that could push, comment or mutate without a
  payload-bound human approval.
- Sandbox and command policy: escape, policy bypass, unbounded reads or writes.
- Secret leakage into prompts, logs, traces, artifacts, error messages or the client
  bundle.
- Injection into agent tools, connector adapters, workflow definitions or SQL.

### Out of scope

- Vulnerabilities in third-party providers (GitHub, Sentry, Grafana, PagerDuty,
  Kubernetes, Datadog, New Relic, Honeycomb, Axiom, SigNoz, Neon, Modal, Baseten or
  model providers). Report those to the vendor.
- Findings that require live customer credentials, destructive testing, or access to
  data you do not own.
- Denial of service, volumetric load testing, spam and social engineering.
- Synthetic credential-shaped fixtures in the test suite; these are generated at
  runtime and are not live secrets.
- Known limitations already documented in [`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md)
  and [`project/SECURITY.md`](project/SECURITY.md), unless you can show a new impact.

## Handling secrets

- Redact tokens, keys, cookies, customer data and internal URLs from reports and
  screenshots.
- Never send a live credential. If you believe a real credential was exposed, rotate it
  immediately and tell us what was exposed and where — do not include the secret itself.
- `scripts/security-check.ts` and the CI gitleaks scan enforce the repository's
  credential boundary. Reports that bypass either control are especially useful.

## Safe harbor

We will not initiate legal action against researchers who make a good-faith effort to
follow this policy. That protection depends on your staying within it:

- Test only accounts and deployments you own or have explicit permission to test.
- Do not access, modify or exfiltrate data belonging to others.
- Do not degrade, persist in or pivot through systems.
- Stop as soon as you have demonstrated the issue, and report it promptly.

This policy does not authorize testing against third-party providers or waive their
terms.

## Security engineering references

- [`project/SECURITY.md`](project/SECURITY.md) — audit findings, dispositions and the
  secret-scanning incident record.
- [`AGENTS.md`](AGENTS.md) — provider-credit and secret-handling rules for contributors.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) §11 — security boundaries.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute safely.
