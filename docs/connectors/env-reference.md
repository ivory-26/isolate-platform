# Connector environment reference

| Field | Value |
|---|---|
| Purpose | Names only for every connector setting; no values |
| Generated from | `docs/connectors/*.md` dotenv blocks, 2026-10-31 |
| Product model | Per-organization credentials are stored encrypted in `connector_credentials`; see [`docs/connector-onboarding.md`](../connector-onboarding.md) |
| When to use env | Single-tenant/operator fallback before the credential UI exists, or deployment-level secrets (webhook secrets, KEK) |

**Platform-level (deployment env):** `CONNECTOR_CREDENTIAL_KEY` (KEK for the credential store), `DATABASE_URL`.

Never commit values. A stored per-organization credential takes precedence over an env fallback.

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
AXIOM_API_TOKEN=
AXIOM_API_URL=
AXIOM_DATASET=
AXIOM_WEBHOOK_HEADER=
AXIOM_WEBHOOK_SECRET=
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
DATADOG_API_KEY=
DATADOG_APP_KEY=
DATADOG_SITE=
DATADOG_WEBHOOK_HEADER=
DATADOG_WEBHOOK_SECRET=
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
HONEYCOMB_API_HOST=
HONEYCOMB_API_KEY=
HONEYCOMB_DATASET=
HONEYCOMB_WEBHOOK_TOKEN=
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
KUBERNETES_API_URL=
KUBERNETES_CA_FILE=
KUBERNETES_CLUSTER_ID=
KUBERNETES_NAMESPACE=
KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE=
KUBERNETES_WEBHOOK_SECRET=
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
NEW_RELIC_ACCOUNT_ID=
NEW_RELIC_REGION=
NEW_RELIC_USER_API_KEY=
NEW_RELIC_WEBHOOK_HEADER=
NEW_RELIC_WEBHOOK_SECRET=
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
SIGNOZ_API_KEY=
SIGNOZ_API_URL=
SIGNOZ_WEBHOOK_PASSWORD=
SIGNOZ_WEBHOOK_USER=
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
