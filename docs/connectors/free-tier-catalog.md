# Free-tier catalog — connector-by-connector

| Field | Value |
|---|---|
| Status | Research summary; **no connector in this table is implemented except GitHub and the generic webhook** |
| Date | 2026-10-31 |
| Basis | Each row is taken from that page's verified header and §2 free-tier section; unverified points are carried as **UNVERIFIED**, not filled in |
| Scope | What a user can connect for free (free plan or self-hosted), and what the platform should refuse to default |
| Companion | [`../connector-onboarding.md`](../connector-onboarding.md) (credential flow, guard budget) |

## 1. How to read this page

- **Free-forever?** `yes` means the vendor publishes a recurring $0 plan or the
  software is free to self-host; `trial` means credit or days only; `oss-only`
  means the free path is self-hosted open source with no vendor SaaS tier;
  `no` means a free account exists but cannot support this connector, or the
  product is discontinued.
- **Self-host free?** `yes` only when the page verifies a free self-hosted
  edition or an OSS licence. `not stated` is not a "no".
- **Signed webhooks?** `yes` is a documented HMAC or signature scheme.
  `no (bridge)` means the native webhook is unsigned (or absent) and the
  platform's signed generic bridge is required. `no` means unsigned and no
  bridge path is specified.
- **Key free limits** are the numbers that change a design decision, not the
  full plan. A missing number is not unlimited.
- **Recommended default?** `yes` = a good first connection for most teams;
  `conditional` = only with the stated caveat; `no` = do not offer as a default.
- Every "UNVERIFIED" in a source page stays "UNVERIFIED" here.

## 2. Verified matrix

| Connector | Category | Free-forever? | Self-host free? | Key free limits | Signed webhooks? | Read API? | Recommended default? | Page |
|---|---|---|---|---|---|---|---|---|
| GitHub | Source control | yes | not stated | GitHub Free; installation token 5,000 req/h; Actions logs 90 days [1] | yes (`x-hub-signature-256`) | yes | yes | [github.md](github.md) |
| GitHub security alerts | Source control | yes (public repos only) | not stated | Public repos free; private needs Code Security $30 and/or Secret Protection $19 per committer/mo | yes (GitHub App) | yes | conditional: public repos only | [github-security.md](github-security.md) |
| Sentry | Error tracking | yes | not stated | 5,000 errors, 5 GB logs, 5 GB metrics, 5M spans, 50 replays/mo; 30-day retention; 1 user | yes | yes | yes | [sentry.md](sentry.md) |
| Rollbar | Error tracking | yes | not stated | 5,000 occurrences and 1,000 sessions/mo; 30-day retention | no (bridge) | yes | yes | [rollbar.md](rollbar.md) |
| PagerDuty | Incident/on-call | yes | no | 5 users, 1 schedule, 1 escalation policy, 100 SMS/mo; REST API included; 960 req/min | yes | yes | yes | [pagerduty.md](pagerduty.md) |
| incident.io | Incident/on-call | no | no | Basic is free forever but **excludes API and outgoing webhooks**; paid Team $19, Pro $25/user/mo | yes (paid only) | yes (paid only) | no | [incident-io.md](incident-io.md) |
| Rootly | Incident/on-call | no | no | No free plan; 14-day trial; $20/user/mo per product; 3,000 req/min | yes | yes | no | [rootly.md](rootly.md) |
| Better Stack | Incident/on-call | yes | no | 10 monitors, 1 status page, 1 responder, 3 GB logs and traces/mo, 3-day retention, 100k exceptions | no (bridge) | yes | yes | [betterstack.md](betterstack.md) |
| UptimeRobot | Incident/on-call | yes | no | 50 monitors, 5-minute interval, API included, 10 req/min | no (bridge) | yes | yes | [uptimerobot.md](uptimerobot.md) |
| Uptime Kuma | Incident/on-call | oss-only | yes | MIT; no vendor quota; `/metrics` read only; no supported REST API | no (bridge) | limited (`/metrics`) | yes (self-host) | [uptime-kuma.md](uptime-kuma.md) |
| Slack | Notification | not stated [2] | no | Page records no pricing; notify-only, `chat:write` | no (outbound only) | no | no (notify-only) | [slack.md](slack.md) |
| Grafana | Observability | yes | yes | Cloud Free: 10k series, 50 GB logs, 50 GB traces/mo, 3 users, 14-day retention; OSS AGPLv3 | yes | yes | yes | [grafana.md](grafana.md) |
| Prometheus | Observability | oss-only | yes | Apache-2.0; no vendor quota; 15-day retention default; 50M samples/query | no (bridge) | yes | yes | [prometheus.md](prometheus.md) |
| Loki and Tempo | Observability | yes | yes | AGPLv3; Cloud Free 50 GB logs and 50 GB traces/mo, 14 days | no (bridge) | yes | yes | [loki-tempo.md](loki-tempo.md) |
| Datadog | Observability | yes | no | 5 hosts, 1-day metric retention; no free log allowance stated; events API 250k/min | no (bridge) | yes | conditional: metrics only, no logs | [datadog.md](datadog.md) |
| New Relic | Observability | yes | no | 100 GB/mo ingest; 1 full user, unlimited basic; at least 8-day retention; NRQL 120/min | no (bridge) | yes | yes | [newrelic.md](newrelic.md) |
| Honeycomb | Observability | yes | no | 20M events and 100M points/mo; 2 triggers; no SLOs; 60-day events; 10 req/min | no (bridge) | yes | yes | [honeycomb.md](honeycomb.md) |
| Axiom | Observability | yes | no | 500 GB/mo load, 25 GB storage, 30 days, 3 datasets, 1 user, 10 GB-hours query/mo | no (bridge) | yes | yes | [axiom.md](axiom.md) |
| SigNoz | Observability | oss-only | yes | Community Edition free, self-hosted, no data caps; Cloud has **no free tier**, 30-day trial then $49/mo | no (bridge) | yes | yes (self-host) | [signoz.md](signoz.md) |
| Splunk | Observability | no | no | Free license 500 MB/day but alerting reportedly unavailable; Enterprise trial 60 days; Cloud trial 14 days | no (bridge) | yes | no | [splunk.md](splunk.md) |
| Elastic | Observability | oss-only | yes | Self-hosted Basic free forever; Elastic Cloud is a 14-day trial with no free-forever tier | no (bridge) | yes | yes (self-host) | [elastic.md](elastic.md) |
| CloudWatch | Cloud monitoring | yes (allowance) | no | 10 custom/detailed metrics/mo, 1M API requests (excludes `GetMetricData`), 5 GB logs, 3 dashboards, 10 alarms | no (SNS bridge) | yes | conditional: `GetMetricData` is paid | [cloudwatch.md](cloudwatch.md) |
| Azure Monitor | Cloud monitoring | yes (allowance) | no | First 5 GB/mo analytics ingest, 31-day included retention; 200 queries/30 s | no (bridge) | yes | conditional: watch Basic/Auxiliary tables | [azure-monitor.md](azure-monitor.md) |
| Google Cloud Monitoring | Cloud monitoring | yes (allowance) | no | 50 GiB logs/project/mo, 30-day default retention, 1M time-series reads/mo; 60 `entries.list`/min | no (bridge) | yes | conditional: 6-month free-account plan is a trial | [gcp-monitoring.md](gcp-monitoring.md) |
| Apache Kafka | Streaming | oss-only | yes | Apache-2.0; 1 MiB broker message default; 7-day retention default; no vendor account | n/a (bridge HMAC) | no | yes (self-host) | [kafka.md](kafka.md) |
| Aiven for Kafka | Streaming | yes | no | 1 service/org, 5 topics × 2 partitions, 250 KiB/s in and out, 3-day retention, no card, no SLA | n/a (bridge) | no | yes (pilot) | [aiven-kafka.md](aiven-kafka.md) |
| Confluent Cloud | Streaming | trial | not stated | $400 credit for 30 days; **no free-forever cluster**; card required | n/a (bridge) | no | no | [confluent.md](confluent.md) |
| Redpanda | Streaming | trial | yes (BSL 1.1) | Serverless 30-day trial, $100 credit, 7-day grace; no free Cloud tier; Community Edition is source-available | n/a (bridge) | no | conditional: self-host only | [redpanda.md](redpanda.md) |
| Upstash Kafka | Streaming | no | no | Product discontinued; docs and pricing return `404` | n/a | no | no | [upstash-kafka.md](upstash-kafka.md) |
| Kubernetes | Runtime | oss-only | yes | Apache-2.0; no SaaS tier; events retained 1 h by default | no (bridge) | yes | yes | [kubernetes.md](kubernetes.md) |
| Argo CD | Runtime | oss-only | yes | Apache-2.0; no vendor quota; no project SaaS tier | no (bridge) | yes | yes | [argocd.md](argocd.md) |
| Falco | Runtime security | oss-only | yes | Apache-2.0 for Falco, Falcosidekick and Talon; no vendor quota | no (bridge) | no | yes | [falco.md](falco.md) |
| CrowdSec | Runtime security | oss-only | yes | MIT; no published LAPI quota | no (bridge) | yes | yes | [crowdsec.md](crowdsec.md) |
| Wazuh | Runtime security | oss-only | yes | GPL-2.0 / AGPL-3.0; no published manager API quota | no (bridge) | limited (manager API) | conditional: ops-heavy | [wazuh.md](wazuh.md) |
| Trivy | Supply chain | oss-only | yes | Apache-2.0; no metered API; DB pulled from a public OCI registry | no (bridge) | limited (CR/artifact) | yes | [trivy.md](trivy.md) |
| OSV-Scanner | Supply chain | oss-only | yes | Apache-2.0; public API keyless, vendor states "no limits"; no SLA | no (bridge) | yes | yes | [osv-scanner.md](osv-scanner.md) |
| Semgrep | Supply chain | yes | yes | OSS LGPL-2.1 free; Free Edition 10 contributors and 10 private repos; no hosted API in OSS | yes | yes (Free Edition) | yes (OSS) | [semgrep.md](semgrep.md) |
| Scorecard | Supply chain | oss-only | yes | Apache-2.0; public API free; weekly scans omit CI-Tests, Contributors, Dependency-Update-Tool | no (bridge) | yes | yes | [scorecard.md](scorecard.md) |
| GitGuardian | Supply chain | yes | no | Starter: 25 devs, 500 historical detections, 10k API calls/mo | yes | yes | yes | [gitguardian.md](gitguardian.md) |
| Dependency-Track | Supply chain | oss-only | yes | Apache-2.0; no vendor quota; signed webhook only in 5.2.0+ | yes (5.2.0+) | yes | yes | [dependency-track.md](dependency-track.md) |
| DefectDojo | Supply chain | oss-only | yes | BSD-3-Clause open-source edition; no published API quota; webhooks experimental and unsigned | no | yes | conditional | [defectdojo.md](defectdojo.md) |
| ZAP | Supply chain | oss-only | yes | Apache-2.0; no vendor quota; CI minutes are the cost | no (bridge) | limited (artifact/API) | yes | [zap.md](zap.md) |
| Socket | Supply chain | yes | no | 1,000 scans/mo, 500 API requests (unit ambiguous), 14-day scan retention; webhooks not included | yes (paid only) | yes | conditional: poll-only on Free | [socket.md](socket.md) |
| Snyk | Supply chain | no | no | Free plan 5 projects but **API is Enterprise-only**; test counts contradictory (200 vs 400/mo) | yes (plan gating UNVERIFIED) | no (Free/Team) | no | [snyk.md](snyk.md) |
| Generic signed webhook | Transport | n/a | n/a | No provider; platform caps 64 KiB body and 60 deliveries/min | yes (`X-Isolate-Signature`) | no | yes (transport) | [generic-webhook.md](generic-webhook.md) |

[1] The rate limit is from [github-security.md](github-security.md) §2, which
cites the GitHub REST rate-limit page; [github.md](github.md) does not restate a
free-plan entitlement. GitHub Free is "public/private within plan" in
[`../connector-usage.md`](../connector-usage.md) §8. [2] Slack's page records no
pricing, so no free-tier claim is carried; Slack is notify-only and is not a
context source.

## 3. Stays free — recommended shortlist

These are free forever, have a usable read path, and need no platform-held key:

| Group | Connectors | Why |
|---|---|---|
| Error tracking | Sentry, Rollbar | Free plans are recurring, not trials; read APIs are usable |
| Incident/on-call | PagerDuty, Better Stack, UptimeRobot, Uptime Kuma | PagerDuty Free has the API; the others are small-team sized |
| Observability | Grafana (Cloud Free or OSS), Prometheus, Loki/Tempo, Axiom, Honeycomb, New Relic | Recurring free plans or OSS; 14–60-day windows are enough for incident context |
| Source control | GitHub (public and private within plan) | Already implemented; no new credential model |
| Runtime | Kubernetes, Argo CD, Falco, CrowdSec | OSS, self-hosted, no metered vendor API |
| Supply chain | Trivy, OSV-Scanner, Semgrep OSS, Scorecard, GitGuardian Starter, Dependency-Track, DefectDojo, ZAP | OSS scanners and small free plans |
| Streaming | Apache Kafka OSS, Aiven free tier | Self-host or a genuinely free 1-service tier |

Self-hosted OSS is the default recommendation whenever a SaaS is trial-only.
The platform pays nothing for any row above; the user pays only their own
infrastructure.

## 4. Do not default — trial-only, paid-only or misleading "free"

| Connector or feature | Why it must not be a default |
|---|---|
| Confluent Cloud | $400 / 30-day trial; card required; no free-forever cluster |
| Redpanda Cloud | 30-day, $100 trial; no free Cloud tier (self-host Community is BSL 1.1) |
| Elastic Cloud | 14-day trial; free-forever means self-hosted Basic, not Cloud |
| SigNoz Cloud | No free tier; 30-day trial, then $49/mo; only Community self-host is free |
| Rootly | No free plan; 14-day trial; $20/user/mo per product |
| incident.io paid tier | Basic is free but excludes API and outgoing webhooks; no zero-cost connector |
| Splunk Cloud, and Splunk Free for alerts | Cloud is a 14-day trial; Free's alerting is reportedly unavailable (UNVERIFIED) |
| Snyk API | Free and Team tokens do not have API access; Enterprise required |
| GitHub private code/secret scanning | Code Security $30 and Secret Protection $19 per active committer/mo; GitHub Free orgs cannot buy them |
| CloudWatch `GetMetricData` | Explicitly excluded from the 1M free API requests; billed per metric requested |
| Socket webhooks | Not included on Free (lowest including plan UNVERIFIED); poll-only |
| Datadog logs | No free log allowance stated; Log Management is separately priced |
| AWS/Azure/GCP free-account plans | Six-month or credit-based trials; use only the recurring Always Free / monthly allowances |
| Upstash Kafka | Product discontinued; no current tier |
| Azure Basic/Auxiliary log tables | Billed per GB scanned; the reader must use Analytics tables |

Also avoid defaulting any connector whose only free path is a one-time
historical allowance (GitGuardian's 500 detections) or a grant for open-source
maintainers (Socket Business upgrades). Those are not recurring capacity.

## 5. Free-tier guard defaults (platform policy)

**These numbers are platform policy, not provider limits.** They are the
suggested per-organization budgets enforced by
[`../connector-onboarding.md`](../connector-onboarding.md) §5. Where the
provider publishes a limit, the budget is at or below 80% of it; where it does
not, the budget is a conservative default chosen to keep one org from exhausting
a shared free plan. `0` means the connector is disabled by default.

| Connector | Requests/min | Requests/day | Monthly cap | Basis |
|---|---|---|---|---|
| GitHub | 60 | 2,000 | 20,000 | 80% of the 5,000/h installation-token limit, spread |
| GitHub security alerts | 30 | 500 | 5,000 | Same token budget, narrower surface |
| Sentry | 10 | 500 | 3,000 | No published numeric rate limit; conservative |
| Rollbar | 10 | 500 | 5,000 | No published read rate; conservative |
| PagerDuty | 30 | 1,000 | 10,000 | Provider 960/min; platform budget is far lower |
| incident.io | 0 | 0 | 0 | Disabled: API is paid-only |
| Rootly | 0 | 0 | 0 | Disabled: no free plan |
| Better Stack | 10 | 500 | 5,000 | API rate unpublished; conservative |
| UptimeRobot | 8 | 200 | 2,000 | Provider 10/min; 80% guard |
| Uptime Kuma | 5 | 200 | 2,000 | Self-host; one scrape per bundle |
| Slack | 0 | 0 | 0 | Notify-only; no context read |
| Grafana | 20 | 1,000 | 10,000 | No published numeric limit; conservative |
| Prometheus | 30 | 2,000 | 20,000 | Self-host; query cost is the real limit |
| Loki/Tempo | 20 | 1,000 | 10,000 | Self-host or Cloud Free; conservative |
| Datadog | 10 | 500 | 5,000 | Per-endpoint limits unpublished; conservative |
| New Relic | 10 | 500 | 5,000 | NRQL 120/min; NerdGraph 25 concurrent |
| Honeycomb | 8 | 300 | 3,000 | Provider 10/min; 80% guard |
| Axiom | 10 | 500 | 5,000 | No published request rate; query compute is metered |
| SigNoz | 20 | 1,000 | 10,000 | Self-host; conservative |
| Splunk | 0 | 0 | 0 | Disabled: Free cannot alert |
| Elastic (self-host) | 10 | 500 | 5,000 | No universal limit; one query per bundle |
| CloudWatch | 10 | 300 | 3,000 | 1M API requests/mo allowance; `GetMetricData` capped separately |
| Azure Monitor | 20 | 1,000 | 10,000 | Provider 200/30 s; conservative |
| Google Cloud Monitoring | 10 | 300 | 3,000 | Provider 60 `entries.list`/min; conservative, far below the 80% guard |
| Apache Kafka | 60 (events) | 10,000 (events) | 100,000 (events) | Bridge throughput, not a provider API |
| Aiven Kafka | 60 (events) | 5,000 (events) | 50,000 (events) | Free tier is 250 KiB/s; volume is the limit |
| Confluent | 0 | 0 | 0 | Disabled: trial only |
| Redpanda | 0 | 0 | 0 | Disabled by default; self-host opt-in |
| Upstash Kafka | 0 | 0 | 0 | Discontinued |
| Kubernetes | 30 | 1,000 | 10,000 | APF limits are server-side; conservative |
| Argo CD | 10 | 300 | 3,000 | No numeric limit; conservative |
| Falco | 10 | 500 | 5,000 | Event volume is the limit; bridge only |
| CrowdSec | 10 | 500 | 5,000 | No published LAPI quota |
| Wazuh | 10 | 500 | 5,000 | No published manager quota |
| Trivy | 20 | 1,000 | 10,000 | Artifact/CR reads; no vendor API |
| OSV-Scanner | 20 | 1,000 | 10,000 | Vendor says "no limits"; platform still caps |
| Semgrep | 10 | 500 | 5,000 | Free Edition is small-team sized |
| Scorecard | 20 | 1,000 | 10,000 | Public API is CDN-cached |
| GitGuardian | 10 | 300 | 3,000 | Provider 10k API calls/mo; 30% headroom |
| Dependency-Track | 10 | 500 | 5,000 | Self-host; no published quota |
| DefectDojo | 10 | 500 | 5,000 | Self-host; no published quota |
| ZAP | 20 | 1,000 | 10,000 | Report/API reads; CI is the cost |
| Socket | 5 | 100 | 500 | 500 API requests is the safe total until the unit is proven |
| Snyk | 0 | 0 | 0 | Disabled: API is Enterprise-only |
| Generic webhook | 60 (deliveries) | 2,000 (deliveries) | n/a | Platform intake cap from `connector-usage.md` §5.3 |

The ledger enforces the lower of the per-minute, per-day and per-month
headroom. A rejection is `BUDGET_EXCEEDED`, never a silent drop and never an
upgrade prompt. The budget may be lowered per organization; it may not be
raised above the 80% guard by a user.

## 6. Carried UNVERIFIED marks

Do not turn any of these into a number without re-checking the vendor page:

- Snyk: 200 versus 400 Open Source tests/month; webhook plan gating.
- Socket: 500 API requests total versus 500/hour; lowest webhook tier.
- Splunk: whether Free really cannot alert; REST auth on Free.
- Datadog: free log allowance; custom-metric allowance; per-endpoint rate limits.
- Better Stack: free metric allowance; API rate limits.
- New Relic: exact retention tiers beyond "at least 8 days".
- Sentry: overage behavior; numeric rate limits.
- Axiom: overage behavior; token permission strings.
- Grafana: numeric per-endpoint API limits.
- GCP: per-GiB ingest overage price; free-account trial terms.
- Azure: whether the 5 GB grant is shared by Basic/Auxiliary; free-account credit.
- Elastic: the widely repeated "$400 credit" is not stated; Cloud data after trial.
- GitHub security: code-scanning/SARIF retention.
- UptimeRobot: free retention for logs and response times.
- Uptime Kuma: minimum check interval; heartbeat retention default.
- Incident.io: trial length for paid plans.
- Rootly: retention; API plan gating.
- Slack: no pricing on the page at all.

## 7. Sources

Vendor facts are from the per-connector pages under this directory, each of
which cites its own primary URLs and records an access date of 2026-10-31. The
GitHub rate limit is from [github-security.md](github-security.md) §2; the
free-plan framing is from [`../connector-usage.md`](../connector-usage.md) §8.
No number in this page was refreshed by a web search for this document; where a
page lacked a number, the row carries the page's **UNVERIFIED** mark instead of
a new claim. Platform budgets in §5 are policy, not vendor facts.
