# Connector setup - the ten implemented connectors

| Field | Value |
|---|---|
| Audience | Operators connecting their own free or self-hosted accounts |
| Scope | Exactly ten connectors: GitHub, Sentry, Grafana, PagerDuty, Kubernetes, Datadog, New Relic, Honeycomb, Axiom, SigNoz |
| Status | Living guide. Credential creation is usable now; daemon transport and tool bindings are still landing |
| Date | 2026-11-01 |
| Architecture | [`../connector-usage.md`](../connector-usage.md); [`../connector-onboarding.md`](../connector-onboarding.md) (design; adapt, do not edit) |
| Free-tier matrix | [`free-tier-catalog.md`](free-tier-catalog.md) |

**The one rule that matters:** provider read keys stay on the operator's device. The server stores a device registration, a sha256 device-token hash and connector metadata. It never stores a provider key, a ciphertext, a wrapped key or a decryption path. Do not paste a provider key into server `.env`, the database, a prompt, an issue or a log.

Inbound webhook signing secrets are a separate case: they are verifier secrets, not provider read keys, and the receiver needs them to authenticate a delivery. They belong in the deployment's inbound-verifier secret store, never in the device connector config and never in `connector_credentials`. Each section says which kind of secret it is.

## 1. Status

| Connector | Adapter module | Intake binding | Tool binding | Live-proven? | Key type needed | Free tier | Guide |
|---|---|---|---|---|---|---|---|
| GitHub | Yes (`packages/integrations/src/github/`) | Yes, GitHub mode | No (writes are functions, not tools) | Yes: context and two writes, 2026-10-31 | GitHub App id, installation id, PKCS#8 key (platform-owned) | GitHub Free; 5,000 installation-token requests/hour | [github.md](github.md) |
| Sentry | Yes (`sentry/`) | Yes, signed mode | No (device transport pending) | No | Organization auth token plus internal-integration Client Secret | Developer: 5,000 errors/month, 1 user, 30-day retention | [sentry.md](sentry.md) |
| Grafana | Yes (`grafana/`) | Yes, HMAC mode (unsigned opt-in) | No (device transport pending) | No | Service-account token, Viewer plus fixed read roles | Cloud Free: 10k series, 50 GB logs/traces, 3 users, 14 days; OSS self-host | [grafana.md](grafana.md) |
| PagerDuty | Yes (`pagerduty/`) | Yes, v3 signed mode | No (device transport pending) | No | Read-only account API key plus v3 webhook secret | Free: 5 users, 1 schedule, 1 escalation policy | [pagerduty.md](pagerduty.md) |
| Kubernetes | Yes (`kubernetes/`) | No (no native webhook; signed bridge) | No (device transport pending) | No | Namespaced ServiceAccount bound token plus CA | OSS; infrastructure cost only | [kubernetes.md](kubernetes.md) |
| Datadog | Yes (`datadog/`) | No (unsigned; signed bridge) | No (device transport pending) | No | API key plus scoped application key | Free: 5 hosts, 1-day metric retention; free logs not stated (UNVERIFIED) | [datadog.md](datadog.md) |
| New Relic | Yes (`newrelic/`) | No (unsigned; signed bridge) | No (device transport pending) | No | User API key plus account id | Free: 100 GB/month, 1 full user, at least 8-day retention | [newrelic.md](newrelic.md) |
| Honeycomb | Yes (`honeycomb/`) | No (unsigned; signed bridge) | No (device transport pending) | No | Environment configuration key plus dataset | Free: 20M events, 100M points, 2 triggers, no SLOs | [honeycomb.md](honeycomb.md) |
| Axiom | Yes (`axiom/`) | No (unsigned; signed bridge) | No (device transport pending) | No | Advanced API token plus dataset | Personal: 500 GB/month load, 25 GB storage, 30 days, 3 datasets, 1 user | [axiom.md](axiom.md) |
| SigNoz | Yes (`signoz/`) | No (Basic auth; signed bridge) | No (device transport pending) | No | API key from a Viewer service account | Community Edition self-host only; Cloud is trial-only | [signoz.md](signoz.md) |

Notes:

- **All ten adapter modules are merged and fake-tested.** Five were merged in wave 17 (Datadog, New Relic, Honeycomb, Axiom, SigNoz).
- Sentry, Grafana and PagerDuty now have signed intake modes. Datadog, New Relic, Honeycomb, Axiom, SigNoz and Kubernetes have no native verifier and require the signed generic bridge.
- Worker tool binding is merged: the 31 connector tools are registered only when `DEVICE_GATEWAY_ENABLED=true` and a daemon is polling; otherwise they stay denied. The daemon client itself is still landing.
- No SaaS vendor except GitHub has been exercised live. Every SaaS adapter is fake-tested.
- **Kubernetes has a local live proof:** `kind` cluster `isolate-demo`, namespaced read-only ServiceAccount, failing demo pod; `bun run acceptance:k8s-local` returned 2 bounded items (warning events + pod) and `truncated: true`. No kubeconfig or token enters the sandbox.

## 2. How credentials are held

### 2.1 What runs on the device

The chosen transport is a user-run device daemon, not a server-side credential store. The daemon is **not shipped on this branch**; the pieces below define what it must install and read when it lands.

- One small outbound-only daemon. It opens no inbound port and makes HTTPS requests to the platform and to the provider.
- `~/.isolate/connectors.toml` (proposed path) for non-secret selectors: server URL, `credential_ref` names, organization slug, region, dataset, namespace, API base URL.
- Provider secrets in the OS keychain, referenced by `credential_ref` (for example `keychain:isolate/sentry/prod`). The TOML file names the item; it does not contain the secret.
- For Kubernetes only, a CA file and a short-lived token file under `~/.isolate/`, readable only by the daemon user. The kubeconfig stays on the device and never enters the agent sandbox.

Proposed shape, names only, values omitted:

```toml
# ~/.isolate/connectors.toml
[device]
server_url = "https://<isolate-host>"
token_ref = "keychain:isolate-device"

[connectors.sentry]
credential_ref = "keychain:isolate/sentry/prod"
org_slug = "<org-slug>"
region = "us"

[connectors.kubernetes]
credential_ref = "file:~/.isolate/k8s-token"
api_url = "https://127.0.0.1:<port>"
namespace = "isolate-demo"
ca_file = "~/.isolate/k8s-ca.pem"
```

### 2.2 Device token creation and registration

1. The daemon generates 256 random bits and encodes them as 43 base64url characters. This is the device token.
2. The daemon sends only the sha256 hex digest to the platform during registration. The server row starts as `pending`.
3. An owner or admin activates the device. The row becomes `active`; revocation flips it to `revoked`.
4. Every poll presents the token as a bearer credential over TLS. The server hashes the presented value and compares it in constant time against `connector_devices.token_hash`.
5. `last_seen_at` is updated on a successful poll. A revoked or pending device is rejected without revealing which condition failed.
6. There is no rotate-in-place operation. Rotation means register a new device, verify it, then revoke the old one.

The token is never logged, echoed, placed in a URL or stored server-side. The registration endpoint and daemon CLI are pending; do not expect a working poll loop today.

### 2.3 What the server stores

| Table | Stored | Not stored |
|---|---|---|
| `connector_devices` | Organization, optional user, display name, `token_hash`, status, `last_seen_at` | The device token, any provider secret |
| `connector_credentials` | Device id, connector id, display name, `auth_kind`, opaque `credential_ref`, scopes, status, free-tier profile, metadata | Any provider key, ciphertext, nonce, tag, wrapped DEK |
| `connector_usage_ledger` | Per-credential period, request and error counts | Provider response bodies or secrets |

The database cannot decrypt a provider credential because it never receives one. `credential_ref` names a device keychain item; it is not a secret. See `packages/db/migrations/0010_connectors.sql`.

### 2.4 How a call flows

```text
agent turn -> tool call -> policy band -> connector device broker
  -> resolve active device + active credential metadata (no secret)
  -> typed request { connectorId, credentialRef, operation, params <= 16 KiB, timeoutMs }
  -> device daemon polls over TLS, authenticates with its bearer token
  -> daemon reads its own keychain item named by credentialRef
  -> daemon calls the provider with the fixed operation
  -> bounded JSON result <= 16 KiB, or a fixed error code
  -> worker validates, redacts, truncates, hashes, audits and charges the ledger
```

The worker never receives the provider response body directly, and the device never receives the provider secret back from the server. Error text crossing the boundary is a closed set: `INTEGRATION_UNAVAILABLE`, `RATE_LIMITED`, `POLICY_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND`, `INTERNAL`.

### 2.5 Single-worker and durability caveat

There is no durable connector call-queue table. Until one exists, a poll transport would need an in-process dispatch inside a **single worker process**. A worker restart loses an undelivered request; a second worker cannot see it. Do not describe the poll path as production-ready, and do not scale the worker horizontally for connector calls until a queue migration lands.

When a device is offline, its request expires and the call fails as `INTEGRATION_UNAVAILABLE`. The task continues with partial evidence. There is no fallback to a server key, a shared demo key or another tenant's device.

## 3. GitHub

GitHub is already configured and is the deliberate exception to the device model. The App identifies the platform's own GitHub App, not a user's vendor account.

**What you need:** `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, a PKCS#8 private key at `GITHUB_APP_PRIVATE_KEY_PATH`, and `WEBHOOK_GITHUB_SECRET` for intake.

**Where it lives:** the App key is a server-side file path, never in the repository, prompt or device config. The webhook secret is an inbound verifier secret. No user provider key is involved.

**Comment permission:** `github.comment` requests both `issues:write` and `pull_requests:write`. The first live attempt returned 403 "Resource not accessible by integration" until `pull_requests:write` was added. The live-proven call posted comment `6547408811` on PR #2 on 2026-10-31.

**No changes needed:** keep the App installed on the target repositories, keep the key path server-side, and do not add GitHub to the device connector config. The two write functions are still not registered as agent tools.

**Verify:** existing intake and context paths are already proven. Do not re-run live writes for setup.

Sources (accessed 2026-11-01): [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## 4. Sentry

**What you need:** organization slug, region (US or EU), one organization auth token, one internal integration for the issue webhook, and its Client Secret. Free Developer plan is sufficient.

**Create the read token:** `Settings > Developer Settings > Organization Tokens > Create New Token`. Select only `event:read`, `project:read`, `org:read` and `project:releases`. Omit `member:read`; it exposes personal data. Organization tokens cannot be edited after creation, so a scope change is a new token.

**Create the webhook:** `Settings > Developer Settings > Create New Integration > Internal Integration`. Set the webhook URL to `https://<host>/api/webhooks/sentry`, subscribe to `issue` only, and grant the same four read permissions. The Client Secret is shown on the integration's detail page; the exact field label is **UNVERIFIED** in current docs, so copy it once and store it in your password manager.

**Signature:** `Sentry-Hook-Signature` is an HMAC-SHA256 hex digest over the exact raw request body, keyed by the Client Secret. `Sentry-Hook-Timestamp` is sent but is **not** covered by the signature; the receiver must enforce its own ±300 s window and 30-minute fingerprint dedupe.

**Where each secret goes:**

- Provider token: device keychain item named by `[connectors.sentry] credential_ref`. Never server `.env`, never the database.
- Client Secret: inbound-verifier configuration on the receiver (`SENTRY_WEBHOOK_SECRET` when a Sentry intake mode ships). It is not a provider key and does not belong in the device config.
- Today there is no Sentry intake mode. Keep production Sentry webhooks disabled until the route ships; a direct delivery falls through to the generic verifier and is rejected.

**Device config:** `[connectors.sentry] credential_ref`, `org_slug`, `region`.

**Verify (pending tool binding):** one `sentry.fetch_issue_context` against a named issue should make at most four calls, return a bounded issue/event/release/deploy bundle, write one `tool.execute` audit row, and leave no token in logs.

**Free tier:** Developer is $0 forever: 5,000 errors/month, 1 user, 30-day retention, plus limited logs, metrics, spans and replays. Do not promise evidence older than 30 days; overage behavior and numeric rate limits are **UNVERIFIED**.

**Do not grant:** `event:write`, `project:write`, `project:admin`, `org:admin`, `member:admin`, or a DSN. Do not fetch full event JSON, attachments, breadcrumbs, request data or spans.

Sources (accessed 2026-11-01): [Sentry pricing](https://sentry.io/pricing/), [internal integrations](https://docs.sentry.io/integrations/integration-platform/internal-integration/), [auth tokens](https://docs.sentry.io/account/auth-tokens/), [API permissions](https://docs.sentry.io/api/permissions/), [webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/).

## 5. Grafana

**What you need:** stack URL, one service-account token, the metric and log data-source UIDs, and an alerting webhook contact point with a random secret and timestamp header.

**Create the identity:** `Administration > Users and access > Service accounts > Add service account`, choose the Viewer basic role, then `Add service account token` with a 90-day expiry. Assign the fixed roles `fixed:datasources:reader` (carries `datasources:query`), `fixed:alerting.rules:reader` and `fixed:annotations:reader`.

**Restrict data sources:** `Connections > Data sources > [data source] > Permissions > Add permission > Query` (the `datasources:query` action) for each in-scope UID. Data-source permissions are available in Grafana Cloud/Enterprise; availability in Grafana OSS is **UNVERIFIED**. If unavailable, Viewer can query every data source in the organization, so use a dedicated stack or organization for the connector.

**Create the contact point:** `Alerts & IRM > Alerting > Notification configuration > + Add contact point > Webhook`. Point it at `https://<host>/api/webhooks/grafana` after the route ships, or at your signed bridge today. Under `HMAC signature`, set the Secret and the Header (default `X-Grafana-Alerting-Signature`). Set a Timestamp Header; the signed string is `<timestamp>:<rawBody>`. Without a timestamp header there is no replay protection. Route only production rules at the agreed severity; resolved notifications must not create tasks.

**Where each secret goes:** token in the device keychain; HMAC secret in the receiver or bridge verifier (`GRAFANA_WEBHOOK_SECRET`), not in the device config.

**Device config:** `[connectors.grafana] credential_ref`, `base_url`, `org_id`, `datasource_uid_metrics`, `datasource_uid_logs`.

**Verify (pending tool binding):** one `grafana.get_alert_rule` or one bounded `grafana.query_metrics` call should return at most four calls, a bounded series (no more than five series and 20 points), one audit row, and no token or raw log line in the result.

**Free tier:** Cloud Free is $0: 10,000 active series, 50 GB logs, 50 GB traces, 3 users, 14-day retention. OSS self-host has no vendor quota. Do not backfill beyond 14 days; a flapping rule can exhaust 50 GB of logs. Numeric API rate limits are **UNVERIFIED**.

**Do not grant:** Admin or Editor, a personal user token, silence or annotation writes, dashboard JSON reads, or an unbounded query range.

Sources (accessed 2026-11-01): [Grafana pricing](https://grafana.com/pricing/), [service accounts](https://grafana.com/docs/grafana/latest/administration/service-accounts/), [webhook notifier](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/), [data-source management](https://grafana.com/docs/grafana/latest/administration/data-source-management/), [fixed roles](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/rbac-fixed-basic-role-definitions/).

## 6. PagerDuty

**What you need:** account subdomain, one read-only account API key, and a v3 webhook subscription with its signing secret. Free plan is sufficient for a one-service pilot.

**Create the key:** `Integrations > Developer Tools > API Access Keys > Create New API Key`, then check `Read-only API Key`. The header is `Authorization: Token token=<key>`. If you use a Private App instead, grant `incidents.read`, `services.read` and `escalation_policies.read`; add `schedules.read` only if schedule names are required. Omit `oncalls.read` by default because responder data is personal data. Never add `incidents.write` to this credential.

**Create the webhook:** `Integrations > Generic Webhooks (v3) > New Webhook`. Point it at `https://<host>/api/webhooks/pagerduty` after the route ships, subscribe to the incident events you need (`incident.triggered`, `resolved`, `acknowledged`), and copy the secret from the confirmation modal. It is shown once.

**Signature:** `X-PagerDuty-Signature: v1=<hex>` is HMAC-SHA256 over the raw body only. There is no signed timestamp; enforce a ±300 s freshness check on `event.occurred_at`. During rotation the header may contain several comma-separated `v1=` values; accept any active secret.

**Where each secret goes:** API key in the device keychain; webhook signing secret in the receiver verifier (`PAGERDUTY_WEBHOOK_SECRET`), not the device config.

**Device config:** `[connectors.pagerduty] credential_ref`, `subdomain`, `base_url`, `service_ids`.

**Verify (pending tool binding):** one `pagerduty.fetch_incident_context` should return at most four calls and 25 log entries, with responder names and free text redacted, one audit row, and no key in logs.

**Free tier:** $0: 5 users, 1 on-call schedule, 1 escalation policy, 100 SMS/phone notifications per month. The API is included and the limit is 960 requests/minute. Retention is not stated and is **UNVERIFIED**. Do not plan a multi-team rotation on Free.

**Do not grant:** a full-access key, a user key, `incidents.write`, `/alerts`, `/notes`, responder channels or schedule membership.

Sources (accessed 2026-11-01): [PagerDuty pricing](https://www.pagerduty.com/pricing/), [API access keys](https://docs.pagerduty.com/account-admin/api-access-keys), [webhooks](https://docs.pagerduty.com/integrations/webhooks), [free-plan limits](https://docs.pagerduty.com/account-admin/manage-users).

## 7. Kubernetes (local only for now)

Live cluster setup is documented; only local kind/k3d testing is run in this wave. The connector reads one namespace and never receives a kubeconfig in the agent sandbox.

**Create a local cluster:**

```bash
kind create cluster --name isolate-demo
# or
k3d cluster create isolate-demo
kubectl create namespace isolate-demo
```

**Create a namespaced identity:** save the following as `isolate-rbac.yaml` and apply it, replacing the namespace if you chose another one.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: isolate-connector
  namespace: isolate-demo
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: isolate-connector-read
  namespace: isolate-demo
rules:
  - apiGroups: [""]
    resources: ["pods", "events", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["events.k8s.io"]
    resources: ["events"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: isolate-connector-read
  namespace: isolate-demo
subjects:
  - kind: ServiceAccount
    name: isolate-connector
    namespace: isolate-demo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: isolate-connector-read
```

**Mint a bound token and record the API URL on the device:**

```bash
mkdir -p ~/.isolate
kubectl apply -f isolate-rbac.yaml
umask 077
kubectl create token isolate-connector -n isolate-demo --duration=24h > ~/.isolate/k8s-token
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > ~/.isolate/k8s-ca.pem
```

The API server may issue a token with a different lifetime than requested, so treat it as short-lived and re-mint before expiry. Do not put the kubeconfig, token or CA into a prompt, fixture or the sandbox.

**Verify RBAC:**

```bash
kubectl auth can-i list pods -n isolate-demo --as=system:serviceaccount:isolate-demo:isolate-connector
kubectl auth can-i delete pods -n isolate-demo --as=system:serviceaccount:isolate-demo:isolate-connector
```

The first must be `yes`; the second must be `no`.

**Device config:** `[connectors.kubernetes] credential_ref`, `api_url`, `namespace`, `ca_file`. For local testing, `credential_ref = "file:~/.isolate/k8s-token"` is the device-side entry that resolves to the token file; a keychain entry is preferred when the daemon supports it. The CA file is not a secret.

**Verify (pending tool binding):** one `kubernetes.get_events` for the demo namespace should return at most 50 Warning events and one `kubernetes.pod_logs` call at most 200 lines, with one audit row and no token in the result.

**Free tier:** Kubernetes is Apache-2.0 with no vendor quota; the cluster costs money. Events expire after about one hour by default. Do not treat an empty event list as "nothing happened".

**Do not grant:** `secrets`, `configmaps`, `pods/exec`, `pods/portforward`, `pods/attach`, `serviceaccounts/token`, any `create`/`update`/`patch`/`delete` verb, or cluster-scoped `nodes`. A ClusterRoleBinding silently widens the namespaced grant.

Sources (accessed 2026-11-01): [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [service accounts](https://kubernetes.io/docs/concepts/security/service-accounts/), [kubectl create token](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_token/), [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/), [k3d cluster create](https://k3d.io/v5.9.0/usage/commands/k3d_cluster_create/).

## 8. Datadog

**What you need:** account site, one API key, one scoped application key, and the monitor or incident id used for verification. Free is metrics-only in practice; log ingestion has no stated free allowance (**UNVERIFIED**).

**Create the keys:** `Organization Settings > API Keys > New Key` for the API key, then `Organization Settings > Application Keys > New Key` for the application key. Scope the application key to `metrics_read`, `logs_read_data` plus `logs_read_index_data`, `incident_read`, `monitors_read` and `events_read`. Add `dashboards_read` only if a dashboard definition is evidence.

**Create the webhook:** `Integrations > Webhooks > New Webhook`. Datadog documents no HMAC, so the delivery is a hint, not authenticated evidence. Point it at your signed bridge, not directly at the platform receiver, and add a custom header carrying a random bridge token. The bridge verifies that header, re-fetches the monitor or incident by id, normalizes it and re-signs with the generic webhook secret. Do not put the shared token in the URL or use URL-embedded Basic auth.

**Where each secret goes:** API key and application key in one device keychain item named by `credential_ref`; bridge token in the bridge's server-side secret store. Never send either key to the server or the model.

**Device config:** `[connectors.datadog] credential_ref`, `site`, `incident_id`, `monitor_id`.

**Verify (pending tool binding):** one `GET /api/v2/incidents/{id}` for a named test incident should return a bounded incident record, at most six calls for the full plan, one audit row, and no key in logs.

**Free tier:** $0, up to 5 hosts, 1-day metric retention, core collection and visualization. Custom-metric allowance, free log allowance and per-endpoint rate limits are **UNVERIFIED**. Do not enable the log aggregate unless the account proves logs are on the plan; mark the bundle truncated if logs are absent.

**Do not grant:** `metrics_write`, `logs_write`, `incident_write`, `monitors_write`, `org_app_keys_write`, or a personal full-access key. Do not fetch raw log messages, customer impact free text or monitor notification URLs.

Sources (accessed 2026-11-01): [Datadog pricing](https://www.datadoghq.com/pricing/), [API and application keys](https://docs.datadoghq.com/account_management/api-app-keys/), [RBAC permissions](https://docs.datadoghq.com/account_management/rbac/permissions/), [webhooks integration](https://docs.datadoghq.com/integrations/webhooks/).

## 9. New Relic

**What you need:** US or EU region, account id, and a user API key from a dedicated read-only full user. NerdGraph requires a user key, not an ingest license key.

**Create the key:** open the user menu (your name, top right) `> API keys > Create key > User`. New keys are prefixed `NRAK-`. Find the account id under `Account > Account settings`; it is displayed at the top of the page.

**Least privilege:** New Relic user keys do not expose per-query OAuth scopes. Create a dedicated full user with a read-only role and access only to the accounts and entities in scope. Do not use a personal admin key. Basic users cannot use NerdGraph.

**NerdGraph:** `POST https://api.newrelic.com/graphql` (US) or `POST https://api.eu.newrelic.com/graphql` (EU), with the header `API-Key: <user key>`. The region must match the account.

**Create the webhook:** in the current workflow UI, `Settings > Data & AI > Webhooks`, or in the alerting UI `Alerts > Notification Workflows > Add a workflow`. Create a webhook destination with a custom header carrying a random bridge token and a pinned payload template. No HMAC is documented. Point it at your signed bridge; the bridge re-fetches the issue or entity state before creating a task.

**Where each secret goes:** user key in the device keychain; bridge token in the bridge's server-side store. Do not use the license/ingest key for reads.

**Device config:** `[connectors.newrelic] credential_ref`, `account_id`, `region`, `entity_guid`.

**Verify (pending tool binding):** one `entitySearch` for a named entity, or one NRQL count over at most 15 minutes, should return at most four GraphQL operations, a bounded aggregate, one audit row, and no key in logs.

**Free tier:** $0: 100 GB/month ingest, 1 full platform user, unlimited basic users, default retention of at least 8 days. Paid retention tiers beyond that are **UNVERIFIED**. Do not assume telemetry older than the free window exists.

**Do not grant:** admin, ingest/license keys, write or acknowledge permissions, or access to accounts outside the pilot. Do not query raw log or transaction rows.

Sources (accessed 2026-11-01): [New Relic pricing](https://newrelic.com/pricing), [API keys](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/), [account id](https://docs.newrelic.com/docs/accounts/accounts-billing/account-structure/account-id/), [destinations](https://docs.newrelic.com/docs/alerts/get-notified/destinations/).

## 10. Honeycomb

**What you need:** environment and dataset, one environment-scoped configuration key with query permissions, and a webhook shared secret.

**Create the key:** `Environments > Manage Environments > [environment] > API Keys > Configuration > Create Configuration API Key`. Select only `Queries and columns` and `Run queries`; both are required for the Query Data API. Do not select management permissions for datasets, triggers, recipients, boards or SLOs. There is no generic "read-only" configuration key.

**Create the webhook:** `Team Settings > Integrations > Add Integration > Webhook`, set a Shared Secret, and point it at your signed bridge. Honeycomb sends the secret in `X-Honeycomb-Webhook-Token`; this authenticates the sender but does not sign the body. The bridge must verify the token, re-fetch trigger or SLO state, and re-sign to the generic endpoint. The payload field names and EU API host are **UNVERIFIED**; capture one test delivery and pin the schema.

**Where each secret goes:** configuration key in the device keychain; webhook shared secret in the bridge's server-side store.

**Device config:** `[connectors.honeycomb] credential_ref`, `api_host`, `dataset`, `trigger_id`.

**Verify (pending tool binding):** one query-result round trip for the named dataset over at most 15 minutes should return no more than 100 rows and 1,500 characters, at most four calls, one audit row, and no key or raw event map in the result.

**Free tier:** $0: 20M events and 100M metrics data points per month, 2 triggers, no SLOs, 60-day event retention and 13-month metrics retention. Query duration is at most 7 days and 10 requests/minute. Do not fetch raw events or explore arbitrary high-cardinality fields.

**Do not grant:** a management key, an ingest key, trigger or recipient edits, or broad dataset management. Do not fetch trigger definitions (they may embed recipients and secrets).

Sources (accessed 2026-11-01): [Honeycomb pricing](https://www.honeycomb.io/pricing), [environment API keys](https://docs.honeycomb.io/configure/environments/manage-api-keys), [API authentication](https://docs.honeycomb.io/api/authentication), [webhooks](https://docs.honeycomb.io/notify/webhooks), [permissions](https://docs.honeycomb.io/api/permissions).

## 11. Axiom

**What you need:** API URL, dataset, one advanced API token restricted to querying that dataset, and a webhook header secret.

**Create the token:** `Settings > API tokens > New API token`, name it, choose `Advanced`, then `Custom`. Allow query/read on the in-scope dataset only; the exact permission strings are **UNVERIFIED** in current docs, so verify after creation that the token cannot ingest or manage. Do not use a basic ingest token or an organization-wide admin token.

**Create the webhook:** `Monitors > Manage notifiers > New notifier > Custom webhook`. Point it at your signed bridge, add custom headers carrying a random bridge token, and pin the Go body template so the JSON shape is stable. Axiom documents no HMAC; the header is a shared secret, not a signature. The bridge verifies it, re-fetches monitor state, and re-signs.

**Where each secret goes:** API token in the device keychain; bridge token in the bridge's server-side store.

**Device config:** `[connectors.axiom] credential_ref`, `api_url`, `dataset`, `monitor_id`.

**Verify (pending tool binding):** one bounded APL aggregate for the named dataset over at most 15 minutes should return at most 100 rows, at most three calls, one audit row, and no token or raw log line in the result.

**Free tier:** Personal is $0: 500 GB/month data loading, 25 GB storage, 30-day retention, 3 datasets, 1 user, and 10 GB-hours query compute. Heavy APL scans exhaust the query budget; bound the window and avoid `project *`.

**Do not grant:** organization admin, ingest token, monitor or notifier edits, or access to datasets outside the allowlist.

Sources (accessed 2026-11-01): [Axiom limits](https://axiom.co/docs/reference/limits), [API tokens](https://axiom.co/docs/reference/tokens), [custom webhook notifier](https://axiom.co/docs/monitor-data/custom-webhook-notifier), [query API](https://axiom.co/docs/restapi/query).

## 12. SigNoz

**What you need:** a self-hosted Community Edition URL, one Viewer service-account API key, and a webhook notification channel with Basic auth. Do not use SigNoz Cloud: it has no free tier, only a 30-day trial and then $49/month.

**Install Community Edition:** follow the official self-host guide at `https://signoz.io/docs/install/self-host/` and choose Docker or Kubernetes. Set an explicit ClickHouse TTL before onboarding; defaults vary by install and are **UNVERIFIED**. Enable authentication and require the API key, or restrict the query API to the worker network.

**Create the key:** `Settings > Service Accounts > New Service Account`, assign the Viewer role, then open the `Keys` tab and generate a key. Send it as `SIGNOZ-API-KEY: <key>`. Exact role strings and per-endpoint scopes are **UNVERIFIED**; verify that the key cannot edit alert rules or notification channels.

**Create the webhook:** `Settings > Account Settings > Notification Channels > New Channel > Webhook`. Add Basic auth credentials and point it at your signed bridge. SigNoz documents no HMAC; Basic auth authenticates the sender but does not sign the body. The bridge verifies the credential, re-fetches the alert/rule state, and re-signs.

**Where each secret goes:** API key in the device keychain; webhook Basic password in the bridge's server-side store.

**Device config:** `[connectors.signoz] credential_ref`, `api_url`, `service_name`.

**Verify (pending tool binding):** one `POST /api/v5/query_range` metric query over at most 15 minutes should return no more than 20 points or rows, at most three calls, one audit row, and no log body or API key in the result.

**Free tier:** Community Edition is free and self-hosted with no data caps; infrastructure is the cost. Cloud is trial-only and must not be recommended as a free path.

**Do not grant:** an editor or admin key, channel or alert-rule edits, raw trace payloads, span attribute dumps, ClickHouse credentials, or an unauthenticated query API.

Sources (accessed 2026-11-01): [SigNoz pricing](https://signoz.io/pricing/), [self-host install](https://signoz.io/docs/install/self-host/), [service accounts](https://signoz.io/docs/manage/administrator-guide/iam/service-accounts/), [webhook channel](https://signoz.io/docs/alerts-management/notification-channel/webhook/), [query range API](https://signoz.io/docs/metrics-management/query-range-api/).

## 13. Testing handoff

No vendor except GitHub has a live acceptance run. The following names are the intended inline-only interface for a bounded local run; the `acceptance:connector` script does not exist yet, so treat every row as **pending** until its bind is merged.

Rules for every run:

- Values are read from the process environment for that one process. Never write them to `.env`, a config file, a fixture, a log or shell history with the value visible. Use a keychain lookup in the command substitution.
- One provider read per connector, no loops, no retries after success, no parallel calls.
- Stop at the first cap. Free-tier calls only; no paid plan is required.
- Expected evidence: one bounded provider result, one `tool.execute` audit row, and no key in logs or the result. Record the measured item count and bytes, not an estimate.

| Connector | Inline environment names (names only) | Bounded operation | Status |
|---|---|---|---|
| GitHub | none; already server-configured | existing intake/context only | Proven; do not re-run |
| Sentry | `SENTRY_LIVE_TOKEN`, `SENTRY_LIVE_ORG`, `SENTRY_LIVE_ISSUE_ID`, `SENTRY_LIVE_REGION` | one `issue_context` read | Pending bind |
| Grafana | `GRAFANA_LIVE_TOKEN`, `GRAFANA_LIVE_BASE_URL`, `GRAFANA_LIVE_RULE_UID`, `GRAFANA_LIVE_DATASOURCE_UID` | one rule read or one metric query | Pending bind |
| PagerDuty | `PAGERDUTY_LIVE_KEY`, `PAGERDUTY_LIVE_INCIDENT_ID` | one incident context read | Pending bind |
| Kubernetes | `KUBERNETES_LIVE_TOKEN_FILE`, `KUBERNETES_LIVE_API_URL`, `KUBERNETES_LIVE_NAMESPACE`, `KUBERNETES_LIVE_CA_FILE` | one events list plus one `tailLines=20` log read | Pending bind |
| Datadog | `DATADOG_LIVE_API_KEY`, `DATADOG_LIVE_APP_KEY`, `DATADOG_LIVE_SITE`, `DATADOG_LIVE_INCIDENT_ID` | one incident read | Pending bind |
| New Relic | `NEW_RELIC_LIVE_USER_KEY`, `NEW_RELIC_LIVE_ACCOUNT_ID`, `NEW_RELIC_LIVE_ENTITY_GUID` | one entity search or one short NRQL count | Pending bind |
| Honeycomb | `HONEYCOMB_LIVE_API_KEY`, `HONEYCOMB_LIVE_API_HOST`, `HONEYCOMB_LIVE_DATASET`, `HONEYCOMB_LIVE_QUERY_ID` | one query-result round trip | Pending bind |
| Axiom | `AXIOM_LIVE_TOKEN`, `AXIOM_LIVE_API_URL`, `AXIOM_LIVE_DATASET`, `AXIOM_LIVE_MONITOR_ID` | one APL aggregate | Pending bind |
| SigNoz | `SIGNOZ_LIVE_API_KEY`, `SIGNOZ_LIVE_API_URL`, `SIGNOZ_LIVE_SERVICE` | one `query_range` metric query | Pending bind |

Target command shape (not yet runnable):

```bash
CONNECTOR_LIVE=1 \
SENTRY_LIVE_TOKEN="$(security find-generic-password -w -s isolate-sentry)" \
SENTRY_LIVE_ORG="<org-slug>" \
SENTRY_LIVE_ISSUE_ID="<issue-id>" \
bun run acceptance:connector -- --connector sentry --operation issue_context --once
```

On Linux, replace the keychain read with `secret-tool lookup service isolate-sentry`. Never echo the value to the terminal.

## 14. Documented-only catalog

**Cap: exactly ten connectors are in scope for setup. Do not add a setup page for any connector below.** They remain documentation-only until a later scope decision, even when a page describes a plausible free path.

- **Incidents and notification:** [Rollbar](rollbar.md), [Better Stack](betterstack.md), [incident.io](incident-io.md), [Rootly](rootly.md), [Slack](slack.md) - documented, not implemented.
- **Metrics, APM, logs and traces:** [Prometheus](prometheus.md), [Loki and Tempo](loki-tempo.md), [Elastic](elastic.md), [Splunk](splunk.md) - documented, not implemented.
- **Cloud monitoring and uptime:** [CloudWatch](cloudwatch.md), [Azure Monitor](azure-monitor.md), [Google Cloud Monitoring](gcp-monitoring.md), [UptimeRobot](uptimerobot.md), [Uptime Kuma](uptime-kuma.md) - documented, not implemented.
- **Deploy and runtime:** [Argo CD](argocd.md) - documented, not implemented.
- **Security and supply chain:** [GitHub security alerts](github-security.md), [Snyk](snyk.md), [Semgrep](semgrep.md), [Socket](socket.md), [GitGuardian](gitguardian.md), [Trivy](trivy.md), [OSV-Scanner](osv-scanner.md), [Dependency-Track](dependency-track.md), [DefectDojo](defectdojo.md), [Wazuh](wazuh.md), [Falco](falco.md), [CrowdSec](crowdsec.md), [ZAP](zap.md), [Scorecard](scorecard.md) - documented, not implemented.
- **Streaming:** [Kafka](kafka.md), [Confluent](confluent.md), [Redpanda](redpanda.md), [Aiven Kafka](aiven-kafka.md), [Upstash Kafka](upstash-kafka.md) - documented, not implemented.
- **Transport (implemented, outside the ten):** [Generic signed webhook](generic-webhook.md) - implemented transport, not a vendor connector.

The verified free/paid matrix for every page is in [free-tier-catalog.md](free-tier-catalog.md). A row there does not create a setup obligation.

## 15. Key hygiene

- **Never commit a key.** No provider token, device token, webhook secret, CA private key or kubeconfig in the repository, fixtures, screenshots, issues or prompts.
- **Device-only provider storage.** Use the OS keychain; the TOML file holds selectors and keychain item names, not secrets. The server stores only `token_hash` and metadata.
- **Rotation.** Create the replacement provider key, update the device keychain item, verify one bounded read, then revoke the old key. For the device token, register a new device, verify it, then revoke the old device; there is no in-place token rotation.
- **Revocation.** Revoking a device blocks new polls immediately. An in-flight call is not recalled. Revoke the provider key at the vendor as well when a device is lost.
- **Offline device.** Requests expire and fail as `INTEGRATION_UNAVAILABLE`; the task continues with partial evidence. There is no server-key fallback, no shared demo key and no second tenant's device.
- **Compromise.** Revoke the device and the credential row, revoke the provider key, rotate the webhook verifier secret, and inspect audit rows for the affected connector. Do not attempt to "test" the old key to see whether it still works.
- **Logs and errors.** Provider response text never crosses the device boundary. Worker logs carry fixed error codes, connector id and bounded metadata only. A secret in a log is a defect, not an accepted risk.
