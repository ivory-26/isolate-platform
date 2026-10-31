# AWS CloudWatch connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** (no module, verifier, reader or tool exists) |
| Free tier verified | 2026-10-31 (AWS Free Tier docs and CloudWatch pricing) |
| Auth | IAM role assumed by the worker (preferred) or a scoped IAM user key; SigV4 |
| Inbound | CloudWatch alarm → SNS topic → HTTPS subscription → signature-verifying bridge → our HMAC webhook |
| Read | `GetMetricData`, `DescribeAlarms`, Logs Insights `StartQuery` / `GetQueryResults` |
| Writes | None in scope (no alarm, dashboard, topic or log-group mutation) |

This page follows [`_template.md`](_template.md) and the shared rules in [`README.md`](README.md). Nothing here is implemented. The AWS facts are vendor documentation, not code evidence.

## 1. Role in the agent

CloudWatch is the metrics and log store for AWS workloads. The connector answers "which alarm fired, on which resource, with what metric shape, and what bounded log summary explains it" after a task already exists. The trigger is the primary value: an alarm state change is a concrete operational event. The reader adds metric points and an aggregated Logs Insights result so the agent can see since when and how bad, not raw log lines.

It must not be used to fetch arbitrary log bodies, to enumerate an account, to change alarm state, or as a generic AWS API proxy. Every query is a fixed template in trusted code; the model never authors a query or supplies an ARN.

## 2. Free tier and quotas

AWS now has two account plans: new accounts get USD 100 in credits (up to USD 100 more for activities), and the **Free account plan** lasts six months or until credits are exhausted, whichever comes first. Paid-plan accounts can also receive short-term trials. **Always Free** monthly allowances apply independently of credits [S1]. CloudWatch's allowances below are monthly allowances, not a 12-month trial [S2].

| Item | Allowance / limit | Notes |
|---|---|---|
| Custom and detailed metrics | 10 metrics/month | Always Free allowance [S2] |
| API requests | 1,000,000/month | Explicitly **excludes** `GetMetricData`, `GetInsightRuleReport`, `GetMetricWidgetImage` [S2] |
| Logs | 5 GB/month combined ingestion, archive storage and Logs Insights data scanned | One shared 5 GB pool [S2] |
| Dashboards | 3 custom dashboards, up to 50 metrics each | [S2] |
| Alarms | 10 alarm metrics, standard resolution only | [S2] |
| Live Tail | 1,800 minutes/month | Not used by this connector [S2] |
| `GetMetricData` | **Not free**; billed per metrics requested | The reader's main call consumes paid API units even on a free account |
| Log retention | Never expires by default; 1 to 3,653 days (10 years) if set | Valid values are 1,3,5,7,14,30,60,90,120,150,180,365,400,545,731,1096,1827,2192,2557,2922,3288,3653 [S5] |
| Metric retention | 3 h (sub-minute), 15 d (1 min), 63 d (5 min), 455 d (1 h) | Older points are aggregated, not extended [S3] |
| `GetMetricData` size | 500 metrics and 100,800 data points per call | `MaxDatapoints` defaults to 100,800 [S3] |
| Logs Insights | 100 concurrent queries; 60-minute timeout; up to 100,000 rows per query; 10,000 rows per `GetQueryResults` page | One page only in this design [S4] |
| EventBridge delivery | 5 targets per rule; retries up to 185 attempts / 86,400 s | Rule target limits [S8] |
| SNS HTTP retries | Default 3; maximum 100; total retry time capped at 3,600 s | Custom HTTP/S delivery policy [S7] |

Overage handling: set a zero-spend budget alarm for `GetMetricData`, keep the connector to one call per bundle, and alarm on SNS delivery failures. The exact per-metric `GetMetricData` price was not extracted in this pass — **UNVERIFIED**; the pricing page states the different structure without a number [S2].

## 3. Auth and least privilege

Use an IAM role assumed by the worker (web identity or instance profile). Do not create an access key if role assumption is available. The role is region-restricted and read-only.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadMetricsAndAlarmMetadata",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "cloudwatch:DescribeAlarms"
      ],
      "Resource": "*"
    },
    {
      "Sid": "QueryOnlyAllowlistedLogGroups",
      "Effect": "Allow",
      "Action": [
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:StopQuery"
      ],
      "Resource": "arn:aws:logs:<region>:<account-id>:log-group:<allowlisted-group>:*"
    },
    {
      "Sid": "ListLogGroupsForOperatorChecks",
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups"],
      "Resource": "*"
    }
  ]
}
```

`GetMetricData` and `ListMetrics` do not offer useful resource-level scoping, so `Resource: "*"` is paired with a region condition in deployment. The log-group ARNs are the real boundary. Deliberately absent: `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:PutLogEvents`, `cloudwatch:PutMetricAlarm`, `cloudwatch:SetAlarmState`, `cloudwatch:DeleteAlarms`, `sns:*`, and every write action.

Rotation: prefer role assumption with a short session and an external ID; there is no long-lived key to rotate. If a key is unavoidable, use a dedicated IAM user for this connector only, rotate it on a 90-day schedule, keep one active key, and revoke the old key after the deploy is verified. Never place a key, session token or role ARN in a prompt, task goal, tool result or audit detail.

## 4. Inbound trigger

CloudWatch alarm actions can publish to SNS. SNS HTTPS subscriptions do **not** send our HMAC; they send an AWS-signed JSON envelope. Our receiver only understands GitHub and generic HMAC modes, so a bridge is mandatory. The bridge may be a Lambda function, a small container, or a serverless edge function; it is operator-deployed, not part of this repository.

| Property | Value |
|---|---|
| Native envelope | SNS JSON: `Type`, `MessageId`, `TopicArn`, `Subject`, `Message`, `Timestamp`, `SignatureVersion`, `Signature`, `SigningCertURL`, `UnsubscribeURL` (and `SubscribeURL`/`Token` for confirmations) [S6] |
| Native signature | RSA signature over the required fields in byte-sort (alphabetical) order with one trailing newline; SignatureVersion 1 = SHA-1, version 2 = SHA-256 [S6] |
| Signed fields | Notification: `Message`, `MessageId`, `Subject` (if present), `Timestamp`, `TopicArn`, `Type`. Confirmation: `Message`, `MessageId`, `SubscribeURL`, `Timestamp`, `Token`, `TopicArn`, `Type` [S6] |
| Bridge requirements | Accept SignatureVersion 2 only; validate `SigningCertURL` host against `sns.<region>.amazonaws.com`; cache the X.509 cert; enforce the topic ARN allowlist; enforce a 5-minute window on the signed `Timestamp`; constant-time RSA verify |
| Bridge → platform | Re-serialize the bounded `IncidentSignal` and send `X-Isolate-Timestamp` + `X-Isolate-Signature: sha256=<hex>` over `${timestamp}.${body}` to `POST /api/webhooks/cloudwatch` |
| Body cap | 64 KiB at the bridge and at our receiver; a larger SNS message is rejected `413` before parsing |
| Alarm filter | Only `Type: Notification`, `NewStateValue: ALARM`, and an alarm ARN in the allowlist create a task. `OK` and `INSUFFICIENT_DATA` are ignored |
| Retries | Configure the SNS HTTP/S delivery policy to 3 retries within 60 s, then stop; do not let the 23-day default apply. The bridge returns 2xx after the platform accepts [S7] |
| Dedupe | Fingerprint `cloudwatch:<region>:<alarmArn>` (hash if over 128 chars), 30-minute bucket; SNS `MessageId` is traceability only |
| Subscription confirmation | Auto-confirm only after signature and topic verification; otherwise print the `SubscribeURL` for an operator to confirm out of band |

EventBridge is an alternative trigger: a rule can target SNS, Lambda, or an API destination. An API destination authenticates through a connection (API key, basic or OAuth), not a timestamped HMAC, so it still needs the bridge to produce `X-Isolate-Signature`; its exact auth options were not re-verified in this pass — **UNVERIFIED**. For a rule that targets SNS, the same SNS verification and bridge apply. Keep one rule and one target per alarm class; the 5-target limit is not a routing mechanism.

The bridge must not auto-fetch `SigningCertURL` from an unverified host, must not follow redirects, and must not echo the SNS body. The platform's intake then applies the normal 30-minute dedupe, two-task cap, and 202-before-model rule.

## 5. Read-only context

All calls use SigV4 against the regional endpoints. The plan is fixed; the model selects only a bounded metric name or log group from an operator allowlist.

| Need | Endpoint / call | Parameters and bounds | Source |
|---|---|---|---|
| Alarm metadata | `DescribeAlarms` (`Action=DescribeAlarms&Version=2010-08-01`) | At most 3 allowlisted alarm names; state, reason, timestamps, metric namespace/name | [S9] |
| Metric shape | `GetMetricData` (`Action=GetMetricData&Version=2010-08-01`) | 1-10 `MetricDataQueries`; `Period` fixed 60 or 300 s; `MaxDatapoints` 60; one page; `ScanBy=TimestampAscending` | [S3] |
| Log summary | `StartQuery` (`POST logs.<region>.amazonaws.com`, `X-Amz-Target: Logs_20140328.StartQuery`) | 1-2 fixed queries, `limit` 50, window ≤ 60 min, 15-minute timeout; aggregate first (`stats count by bin`) | [S4] |
| Log result | `GetQueryResults` (`X-Amz-Target: Logs_20140328.GetQueryResults`) | One page per query, `limit` 50; no `nextToken` loop | [S4] |
| Discovery | `ListMetrics` is allowed but not used by the reader | Operator tooling only; no account-wide enumeration in a bundle | [S3] |

Caps: at most 12 provider calls per bundle; 100 items (shared contract); 10 metrics; 60 points per metric; 2 log queries; 50 rows per query; 4,000 characters per context item; 256 KiB total. Metric excerpts are summarized to at most 1,500 characters or 20 points. Log excerpts drop `@message` unless the fixed template explicitly projects a redacted, 2,000-character error line; everything else is counts and field names.

KQL is not involved: Logs Insights uses its own query language. Example fixed templates (not model-authored):

```text
# error shape, no raw message body
fields @timestamp, @logStream
| filter @message like /(?i)(error|exception|timeout)/
| stats count() as errors by bin(5m)
| sort @timestamp desc
| limit 50

# bounded error excerpt, only for an allowlisted log group
fields @timestamp, @logStream, @message
| filter @message like /(?i)(error|exception|timeout)/
| sort @timestamp desc
| limit 20
```

Never fetch CloudTrail, VPC flow logs, or application bodies wholesale. Application log groups frequently contain tokens, emails, IPs and request bodies; the aggregate template exists specifically to avoid shipping them.

## 6. Framework fit

| Item | Design |
|---|---|
| Module | `packages/integrations/src/cloudwatch/` (design only) |
| Source enum | Add `cloudwatch` to `INCIDENT_SOURCES` in `packages/shared/src/types/incident.ts` in a **contract commit before any adapter** |
| Transport | `verifySnsMessage`, `normalizeCloudWatchAlarm`, `signGenericDelivery`; these run in the operator bridge, not in the Next route |
| Reader | `fetchCloudWatchIncidentContext(deps, input)` with injected AWS client and clock |
| Tools | `cloudwatch.get_metrics` (`read_only`), `cloudwatch.query_logs` (`read_only`), `cloudwatch.get_alarm` (`read_only`) |
| Risk bands | All three are `read_only`; no `scoped_write` or `sensitive` surface exists |
| Env | `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_EXTERNAL_ID`, `CLOUDWATCH_METRIC_NAMESPACE_ALLOWLIST`, `CLOUDWATCH_LOG_GROUP_ALLOWLIST`, `CLOUDWATCH_ALARM_ARN_ALLOWLIST`, `SNS_TOPIC_ARN_ALLOWLIST`, `WEBHOOK_SIGNING_SECRET` |
| Audit | Design target: one row per read tool with org, task, tool, region, item count, duration, bytes, policy decision; never the query text, ARNs beyond the allowlisted target, or credentials |

Sandbox implications: the tools execute in the worker process, not inside the Modal sandbox. The sandbox keeps egress deny and receives no AWS credential, role ARN or session token. Tool results are bounded and redacted before they enter the prompt. The model cannot pass a bucket, log group or ARN; it passes a logical name that trusted code maps to an allowlisted identifier.

Tests (fakes only): a valid SNS SignatureVersion 2 fixture is accepted; SHA-1, a bad cert host, a stale timestamp, a wrong topic and an oversized body are rejected; `normalizeCloudWatchAlarm` ignores `OK`/`INSUFFICIENT_DATA`; the reader enforces 12 calls, 10 metrics, 2 log queries and the 256 KiB cap; a `429`/`Throttling` response degrades to a partial bundle with `truncated: true`; no secret appears in an error; a cross-org task gets `NOT_FOUND`.

## 7. Operator setup checklist

1. Choose one AWS account and region. Create an SNS topic for alarm notifications and one HTTPS subscription pointing at the bridge URL.
2. Deploy the bridge with the signing certificate cache, topic allowlist, 64 KiB cap, 5-minute timestamp window, and the platform HMAC secret. Confirm the subscription only after the first signed `SubscriptionConfirmation` passes verification.
3. Create the IAM role from §3, restrict it to the region and the allowlisted log-group ARNs, and configure the worker's role assumption.
4. Create or select at most three alarms that matter for production, and attach the SNS topic as the alarm action. Do not attach EC2 or Auto Scaling actions.
5. Set a log retention policy explicitly (for example 30 days) on every allowlisted log group; the default is never expire.
6. Add a zero-spend budget alarm for `GetMetricData` and an alarm on bridge 5xx responses.
7. Verify offline gates with no AWS credential, then send one SNS test notification and confirm exactly one task. Replay the same SNS `MessageId` and confirm dedupe.
8. Add the credential last, after code and tests are merged; this page does not authorize a live call.

```dotenv
AWS_REGION=
AWS_ROLE_ARN=
AWS_EXTERNAL_ID=
CLOUDWATCH_METRIC_NAMESPACE_ALLOWLIST=
CLOUDWATCH_LOG_GROUP_ALLOWLIST=
CLOUDWATCH_ALARM_ARN_ALLOWLIST=
SNS_TOPIC_ARN_ALLOWLIST=
WEBHOOK_SIGNING_SECRET=
```

Names only; values are server-side and must never be committed, logged or placed in a fixture.

## 8. Acceptance checklist

Offline, with providers disabled:

- [ ] SNS verifier fixtures: valid v2 accepted; v1, bad signature, wrong cert host, wrong topic, stale timestamp and oversize body rejected with no body echo.
- [ ] Alarm normalizer: only `ALARM` produces a signal; fingerprint is the alarm ARN; severity clamps to critical/high only.
- [ ] Reader fakes: 10-metric, 2-query and 12-call caps; `truncated` on throttle or timeout; no raw `@message` unless the bounded template ran.
- [ ] Redaction seeds for `AKIA`, `ASIA`, bearer tokens, emails, IPv4 and request bodies.
- [ ] Intake: replay within 30 minutes creates nothing; a third active incident is throttled; cross-org read is `NOT_FOUND`.
- [ ] `bun run validate` twice with `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`.

Live (separate explicit authorization; one bounded read, no retries):

- [ ] One `GetMetricData` call for one allowlisted metric, 60 points, 5-minute period; record the API unit count and cost from the bill, not an estimate.
- [ ] One `StartQuery` with `limit: 10` over a 5-minute window on one allowlisted log group; confirm no `@message` reaches the prompt.
- [ ] Stop at the first cap; report the measured usage; do not retry after a success.

## 9. Risks and what must never enter model context

- Alarm history can reveal account IDs, ARNs, instance IDs and internal hostnames; only the allowlisted alarm fields and a normalized resource name are kept.
- Logs Insights rows can contain credentials, PII, request bodies and SQL. Aggregate first; if an excerpt is unavoidable, redact before truncation and keep 2,000 characters.
- Free-tier confusion: `GetMetricData` is excluded from the 1M free API requests and is the one call that can quietly cost money. Treat it as metered.
- SNS signature verification is easy to get wrong (field order, trailing newline, certificate host). Use the AWS SDK verifier where possible and test against fixtures.
- The bridge is an internet-facing component with an AWS trust relationship; it must not expose a generic "publish to SNS" or "read any log group" endpoint.
- Never in context: access keys, session tokens, role ARNs, `SigningCertURL` query strings, raw SNS envelopes, full log bodies, CloudTrail events, VPC flow logs, customer identifiers, dashboard JSON.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Explore AWS services with AWS Free Tier](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html) |
| S2 | [Amazon CloudWatch pricing and free tier](https://aws.amazon.com/cloudwatch/pricing/) |
| S3 | [GetMetricData API](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html) |
| S4 | [StartQuery API](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_StartQuery.html) |
| S5 | [PutRetentionPolicy API](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutRetentionPolicy.html) |
| S6 | [Verifying the signature of an Amazon SNS message](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html) |
| S7 | [Amazon SNS message delivery retries](https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html) |
| S8 | [Amazon EventBridge quotas](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-quota.html) |
| S9 | [Using Amazon CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html) |
