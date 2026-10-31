# Redpanda connector (Kafka API bridge)

| Field | Value |
|---|---|
| Status | **Design-only — no code** (bridge design in [`kafka.md`](kafka.md)) |
| Free tier verified | 2026-10-31 — **Cloud trial only**: Serverless 30 days with $100 credit and a 7-day grace period; no free-forever Cloud tier [S1][S2] |
| Auth | SASL/SCRAM, mTLS or OIDC; ACLs; HTTP Proxy uses Basic or OIDC [S3][S4] |
| Inbound | None native; deploy `packages/integrations/src/kafka-bridge/` |
| Read | None — Kafka API is produce/consume; no context reader |
| Writes | None in scope; `kafka.produce` would be `sensitive` |
| Design reference | [`docs/connector-usage.md`](../connector-usage.md) §4–§6; [`kafka.md`](kafka.md) §4 |

Redpanda speaks the Kafka API, so the bridge is the same module as self-hosted
Kafka. Redpanda adds two tempting shortcuts that this design rejects: the HTTP
Proxy as a second produce/consume surface, and data transforms as a way to call
the webhook from inside the broker. Neither is the bridge.

## 1. Role in the agent

Redpanda is a hosting choice for the event bus. The trusted bridge consumes an
allowlisted topic, validates and redacts a bounded record, signs the generic
webhook and commits the offset only after `202`. The agent never receives a
Redpanda credential and never queries the cluster.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| Serverless trial | **30 days**, **$100** credit, **7-day** grace after expiry | [S1][S2] |
| Free-forever Cloud tier | **None documented**; Serverless is usage-billed after the trial | [S1] |
| Serverless ingress | 100 MB/s | [S5] |
| Serverless egress | 300 MB/s | [S5] |
| Serverless partitions | 5,000 | [S5] |
| Serverless topics | 300 | [S5] |
| Serverless max message | 20 MiB | [S5] |
| Serverless retention | Unlimited | [S5] |
| Serverless users / ACLs | 30 / 120 | [S5] |
| Self-host message default | `kafka_batch_max_bytes` 1 MiB; `max.message.bytes` per topic | [S6] |
| Self-host license | Community Edition is **BSL 1.1**, source-available, not OSI open source; core features free | [S7] |

The trial is a credit allowance, not a free tier. The 20 MiB Serverless message
limit does not change the platform's 64 KiB cap. Retention is "unlimited" in
the sense that the cluster does not force expiry; storage is still billed.

## 3. Authentication

| Surface | Methods | Notes |
|---|---|---|
| Kafka API | SASL/SCRAM, SASL/PLAIN, SASL/OAUTHBEARER (OIDC), SASL/GSSAPI (Kerberos), mTLS | Use SCRAM or mTLS for the bridge [S3] |
| HTTP Proxy | Basic authentication or OIDC | Not used by the bridge [S4] |
| Schema Registry | Basic or OIDC | Not required; the bridge validates locally |
| Cloud | Dedicated mTLS listener per API service when mTLS is enabled | Verify the listener and CA before coding [S8] |

Use a dedicated bridge principal with `Read`/`Describe` on the topic and `Read`
on the consumer group. Do not grant `Write`, `Create`, `Delete` or admin. The
credential belongs in `connector_credentials` (`sasl_scram` or `mtls`) or the
bridge deployment secret manager, never in a prompt or sandbox.

## 4. Bridge and trigger

Same commit protocol, fingerprint and caps as [`kafka.md`](kafka.md) §4. The
Redpanda profile:

```text
KAFKA_BRIDGE_BOOTSTRAP_SERVERS   # seed brokers / Cloud bootstrap
KAFKA_BRIDGE_SECURITY_PROTOCOL   # SASL_SSL or SSL (mTLS)
KAFKA_BRIDGE_SASL_MECHANISM      # SCRAM-SHA-256 or SCRAM-SHA-512
KAFKA_BRIDGE_SASL_USERNAME
KAFKA_BRIDGE_SASL_PASSWORD
KAFKA_BRIDGE_SSL_CA_PATH         # required for a private CA
KAFKA_BRIDGE_SSL_CERT_PATH       # mTLS only
KAFKA_BRIDGE_SSL_KEY_PATH        # mTLS only
KAFKA_BRIDGE_TOPICS
KAFKA_BRIDGE_GROUP_ID
KAFKA_BRIDGE_WEBHOOK_URL
KAFKA_BRIDGE_WEBHOOK_SECRET
```

### 4.1 Why not the HTTP Proxy

The HTTP Proxy exposes REST produce/consume (`POST /topics/<topic>`,
`GET /consumers/<group>/instances/<id>/records`) and is useful for a quick
smoke test [S4]. It is not the bridge:

- It adds a second network surface and a second auth model (Basic/OIDC).
- It does not give the bridge the same manual-commit and rebalance semantics as
  the Kafka consumer group API.
- A REST proxy in front of the bus is another credential to leak and another
  service to keep available.

Use the Kafka protocol. Use the HTTP Proxy only for a human-run smoke test, with
a temporary read-only principal.

### 4.2 Why not data transforms

Redpanda data transforms run WebAssembly inline, process one record at a time
with at-least-once delivery, and have **no external network access** [S9].
They cannot call the webhook. A transform can filter or redact before the
bridge, but it cannot replace it, and it must not be described as the connector.

## 5. Read context

None. Topic metadata, consumer lag and cluster health are operational signals,
not incident evidence. A future `kafka.topic_lag` read tool would be
`read_only`, fixed to the cluster allowlist and bounded to numeric lag, never
message bodies.

## 6. Framework fit

| Item | Value |
|---|---|
| Module | `packages/integrations/src/kafka-bridge/`; no Redpanda SDK |
| Contract | Same `IncidentSignal`, HMAC and `{connector}/{endpointId}` route |
| Source token | `kafka` after the contract change |
| Tools | None; transform/HTTP proxy are not agent tools |
| Risk | Future `kafka.produce` = `sensitive`; no deploy/merge path |
| Sandbox | Never; bridge only, sandbox egress deny |
| Credential | SCRAM/mTLS in the broker; bridge env copy only |

## 7. Operator checklist

1. Choose Serverless (trial) or self-hosted Community. Record the license
   decision: BSL is source-available, not OSI.
2. Create the topic and a dedicated bridge user/certificate. Grant read-only
   topic/group access.
3. Configure the bridge with the Kafka protocol; do not use the HTTP Proxy for
   production intake.
4. Create the endpoint binding and a separate webhook secret.
5. Dry-run one fixture record; verify no secret in the log and no task.
6. Enable posting; verify one task, one `202`, one offset commit, and dedupe on
   replay.
7. Record the trial end date and delete/pause the cluster after acceptance.

Environment names (values server-side only):

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

Offline: the bridge tests from [`kafka.md`](kafka.md) §8, plus a config fixture
for `SASL_SSL`/`SCRAM-SHA-256` and an mTLS fixture that refuses a missing
certificate.

Live (only after explicit authorization, one bounded run):

- [ ] One record creates one task; the offset is committed once; no retry.
- [ ] The trial credit and egress are read from the Redpanda console, not
      estimated.
- [ ] The cluster is deleted or paused and no bridge process remains.
- [ ] No HTTP Proxy credential or transform is deployed as part of the test.

## 9. Risks

| Risk | Control |
|---|---|
| Trial expiry and billing | Calendar check; delete/pause after run |
| BSL licensing surprise | Record the license decision; legal review before redistribution |
| Transform mistaken for the bridge | Documented no-egress limitation; only the bridge posts |
| HTTP Proxy broadens the surface | Not used in production; temporary smoke test only |
| 20 MiB message limit tempts large events | Platform 64 KiB cap; DLQ oversized |
| mTLS listener misconfiguration | Verify listener/CA on acceptance; fail closed |
| Over-privileged SCRAM user | Read/Describe only; dedicated principal |

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Redpanda Cloud overview](https://docs.redpanda.com/cloud-data-platform/get-started/cloud-overview/) |
| S2 | [What's new in Redpanda Cloud](https://docs.redpanda.com/cloud-data-platform/get-started/whats-new-cloud/) |
| S3 | [Configure authentication](https://docs.redpanda.com/streaming/current/manage/security/authentication/) |
| S4 | [Use the HTTP Proxy API](https://docs.redpanda.com/streaming/current/develop/http-proxy/) |
| S5 | [Serverless cluster type](https://docs.redpanda.com/cloud-data-platform/get-started/cluster-types/serverless/) |
| S6 | [Topic configuration properties](https://docs.redpanda.com/streaming/current/reference/properties/topic-properties/) |
| S7 | [Licensing overview](https://docs.redpanda.com/streaming/current/get-started/licensing/overview/) |
| S8 | [Redpanda Cloud authentication](https://docs.redpanda.com/cloud-data-platform/security/cloud-authentication/) |
| S9 | [How data transforms work](https://docs.redpanda.com/current/develop/data-transforms/how-transforms-work/) |
