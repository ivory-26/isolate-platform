# Confluent Cloud connector (Kafka bridge)

| Field | Value |
|---|---|
| Status | **Design-only — no code** (bridge design in [`kafka.md`](kafka.md)) |
| Free tier verified | 2026-10-31 — **trial only**: $400 credit for 30 days for new signups; no free-forever cluster [S1][S2] |
| Auth | Kafka API key + secret over SASL/SSL, owned by a service account; ACLs per principal [S3] |
| Inbound | None native; deploy `packages/integrations/src/kafka-bridge/` against the cluster |
| Read | None — produce/consume only; no context reader |
| Writes | None in scope; `kafka.produce` would be `sensitive` |
| Design reference | [`docs/connector-usage.md`](../connector-usage.md) §4–§6; [`kafka.md`](kafka.md) §4 |

Confluent Cloud is managed Kafka with the same bridge contract as self-hosted
Kafka. The only differences are the credential shape, the cluster quotas and
the commercial terms.

## 1. Role in the agent

Same role as [`kafka.md`](kafka.md): the bridge consumes an allowlisted topic
and turns a bounded record into the signed generic webhook. Confluent adds no
new plane and no new tool. It is a hosting choice for the bus, not a context
provider.

Do not use Confluent's connectors, ksqlDB or Stream Governance as an implicit
path to the model. If a stream processing job is needed, it is a separate,
operator-owned component with its own review; the platform only sees the
bridge's signed HTTP delivery.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| New-signup credit | **$400**, spend within the first **30 days** | [S1] |
| Free-forever tier | **None documented**; a payment method is required to create resources | [S2] |
| Basic cluster partitions | 1,500 | [S4] |
| Standard cluster partitions | 2,500 | [S4] |
| Enterprise cluster partitions | 96,000 | [S4] |
| Dedicated cluster partitions | 100,000 | [S4] |
| Basic/Standard max message | **8 MB** | [S4] |
| Enterprise/Dedicated max message | **20 MB** | [S4] |
| Basic storage | 5 TB per partition; unlimited storage per partition otherwise | [S4] |
| Basic throughput | up to 250 MB/s ingress, 750 MB/s egress | [S4] |
| Basic SLA | 99.5% | [S4] |
| Basic RBAC | Not available; ACLs still apply | [S4] |

The platform's 64 KiB record/body cap is far below every cluster limit. A
trial is not a free tier: when the credit or the 30 days ends, usage is billed.
Stop the bridge and delete the cluster after acceptance; leaving a cluster idle
can still incur storage and egress costs.

## 3. Authentication

| Item | Value |
|---|---|
| Kafka credential | API key and secret, sent as SASL/PLAIN over TLS (`security.protocol=SASL_SSL`, `sasl.mechanism=PLAIN`) [S3] |
| Identity | A **service account** owns the key; permissions attach to the principal, not to the key [S3] |
| Key scope | Prefer a resource-scoped key for the one cluster; a global key counts against the per-cluster quota [S3] |
| Key limit | Each user or service account may hold at most **two global API keys** [S3] |
| Secret display | The secret is shown once; if lost, rotate or create a new key [S3] |
| Authorization | Kafka ACLs on the service account: `Read`/`Describe` on the topic, `Read` on the consumer group [S3] |

Create one service account per environment and one resource-scoped key per
bridge. Do not use a personal user key, a global key or an organization admin
key. The key and secret are written to `connector_credentials`
(`auth_kind=api_key`) or, before that table exists, to the deployment secret
manager; neither belongs in a prompt, a bridge log or a sandbox.

## 4. Bridge and trigger

The bridge is the same module and the same commit protocol as [`kafka.md`](kafka.md)
§4. Confluent-specific configuration:

```text
KAFKA_BRIDGE_BOOTSTRAP_SERVERS   # lkc-xxxxx.<region>.confluent.cloud:9092
KAFKA_BRIDGE_SECURITY_PROTOCOL   # SASL_SSL
KAFKA_BRIDGE_SASL_MECHANISM      # PLAIN
KAFKA_BRIDGE_SASL_USERNAME       # the API key
KAFKA_BRIDGE_SASL_PASSWORD       # the API secret
KAFKA_BRIDGE_TOPICS              # one allowlisted topic, no wildcard
KAFKA_BRIDGE_GROUP_ID            # one group per endpoint
KAFKA_BRIDGE_WEBHOOK_URL
KAFKA_BRIDGE_WEBHOOK_SECRET
```

`CONFLUENT_API_KEY` and `CONFLUENT_API_SECRET` are acceptable aliases only if
the bridge config maps them to the SASL fields; do not add a second credential
path that bypasses the broker. TLS uses the system trust store; a custom CA is
not needed for Confluent Cloud.

Trigger rules are identical: record cap 64 KiB, strict JSON, forced
`source: "kafka"`, fingerprint over `topic/partition/offset/key`, manual commit
only after `202`, DLQ for non-retryable `4xx`, bounded backoff for `429`/`5xx`.

## 5. Read context

None. The Confluent REST APIs and Metrics API are not used by the context
plane. A future bounded `kafka.topic_lag` tool could read consumer lag, but
that is metadata, not evidence, and would need its own read-only credential and
tool entry.

## 6. Framework fit

| Item | Value |
|---|---|
| Module | `packages/integrations/src/kafka-bridge/`; no Confluent SDK required (Kafka protocol only) |
| Contract | Same `IncidentSignal` and HMAC transport as [`generic-webhook.md`](generic-webhook.md) |
| Source token | `kafka` after the contract change; do not claim `generic` |
| Tools | None; bridge is trusted service code |
| Risk | Future `kafka.produce` = `sensitive`; no merge/deploy path |
| Sandbox | Never; bridge runs outside the sandbox, sandbox egress stays deny |
| Credential | API key/secret in the broker; bridge copy in its own env only |

## 7. Operator checklist

1. Create the Confluent environment, Basic cluster and one topic with the
   partition count and retention the team needs. Record the cluster id/region.
2. Create a service account and a resource-scoped API key. Grant only
   `Read`/`Describe` on the topic and `Read` on the group.
3. Store the key/secret in the secret manager (or `connector_credentials` once
   migration `0010` exists). Never paste it into a task, ticket or prompt.
4. Create the endpoint binding and a separate webhook secret of at least 32
   characters.
5. Start the bridge in dry-run, send one fixture record, then enable posting.
6. Verify one task, one `202`, one committed offset, and `202 {deduped:true}` on
   replay. Confirm no secret appears in logs.
7. Record the trial expiry date and set a calendar reminder to delete the
   cluster; the $400 credit is not a permanent free tier.

Environment names (values server-side only):

```text
KAFKA_BRIDGE_BOOTSTRAP_SERVERS
KAFKA_BRIDGE_TOPICS
KAFKA_BRIDGE_GROUP_ID
KAFKA_BRIDGE_SECURITY_PROTOCOL
KAFKA_BRIDGE_SASL_MECHANISM
KAFKA_BRIDGE_SASL_USERNAME
KAFKA_BRIDGE_SASL_PASSWORD
KAFKA_BRIDGE_MAX_RECORD_BYTES
KAFKA_BRIDGE_WEBHOOK_URL
KAFKA_BRIDGE_WEBHOOK_SECRET
WEBHOOK_SIGNING_SECRET
WEBHOOK_ORGANIZATION_ID
WEBHOOK_ACTOR_ID
WEBHOOK_REPOSITORY_ID
WEBHOOK_BRANCH
WEBHOOK_WORKFLOW_DEFINITION_ID
WEBHOOK_WORKFLOW_VERSION
WEBHOOK_FILE_OWNERSHIP
```

## 8. Acceptance checklist

Offline: the same bridge tests as [`kafka.md`](kafka.md) §8, plus a Confluent
config fixture that asserts `SASL_SSL` + `PLAIN` and refuses a missing key.

Live (only after explicit authorization, one bounded run):

- [ ] One record on the named topic creates one task; the offset is committed
      once; no retry.
- [ ] The cluster's egress and the bridge duration are recorded; the trial
      credit consumption is checked in the Confluent UI, not estimated.
- [ ] The cluster is deleted or paused after the run, and no bridge process
      remains.

## 9. Risks

| Risk | Control |
|---|---|
| Trial expires and billing starts | Calendar check; delete/pause after acceptance; no unattended cluster |
| Global key over-privilege | Resource-scoped key; service account; ACL review |
| API key in a log or prompt | Broker-only resolution; redaction; no value in errors |
| 8 MB cluster limit tempts large events | Platform 64 KiB cap; DLQ oversized records |
| Egress/storage cost | One topic, short retention, delete after run |
| Managed-service drift | Fixed client config; fake fixtures; verify on acceptance |

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Confluent Cloud FAQs](https://www.confluent.io/confluent-cloud-faqs/) |
| S2 | [Confluent Cloud billing FAQ](https://docs.confluent.io/cloud/current/billing/billing-faq.html) |
| S3 | [Use API keys to authenticate](https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/service-accounts/api-keys/overview.html) |
| S4 | [Kafka cluster types in Confluent Cloud](https://docs.confluent.io/cloud/current/clusters/cluster-types.html) |
