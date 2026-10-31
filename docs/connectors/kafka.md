# Apache Kafka connector (self-hosted, bridge)

| Field | Value |
|---|---|
| Status | **Design-only — no code** (this page specifies the bridge) |
| Free tier verified | 2026-10-31 — Apache Kafka is Apache-2.0 OSS; self-hosting is free, you pay for infrastructure |
| Auth | SASL/SCRAM-SHA-256/512 or mTLS; Kafka ACLs on topic and consumer group |
| Inbound | **None native.** `packages/integrations/src/kafka-bridge/` consumes allowlisted topics and posts the signed generic webhook |
| Read | None — Kafka is produce/consume, not a context API; topic metadata and consumer lag are bounded tool candidates only |
| Writes | None in scope; a future `kafka.produce` would be `sensitive` |
| Design reference | [`docs/connector-usage.md`](../connector-usage.md) §1–§6; [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §3.7 |

Kafka has no native inbound webhook to this platform. The connector is a
**bridge service**, not a webhook adapter: it is the trusted consumer that turns
a bounded Kafka record into the existing signed-webhook contract. There is no
new intake path.

## 1. Role in the agent

The bridge lets an organization reuse its event bus as a task source without
giving the platform a Kafka credential inside the agent or the sandbox. The
bridge is the only component that talks to Kafka; it emits exactly the same
`IncidentSignal` document as any other generic sender, signed with the endpoint
secret. The agent then uses the normal task path: clone, bounded turns,
validation, human approval, PR.

It must not become a general stream processor, a log exporter, a schema-registry
proxy or a way to put arbitrary bus data into a prompt. There is no read
context: Kafka is not queried by the model.

## 2. Free tier and quotas

Apache Kafka is free software. There is no vendor account and no credit. The
real quotas are cluster defaults and the platform's own caps.

| Constraint | Default | Source |
|---|---|---|
| Broker `message.max.bytes` | 1,048,588 bytes (~1 MiB; 1 MiB + 12-byte overhead) | [S1] |
| Topic `max.message.bytes` | 1,048,588 bytes | [S1] |
| Partitions per new topic (`num.partitions`) | 1 | [S2] |
| Retention (`log.retention.hours`) | 168 hours / 7 days | [S2] |
| Topic `retention.ms` | 604,800,000 (7 days) | [S1] |
| `min.insync.replicas` | 1 | [S1] |
| `offsets.topic.num.partitions` | 50 | [S2] |
| Platform record cap | **64 KiB** per record and per webhook body | this design |
| Platform payload default | 48 KiB, leaving envelope headroom | this design |

The platform cap is far below the broker default. A larger record is skipped
and counted, never split into several incidents: one logical alert must not
become several tasks. Topics should be created with the partition count and
retention the operator needs; a single partition gives global order at the cost
of throughput.

## 3. Authentication

| Method | Configuration | Notes |
|---|---|---|
| SASL/SCRAM-SHA-256 or -512 | `security.protocol=SASL_SSL`, `sasl.mechanism=SCRAM-SHA-256`, username/password | SCRAM credentials are stored in the Kafka metadata log [S3] |
| mTLS | `security.protocol=SSL`, `ssl.keystore.location`, `ssl.truststore.location`, `ssl.client.auth=required` on the broker | The bridge presents a client certificate; no password on disk [S5] |
| OAuth / Kerberos | `SASL/OAUTHBEARER` or `SASL/GSSAPI` | Possible, not the first target; verify the broker's issuer/principal mapping |

ACLs are mandatory, not optional. With `StandardAuthorizer` the default is deny
when no ACL matches; `allow.everyone.if.no.acl.found` must stay `false` [S4].
The bridge principal needs only:

- `Read` and `Describe` on the allowlisted topics;
- `Read` on the consumer group id;
- no `Write`, `Create`, `Delete`, `Alter` or cluster-wide operation.

```bash
kafka-acls.sh --bootstrap-server "$BOOTSTRAP" --add \
  --allow-principal User:isolate-bridge \
  --operation Read --operation Describe --topic alerts.prod
kafka-acls.sh --bootstrap-server "$BOOTSTRAP" --add \
  --allow-principal User:isolate-bridge \
  --operation Read --group isolate-bridge-prod
```

Never reuse an admin principal. A bridge credential is stored in
`connector_credentials` (`auth_kind=sasl_scram` or `mtls`) once the broker
exists; until then it is a deployment env var. It never enters the sandbox.

## 4. Bridge and trigger

### 4.1 Placement

```text
packages/integrations/src/kafka-bridge/
  config.ts     # strict env parsing, allowlists, caps
  consumer.ts   # Kafka consumer, manual commit, pause/resume, backoff
  record.ts     # 64 KiB cap, JSON parse, strict schema, redaction
  signal.ts     # record -> IncidentSignal, fingerprint, source "kafka"
  signer.ts     # HMAC over `${timestamp}.${body}`
  bridge.ts     # poll -> sign -> POST -> 202 -> commit; DLQ
  index.ts      # startKafkaBridge, normalizeKafkaRecord, buildKafkaIncidentSignal
```

Planned exports: `startKafkaBridge(config, deps)`,
`normalizeKafkaRecord(record, now)`, `buildKafkaIncidentSignal(input)`,
`signWebhookBody(secret, timestamp, body)`. Tests use a fake consumer and a
local receiver; no broker in unit tests.

### 4.2 Record contract

The record value is UTF-8 JSON matching a strict schema. Unknown fields are
rejected; the bridge never forwards the raw record.

```json
{
  "schemaVersion": 1,
  "kind": "deploy_failed",
  "severity": "high",
  "service": "checkout-api",
  "title": "Production deploy failed",
  "summary": "Deploy 8841 exited 1 during migration.",
  "links": [{ "label": "Deploy log", "url": "https://ci.example.com/builds/8841" }],
  "key": "checkout-api:prod:deploy",
  "receivedAt": "2026-10-31T09:02:00Z"
}
```

The bridge forces `source: "kafka"`; it does not trust a `source`, `fingerprint`,
`organization`, repository or workflow in the record. `key` is the
producer-supplied message key material and is optional; if absent, the Kafka
record key is used. `receivedAt` is the record timestamp when present, otherwise
the bridge clock.

### 4.3 Fingerprint and dedupe

```text
fingerprint = "kafka:" + sha256(topic + "\0" + partition + "\0" + offset + "\0" + key)
```

The digest is bounded to 64 hex characters; the full string stays under the
128-character `incidentSignal.fingerprint` cap. This includes **message key +
topic + partition + offset**, so a replayed offset produces the same
fingerprint, while two different records on the same key produce different
fingerprints. The trade-off is deliberate: logical coalescing belongs to the
producer (a stable key and a compacted topic), not to the platform. If the
organization wants a flapping alert to collapse across offsets, it must emit
the same incident with the same record offset or add a producer-side debounce.

The platform dedupes `(organization, connector, fingerprint)` for 30 minutes.
The bridge also keeps `topic:partition:offset` as the trace string in the
outbound `summary`/link, so an operator can find the exact record. It is not the
dedupe key.

### 4.4 At-least-once, not exactly-once

Kafka can provide idempotent producers and transactional read-process-write
[S6]. This bridge cannot provide end-to-end exactly-once, because its sink is
HTTP:

- Kafka transaction + offset commit can make "consume and write to another
  Kafka topic" atomic, but the webhook receiver is not a Kafka transaction
  participant.
- A crash after the receiver commits the task and before the bridge commits the
  offset replays the record. The receiver's fingerprint dedupe makes that
  replay a no-op.
- A crash after the bridge commits the offset but before the receiver responds
  cannot happen if the order is strict: **commit only after a `202`**.

Therefore the contract is **at-least-once delivery + idempotent intake**. That
is stronger than at-most-once and honest about the boundary. Do not describe
the bridge as exactly-once.

### 4.5 Commit protocol

Consumer settings: `enable.auto.commit=false`, bounded `max.poll.records`,
`max.poll.interval.ms` above the worst-case HTTP timeout, one in-flight record
per partition, `isolation.level=read_committed` only if the producer uses
transactions.

| Receiver result | Bridge action |
|---|---|
| `202 {taskId,...}` or `202 {deduped:true}` | `commitSync` the offset, continue |
| `202 {accepted:false}` / `{throttled:true}` | Commit; it is a policy drop, not a transport failure |
| `400`, `401`, `403`, `404`, `409`, `413` | Non-retryable: write to DLQ topic, commit, emit metric |
| `429`, `5xx`, timeout, connection error | Do not commit; pause the partition, exponential backoff with jitter, bounded attempts, then DLQ + commit or halt |
| Oversized / unparseable / schema-invalid record | DLQ immediately, commit, metric |

`commitSync` (not async) keeps the ordering simple. On rebalance, stop polling,
drain the in-flight record, commit what was acknowledged, and let the new
assignee replay the rest. The receiver dedupe absorbs the replay.

### 4.6 Size, schema and redaction

- **Size:** reject a record whose value exceeds `KAFKA_BRIDGE_MAX_RECORD_BYTES`
  (default 65,536). After building the signal, reject the serialized body if it
  exceeds the receiver's 64 KiB cap. The default payload budget is 48 KiB so
  the envelope and links fit.
- **Schema:** strict Zod object; reject unknown fields, arrays where an object
  is expected, non-https links and non-ISO timestamps. A schema registry, if
  used, is an additional check, not a replacement for this allowlist.
- **Redaction:** `redactSecretsUnbounded` from
  `packages/integrations/src/github/redact.ts` plus Kafka-specific patterns
  (`sasl.jaas.config`, `password=`, SCRAM secrets, PEM blocks) before
  truncation. PII patterns (email, IP, phone, cookies) are the shared design
  target, not implemented today.
- **Truncation:** title 200, summary 2,000, links 10, each URL 512 and https;
  the same caps as `packages/shared/src/types/incident.ts`.

## 5. Read context

None. Kafka is a transport, not an evidence API. The bridge does not fetch
topics on behalf of the model, and there is no `kafka.query` tool. A future
read-only `kafka.topic_lag`/`kafka.describe` tool would be `read_only`, fixed to
the cluster allowlist and bounded to topic metadata, never message bodies.

## 6. Framework fit

| Item | Value |
|---|---|
| Module | `packages/integrations/src/kafka-bridge/` (trigger-only; no `fetchContext`) |
| Source token | `kafka` must be added to `INCIDENT_SOURCES` before the adapter; until then the bridge would have to claim `generic`, which loses provenance |
| Transport | Existing `POST /api/webhooks/{connector}/{endpointId}`; `x-isolate-timestamp` + `x-isolate-signature: sha256=<hex>` over `${timestamp}.${body}` |
| Tools | None. No `ToolName` change for the bridge itself |
| Risk | A future `kafka.produce` is `sensitive` (approval-bound); the bridge is a trusted service, not an agent tool |
| Sandbox | Never. The bridge runs as its own process; sandbox egress stays `deny` |
| Credential | Broker `sasl_scram`/`mtls` row; webhook secret in `connector_credentials`; neither enters `SandboxSpec.env` |
| Retry | Bounded backoff only; no loop, no parallel live calls |

## 7. Operator checklist

1. Create the topic(s) with the intended partitions and retention. Record the
   exact allowlist; wildcards are rejected by the bridge.
2. Create a dedicated SCRAM user or client certificate for the bridge. Do not
   use an admin principal.
3. Grant `Read`/`Describe` on the topics and `Read` on the consumer group;
   verify `allow.everyone.if.no.acl.found=false`.
4. Create the endpoint binding (organization, repository, branch, workflow,
   ownership) and a webhook secret of at least 32 random characters.
5. Configure the bridge; start with `KAFKA_BRIDGE_DRY_RUN=1` so records are
   validated and logged by code only, never posted.
6. Send one fixture record to a test topic. Verify exactly one task, a `202`
   response, one committed offset and no secret in the bridge log.
7. Replay the same record. Verify `202 {deduped:true}` and no second task.
8. Stop the receiver, send one record, and verify the bridge does not commit and
   resumes after recovery; then verify the task is created once.
9. Record the retention/partition choices and the ACL review date.

Environment names (values are server-side; never commit or print them):

```text
KAFKA_BRIDGE_BOOTSTRAP_SERVERS
KAFKA_BRIDGE_TOPICS
KAFKA_BRIDGE_GROUP_ID
KAFKA_BRIDGE_SECURITY_PROTOCOL
KAFKA_BRIDGE_SASL_MECHANISM
KAFKA_BRIDGE_SASL_USERNAME
KAFKA_BRIDGE_SASL_PASSWORD
KAFKA_BRIDGE_SSL_CA_PATH
KAFKA_BRIDGE_SSL_CERT_PATH
KAFKA_BRIDGE_SSL_KEY_PATH
KAFKA_BRIDGE_MAX_RECORD_BYTES
KAFKA_BRIDGE_MAX_IN_FLIGHT
KAFKA_BRIDGE_WEBHOOK_URL
KAFKA_BRIDGE_WEBHOOK_SECRET
KAFKA_BRIDGE_DRY_RUN
WEBHOOK_SIGNING_SECRET
WEBHOOK_ORGANIZATION_ID
WEBHOOK_ACTOR_ID
WEBHOOK_REPOSITORY_ID
WEBHOOK_BRANCH
WEBHOOK_WORKFLOW_DEFINITION_ID
WEBHOOK_WORKFLOW_VERSION
WEBHOOK_FILE_OWNERSHIP
```

`KAFKA_BRIDGE_WEBHOOK_SECRET` and the receiver's endpoint secret must match;
they are one secret with two copies, not two independent secrets. Rotate both
in the same change window.

## 8. Acceptance checklist

Offline (no broker, no key):

- [ ] A fixture record maps to one strict `IncidentSignal`; unknown fields,
      arrays, non-https links and a 65 KiB record are rejected without echo.
- [ ] The generated HMAC verifies over `${timestamp}.${body}`; a tampered body,
      stale timestamp and missing header are `401`.
- [ ] `202` commits the offset; `5xx`/timeout does not; `400` goes to the DLQ
      and commits; no infinite retry.
- [ ] The same `topic/partition/offset/key` produces one task on replay.
- [ ] Redaction removes a seeded SCRAM password, PEM block and bearer token
      before truncation.
- [ ] The bridge never logs the record body, secret, signature or full URL.

Live (only after explicit authorization, one bounded run):

- [ ] One record on the named test topic creates one task; the offset is
      committed once; no retry was made.
- [ ] Measured lag, record count and bridge duration are recorded. Kafka is
      self-hosted, so there is no metered spend; infrastructure cost is outside
      this check.

## 9. Risks

| Risk | Control |
|---|---|
| Poison record blocks a partition | Bounded attempts, DLQ, commit, alert |
| Rebalance replays a batch | Receiver fingerprint dedupe; idempotent task key |
| Duplicate task after crash | Commit-after-202 plus `(org, connector, fingerprint)` dedupe |
| Record body carries PII/secrets | Redact before truncation; no raw payload retention; DLP review |
| Bridge credential over-privileged | Read/Describe only; dedicated principal; ACL review |
| Cluster compromise reaches the platform | Bridge egress only to Kafka and the receiver; no sandbox access; HMAC on intake |
| Schema drift | Strict schema; DLQ + metric; unknown fields rejected |
| False sense of exactly-once | Documented at-least-once; no promise of EOS |
| Bridge becomes a data exporter | Topic allowlist; bounded fields; no read tool, no prompt path |

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Apache Kafka 4.1 topic configs](https://kafka.apache.org/41/configuration/topic-configs/) |
| S2 | [Apache Kafka 4.1 broker configs](https://kafka.apache.org/41/configuration/broker-configs/) |
| S3 | [Apache Kafka 4.1 SASL authentication](https://kafka.apache.org/41/security/authentication-using-sasl/) |
| S4 | [Apache Kafka 4.1 authorization and ACLs](https://kafka.apache.org/41/security/authorization-and-acls/) |
| S5 | [Apache Kafka 4.1 SSL encryption and authentication](https://kafka.apache.org/41/security/encryption-and-authentication-using-ssl/) |
| S6 | [Apache Kafka 4.1 design](https://kafka.apache.org/41/design/design/) |
| S7 | [Generic signed webhook](generic-webhook.md) (repo transport contract) |
