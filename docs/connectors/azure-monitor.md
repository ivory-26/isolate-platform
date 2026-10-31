# Azure Monitor connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** (no module, verifier, reader or tool exists) |
| Free tier verified | 2026-10-31 (Azure Monitor pricing and service limits) |
| Auth | Microsoft Entra ID via managed identity or service principal; Logs query scope `https://api.loganalytics.io/.default` |
| Inbound | Action group webhook (unsigned) or Secure webhook (Entra token) → bridge → our HMAC webhook |
| Read | Logs query API (KQL), Azure Monitor Metrics API, Application Insights tables |
| Writes | None in scope (no alert-rule, action-group, workspace or monitor mutation) |

This page follows [`_template.md`](_template.md) and [`README.md`](README.md). Everything below is design; no Azure code exists in this repository.

## 1. Role in the agent

Azure Monitor is the alerting and telemetry plane for Azure resources. The connector turns one fired alert into one task and then answers "what fired, against which resource, with what metric or KQL result, and when did it start". The trigger is the primary value. The reader supplies a bounded metric window and an aggregated KQL result; it does not page through logs.

It must not be used to run arbitrary KQL from model output, to read audit or sign-in logs, to change an alert rule, or to invoke an action group. Every query is a server-side template selected by alert type; the model supplies no workspace ID, resource ID or query text.

## 2. Free tier and quotas

| Item | Value | Notes |
|---|---|---|
| Analytics Logs ingestion | First **5 GB/month per billing account** free | Pricing page states the grant "in this tier"; whether Basic/Auxiliary tables share it is **UNVERIFIED** [S1] |
| Included retention | **31 days** of analytics retention at no extra charge | Basic and Auxiliary use the same per-GB long-term rate [S3] |
| Maximum interactive retention | 730 days; archive up to 12 years | Additional retention charges apply beyond 31 days [S2] |
| Standard metrics | Free | Platform metrics are not charged like ingested logs [S1] |
| Query API rate | 200 requests per 30 s per Entra user or client IP | Per-user throttle [S2] |
| Query concurrency | 5 Analytics queries per user; 2 Basic/Auxiliary queries | Queue wait over 3 min or 200 queued returns `429` [S2] |
| Query size | 500,000 rows; ~100 MiB raw (~64 MiB compressed) | Per query [S2] |
| Query runtime | 10 minutes maximum | [S2] |
| Action-group webhooks | 1,500 calls/min/subscription; 10 webhook actions per group; 5 action groups per alert rule | Rate limit is per region [S2] |
| Alert notifications | 100 per alert rule per 5 minutes per region | [S2] |
| Common alert schema | 256 KB per alert | Search results are dropped above the cap and `IncludedSearchResults` is false [S5] |
| Free-account credit | Time-limited trial credit; amount and term not re-verified here — **UNVERIFIED** | The 5 GB/month grant is the recurring allowance |

There is no per-query charge for Analytics tables inside their retention window. Basic and Auxiliary tables are billed per GB scanned, so the connector must not select those plans for the allowlisted tables. Do not rely on a free trial to keep a workspace free; the recurring grant is the 5 GB/month.

## 3. Auth and least privilege

Prefer a managed identity (system-assigned on the worker host, or workload identity federation) over a client secret. The identity needs:

| Scope | Role | Why |
|---|---|---|
| Log Analytics workspace | **Log Analytics Reader** | Run KQL through the query API and read workspace metadata [S7] |
| Subscription or resource group | **Monitoring Reader** | Read metrics and alert state; no action-group execution [S8] |
| Application Insights component | **Monitoring Reader** (workspace-based component) | Query through the workspace; no separate component key |

Token audiences:

- Logs query API: `scope=https://api.loganalytics.io/.default` (v2 client-credentials form). The resource form is `https://api.loganalytics.io` [S7].
- Azure Resource Manager (metrics and alert re-fetch): `scope=https://management.azure.com/.default` [S8].

The Logs endpoint is moving from `api.loganalytics.io` to `api.loganalytics.azure.com`; both are supported today. Pin one in code and record it [S7].

Rotation: with a managed identity there is no secret. With a service principal, use a federated credential where possible; otherwise store one client secret server-side, rotate it on a 90-day schedule, and delete the old secret after the deploy is verified. Never put a tenant ID, client secret or bearer token in a prompt, tool result, URL or audit detail.

## 4. Inbound trigger

Azure Monitor action groups can call a plain **Webhook** or a **Secure webhook**. Neither applies an HMAC to the body.

| Property | Value |
|---|---|
| Webhook auth | Basic authentication can only be embedded in the URI; certificates cannot be passed [S4] |
| Secure webhook auth | Microsoft Entra ID service principal (`AzNS AAD Webhook`); basic auth is not supported [S4] |
| Body signature | **None.** The payload is not signed by Azure Monitor; trust comes from the Entra token (secure webhook) or the URI secret (webhook) [S4] |
| Payload | Common alert schema: `schemaId`, `data.essentials` (`alertId`, `alertRule`, `alertRuleId`, `severity` Sev0-Sev4, `signalType`, `monitorCondition`, `firedDateTime`, `alertTargetIDs`), `data.alertContext`, `data.customProperties` [S5] |
| Size | 256 KB maximum for the common schema [S5] |
| Retries | Up to 5 retries after the first call at 5, 20, 5, 40 and 5 seconds; then no calls to that endpoint for 15 minutes. Retryable: 408, 429, 503, 504, transport errors [S4] |
| Bridge requirement | Validate the Entra token (issuer, audience, app role) or a 32+ character path secret; then **re-fetch the alert** before task creation; then sign the normalized signal with our generic HMAC |
| Receiver | `POST /api/webhooks/azure-monitor` with `X-Isolate-Timestamp` and `X-Isolate-Signature` over `${timestamp}.${body}` |
| Body cap | 64 KiB at the bridge and receiver; reject larger before JSON parsing |
| Trigger filter | Only `monitorCondition: "Fired"` creates a task. `Resolved` is ignored because the platform has no incident-lifecycle update path |
| Severity map | Sev0/Sev1 → `critical`; Sev2 → `high`; Sev3/Sev4 → `medium`/`info`, which must be dropped before submission |
| Dedupe | Fingerprint `azure:<alertRuleId>:<sorted alertTargetIDs hash>`, 30-minute bucket; `alertId`/`originAlertId` is traceability only |

The bridge must not auto-trust the payload. Because it is unsigned, a valid Entra token plus an alert re-fetch is the minimum. The re-fetch path (`GET https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.AlertsManagement/alerts/{alertId}?api-version=2019-05-05-preview`) was not confirmed in this pass — **UNVERIFIED**; confirm the current Alerts API version before coding. If the re-fetch disagrees with the payload, the re-fetch wins.

## 5. Read-only context

| Need | Endpoint | Parameters and bounds | Source |
|---|---|---|---|
| Alert state | Alerts API re-fetch | Fixed alert ID; allowlisted fields only; one call | **UNVERIFIED** path |
| Log summary | `POST https://api.loganalytics.azure.com/v1/workspaces/{workspaceId}/query` | Body `{ "query": "<template>", "timespan": "PT1H" }`; no `api-version` query parameter; 1-3 templates; 50 rows each | [S6] |
| Metric shape | `GET https://management.azure.com/{resourceId}/providers/Microsoft.Insights/metrics` | `metricnames`, `timespan`, `interval=PT1M`, `aggregation`, `top=10`, `api-version=2019-07-01`; one page | [S8] |
| Application Insights | Same workspace query API | Query the component's workspace tables; exact table names depend on workspace-based vs classic — **UNVERIFIED** for a given workspace | [S6] |

Fixed KQL templates (not model-authored), for example:

```kusto
// error shape only; no message body
AppExceptions
| where TimeGenerated between (ago(60m) .. now())
| summarize count() by bin(TimeGenerated, 5m), ProblemId
| order by TimeGenerated desc
| take 50
```

Caps: at most 5 provider calls per bundle (3 KQL, 2 metric); 100 items (shared contract); 50 rows per query; 10 metric series; 60 points per series; 4,000 characters per context item; 256 KiB total. KQL must project a small set of scalar columns, never `*`. Do not query `SigninLogs`, `AuditLogs`, `AzureActivity` or `CommonSecurityLog`; those are outside the connector's purpose and are PII-heavy.

## 6. Framework fit

| Item | Design |
|---|---|
| Module | `packages/integrations/src/azure-monitor/` (design only) |
| Source enum | Add `azure_monitor` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a **contract commit before any adapter** |
| Transport | `verifyAzureActionGroup` (Entra token or path secret) and `normalizeAzureAlert` in the operator bridge; `signGenericDelivery` for our HMAC |
| Reader | `fetchAzureMonitorIncidentContext(deps, input)` with injected token provider, fetch and clock |
| Tools | `azure.query_logs` (`read_only`), `azure.get_metrics` (`read_only`), `azure.get_alert` (`read_only`) |
| Risk bands | All `read_only`; no write tool and no action-group invocation |
| Env | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` or `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_SUBSCRIPTION_ID`, `AZURE_LOG_ANALYTICS_WORKSPACE_ID`, `AZURE_APP_INSIGHTS_APP_ID`, `AZURE_ALERT_RULE_ALLOWLIST`, `WEBHOOK_SIGNING_SECRET` |
| Audit | One row per read tool with org, task, workspace/resource, item count, duration and outcome; never the KQL text, token or full alert payload |

Sandbox implications: tools run in the worker, not in the sandbox; the sandbox has egress deny and no Azure credential. The model selects a logical query template name, never a workspace ID, resource ID or KQL string. Results are redacted and truncated before the prompt. Query text, tenant IDs and resource IDs are not echoed to the model.

Tests (fakes only): unsigned webhook without a valid Entra token is rejected; token audience/issuer/role mismatch is rejected; `Resolved` creates nothing; the re-fetch wins over payload drift; 200/30 s throttle and 10-minute timeout map to a partial bundle; 256 KB alert schema is enforced; 3-query and 50-row caps hold; cross-org workspace returns `NOT_FOUND`.

## 7. Operator setup checklist

1. Decide subscription, workspace and Application Insights component; enable the common alert schema on the action group (`useCommonAlertSchema: true`).
2. Register the bridge as a protected API in Entra ID and add the `AzNS AAD Webhook` service principal to the `ActionGroupsSecureWebhook` app role. Use Secure webhook if the bridge can validate tokens; otherwise use Webhook with a 32+ character path secret over HTTPS.
3. Grant the worker identity Log Analytics Reader on the workspace and Monitoring Reader on the subscription or resource group.
4. Create at most five production alert rules; attach one action group; keep Sev3/Sev4 out of the task path.
5. Set the workspace retention explicitly (31 days included; lower is cheaper). Do not put allowlisted tables on Basic/Auxiliary plans.
6. Confirm offline gates with no Azure credential, then send one test notification and verify one task, one dedupe no-op, and no payload echo.
7. Add the credential last. This page does not authorize a live call.

```dotenv
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_FEDERATED_TOKEN_FILE=
AZURE_SUBSCRIPTION_ID=
AZURE_LOG_ANALYTICS_WORKSPACE_ID=
AZURE_APP_INSIGHTS_APP_ID=
AZURE_ALERT_RULE_ALLOWLIST=
WEBHOOK_SIGNING_SECRET=
```

Names only; values are server-side and never committed, logged or placed in a fixture.

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] Bridge verifier: missing/invalid Entra token rejected; wrong audience, issuer or app role rejected; path-secret mode requires 32+ characters.
- [ ] Normalizer: only `Fired`; Sev0/Sev1 → critical, Sev2 → high, Sev3/Sev4 dropped; fingerprint stable across re-delivery.
- [ ] Reader fakes: 5-call, 3-query, 50-row, 10-series and 256 KiB caps; `429`, 10-minute timeout and 64 MiB response truncate rather than throw.
- [ ] Redaction seeds for bearer tokens, emails, IPv4, connection strings and `password=`; query text never appears in an error.
- [ ] Intake: replay in the 30-minute window creates nothing; third active incident is throttled; foreign workspace is `NOT_FOUND`.
- [ ] `bun run validate` twice with providers disabled.

Live (separate explicit authorization; one bounded read, no retries):

- [ ] One KQL query on one allowlisted workspace, 5-minute window, `take 10`, aggregate columns only; confirm the free grant covers it and record measured GB scanned if the workspace is on Basic/Auxiliary.
- [ ] One metrics call for one resource, one metric, 10 points; record the request count.
- [ ] Stop at the first cap; no retry after success.

## 9. Risks and what must never enter model context

- The common alert schema embeds resource IDs, subscription IDs and sometimes full search results. Only essentials plus a normalized resource name may be kept; `alertContext` free text is untrusted.
- The webhook is unsigned. Without an Entra token check or a high-entropy path secret, anyone can forge an alert; re-fetch is mandatory before task creation.
- KQL can read every table in the workspace. Templates, not model text, choose the table; never expose a generic query tool.
- The 5 GB/month grant is per billing account, not per workspace; several workspaces share it.
- Never in context: client secret, bearer token, refresh token, tenant ID beyond the allowlist, full alert JSON, search results, `SigninLogs`, `AuditLogs`, VM names or customer identifiers not needed to locate the code.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Azure Monitor pricing](https://azure.microsoft.com/en-us/pricing/details/monitor/) |
| S2 | [Azure Monitor service limits](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/service-limits) |
| S3 | [Azure Monitor Logs cost calculations](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/cost-logs) |
| S4 | [Create and manage action groups](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups) |
| S5 | [Common alert schema](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-common-schema) |
| S6 | [Azure Monitor Logs Query API overview](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/overview) |
| S7 | [Log Analytics API access and authentication](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/access-api) |
| S8 | [Azure Monitor REST API walkthrough](https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/rest-api-walkthrough) |
