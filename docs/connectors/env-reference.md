# Connector environment reference

| Field | Value |
|---|---|
| Purpose | Names only for every connector setting; no values |
| Generated from | `docs/connectors/*.md` dotenv blocks, 2026-10-31; the six bridge-only connector blocks and the GitHub App section checked against code 2026-11-13 |
| Product model | Provider keys are held on the user's relay; the server stores only a device-token hash and connector metadata (`credential_ref`), never a secret. See [`docs/connector-onboarding.md`](../connector-onboarding.md) |
| When to use env | Deployment-level webhook verification secrets and the GitHub App identity only; vendor read keys belong on the relay |

**Platform-level (deployment env):** `DATABASE_URL`, `DEVICE_GATEWAY_ENABLED`, the GitHub App identity below, the generic signed-bridge secret `WEBHOOK_SIGNING_SECRET`, and the per-connector intake secrets (`WEBHOOK_SENTRY_SECRET`, `WEBHOOK_GRAFANA_SECRET`, `WEBHOOK_PAGERDUTY_SECRET`). There is no server-side credential encryption key.

Never commit values. A relay-held credential takes precedence over an env fallback.

`WEBHOOK_SIGNING_SECRET` is the only platform-held secret for Datadog, New
Relic, Honeycomb, Axiom, SigNoz and Kubernetes. None of the six has a native
intake adapter: each trigger arrives as a full `IncidentSignal` over
`POST /api/webhooks/<any-path>`, signed as HMAC-SHA256 over
`<timestamp>.<body>` with that secret (headers `x-isolate-timestamp` and
`x-isolate-signature: sha256=<64 hex>`). The vendor names in those six blocks
are **relay-local examples**: the daemon reads whatever env var name the
deployment configures in `vendors.<connector>.secretEnv`, and a paired
credential in the relay's encrypted local store takes precedence. Only
`KUBERNETES_API_URL` and `KUBERNETES_NAMESPACE` are fixed env fallbacks.

## GitHub App (operator, deployment-level)

Guide: [github.md](github.md)

These are deployment names, not customer credentials and not per-tenant values. Set
them once in the deployment secret manager. Missing or invalid required settings
produce the fixed `GITHUB_APP_NOT_CONFIGURED` error (HTTP 503); no partially
configured flow starts. The operator checklist is in [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_APP_STATE_SECRET=
GITHUB_API_BASE_URL=
# Legacy single-binding fallback only; per-organization installs are stored in the database.
GITHUB_APP_INSTALLATION_ID=
```

- `GITHUB_APP_ID` is numeric. `GITHUB_APP_SLUG` matches
  `^[A-Za-z0-9][A-Za-z0-9-]{0,99}$`.
- Use exactly one of `GITHUB_APP_PRIVATE_KEY` (inline PKCS#8 PEM) or
  `GITHUB_APP_PRIVATE_KEY_PATH` (server-side file). Never both as a long-term
  configuration; never commit either.
- `GITHUB_APP_STATE_SECRET` is at least 32 characters. It signs the ten-minute
  install state and is shared by the deployment, never per tenant.
- `GITHUB_API_BASE_URL` is optional (default `https://api.github.com`).
- `GITHUB_APP_SLUG` and `GITHUB_APP_STATE_SECRET` must never be generated or
  stored per workspace.

## Argo CD connector

Guide: [argocd.md](argocd.md)

```dotenv
ARGOCD_BASE_URL=
ARGOCD_PROJECT=
ARGOCD_TOKEN=
ARGOCD_WEBHOOK_SECRET=
```

## Axiom connector

Guide: [axiom.md](axiom.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
AXIOM_TOKEN=
```

## Azure Monitor connector

Guide: [azure-monitor.md](azure-monitor.md)

```dotenv
AZURE_ALERT_RULE_ALLOWLIST=
AZURE_APP_INSIGHTS_APP_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_FEDERATED_TOKEN_FILE=
AZURE_LOG_ANALYTICS_WORKSPACE_ID=
AZURE_SUBSCRIPTION_ID=
AZURE_TENANT_ID=
WEBHOOK_SIGNING_SECRET=
```

## Better Stack connector

Guide: [betterstack.md](betterstack.md)

```dotenv
BETTERSTACK_API_KEY=
BETTERSTACK_BASE_URL=
BETTERSTACK_QUERY_BASE_URL=
BETTERSTACK_QUERY_PASSWORD=
BETTERSTACK_QUERY_USERNAME=
BETTERSTACK_WEBHOOK_SECRET=
```

## AWS CloudWatch connector

Guide: [cloudwatch.md](cloudwatch.md)

```dotenv
AWS_EXTERNAL_ID=
AWS_REGION=
AWS_ROLE_ARN=
CLOUDWATCH_ALARM_ARN_ALLOWLIST=
CLOUDWATCH_LOG_GROUP_ALLOWLIST=
CLOUDWATCH_METRIC_NAMESPACE_ALLOWLIST=
SNS_TOPIC_ARN_ALLOWLIST=
WEBHOOK_SIGNING_SECRET=
```

## CrowdSec connector

Guide: [crowdsec.md](crowdsec.md)

```dotenv
CROWDSEC_TOKEN=
CROWDSEC_URL=
CROWDSEC_WEBHOOK_SECRET=
```

## Datadog connector

Guide: [datadog.md](datadog.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
DD_API_KEY=
DD_APP_KEY=
```

## DefectDojo connector

Guide: [defectdojo.md](defectdojo.md)

```dotenv
DEFECTDOJO_TOKEN=
DEFECTDOJO_URL=
DEFECTDOJO_WEBHOOK_SECRET=
```

## Dependency-Track connector

Guide: [dependency-track.md](dependency-track.md)

```dotenv
DEPENDENCY_TRACK_TOKEN=
DEPENDENCY_TRACK_URL=
DEPENDENCY_TRACK_WEBHOOK_SECRET=
```

## Elastic connector

Guide: [elastic.md](elastic.md)

```dotenv
ELASTIC_API_KEY=
ELASTIC_API_URL=
ELASTIC_INDEX_PATTERN=
ELASTIC_WEBHOOK_HEADER=
ELASTIC_WEBHOOK_SECRET=
```

## Falco connector

Guide: [falco.md](falco.md)

```dotenv
FALCO_TOKEN=
FALCO_URL=
FALCO_WEBHOOK_SECRET=
```

## Google Cloud Monitoring connector

Guide: [gcp-monitoring.md](gcp-monitoring.md)

```dotenv
GCP_ALERT_POLICY_ALLOWLIST=
GCP_LOG_NAME_ALLOWLIST=
GCP_PROJECT_ID=
GCP_SERVICE_ACCOUNT_EMAIL=
GCP_SERVICE_ACCOUNT_KEY_JSON=
GCP_SERVICE_ACCOUNT_KEY_PATH=
GCP_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

## Grafana connector

Guide: [grafana.md](grafana.md)

```dotenv
GRAFANA_BASE_URL=
GRAFANA_DATASOURCE_UID_LOGS=
GRAFANA_DATASOURCE_UID_METRICS=
GRAFANA_ORG_ID=
GRAFANA_TOKEN=
GRAFANA_WEBHOOK_SECRET=
GRAFANA_WEBHOOK_TIMESTAMP_HEADER=
```

## Honeycomb connector

Guide: [honeycomb.md](honeycomb.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
HONEYCOMB_API_KEY=
```

## incident.io connector

Guide: [incident-io.md](incident-io.md)

```dotenv
INCIDENT_IO_API_KEY=
INCIDENT_IO_BASE_URL=
INCIDENT_IO_WEBHOOK_SECRET=
```

## Kubernetes connector

Guide: [kubernetes.md](kubernetes.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
KUBERNETES_API_URL=
KUBERNETES_NAMESPACE=
KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE=
KUBERNETES_CA_FILE=
```

## Loki and Tempo connector

Guide: [loki-tempo.md](loki-tempo.md)

```dotenv
LOKI_BASE_URL=
LOKI_TENANT_ID=
LOKI_TOKEN=
LOKI_WEBHOOK_SECRET=
TEMPO_BASE_URL=
TEMPO_TENANT_ID=
TEMPO_TOKEN=
```

## New Relic connector

Guide: [newrelic.md](newrelic.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
NEW_RELIC_API_KEY=
```

## OSV-Scanner connector

Guide: [osv-scanner.md](osv-scanner.md)

```dotenv
OSV_SCANNER_TOKEN=
OSV_SCANNER_URL=
OSV_SCANNER_WEBHOOK_SECRET=
```

## PagerDuty connector

Guide: [pagerduty.md](pagerduty.md)

```dotenv
PAGERDUTY_API_KEY=
PAGERDUTY_BASE_URL=
PAGERDUTY_FROM_EMAIL=
PAGERDUTY_WEBHOOK_SECRET=
```

## Prometheus connector

Guide: [prometheus.md](prometheus.md)

```dotenv
PROMETHEUS_ALERTMANAGER_URL=
PROMETHEUS_BASE_URL=
PROMETHEUS_CLUSTER_ID=
PROMETHEUS_TOKEN=
PROMETHEUS_WEBHOOK_SECRET=
```

## Rollbar connector

Guide: [rollbar.md](rollbar.md)

```dotenv
ROLLBAR_API_KEY=
ROLLBAR_BASE_URL=
ROLLBAR_PROJECT_ID=
ROLLBAR_WEBHOOK_SECRET=
```

## Rootly connector

Guide: [rootly.md](rootly.md)

```dotenv
ROOTLY_API_KEY=
ROOTLY_BASE_URL=
ROOTLY_WEBHOOK_SECRET=
```

## OpenSSF Scorecard connector

Guide: [scorecard.md](scorecard.md)

```dotenv
SCORECARD_TOKEN=
SCORECARD_URL=
SCORECARD_WEBHOOK_SECRET=
```

## Sentry connector

Guide: [sentry.md](sentry.md)

```dotenv
SENTRY_API_KEY=
SENTRY_BASE_URL=
SENTRY_ORG_ID=
SENTRY_WEBHOOK_SECRET=
```

## SigNoz connector

Guide: [signoz.md](signoz.md)

```dotenv
WEBHOOK_SIGNING_SECRET=
SIGNOZ_API_KEY=
```

## Splunk connector

Guide: [splunk.md](splunk.md)

```dotenv
SPLUNK_API_TOKEN=
SPLUNK_API_URL=
SPLUNK_BRIDGE_SECRET=
SPLUNK_INDEX=
```

## Trivy connector

Guide: [trivy.md](trivy.md)

```dotenv
TRIVY_TOKEN=
TRIVY_URL=
TRIVY_WEBHOOK_SECRET=
```

## Uptime Kuma connector

Guide: [uptime-kuma.md](uptime-kuma.md)

```dotenv
UPTIME_KUMA_API_KEY=
UPTIME_KUMA_BASE_URL=
UPTIME_KUMA_MONITOR_ALLOWLIST=
UPTIME_KUMA_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

## UptimeRobot connector

Guide: [uptimerobot.md](uptimerobot.md)

```dotenv
UPTIMEROBOT_API_KEY=
UPTIMEROBOT_MONITOR_ALLOWLIST=
UPTIMEROBOT_WEBHOOK_TOKEN=
WEBHOOK_SIGNING_SECRET=
```

## Wazuh connector

Guide: [wazuh.md](wazuh.md)

```dotenv
WAZUH_PASSWORD=
WAZUH_URL=
WAZUH_USER=
WAZUH_WEBHOOK_SECRET=
```

## OWASP ZAP connector

Guide: [zap.md](zap.md)

```dotenv
ZAP_TOKEN=
ZAP_URL=
ZAP_WEBHOOK_SECRET=
```
