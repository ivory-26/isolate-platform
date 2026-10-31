# Aiven for Apache Kafka connector (bridge)

| Field | Value |
|---|---|
| Status | **Design-only — no code** (bridge design in [`kafka.md`](kafka.md)) |
| Free tier verified | 2026-10-31 — **free tier exists**: 1 service/org, 5 topics × 2 partitions, 250 KiB/s in/out, 3-day retention, no SLA, no card [S1][S2] |
| Auth | SASL/SCRAM-SHA-256/512 (default) or client certificates (mTLS); Aiven or Kafka-native ACLs [S3][S4] |
| Inbound | None native; deploy `packages/integrations/src/kafka-bridge/` |
| Read | None — produce/consume only |
| Writes | None in scope; `kafka.produce` would be `sensitive` |
| Design reference | [`docs/connector-usage.md`](../connector-usage.md) §4–§6; [`kafka.md`](kafka.md) §4 |

Aiven is managed Kafka with a genuinely free tier suitable for a pilot. The
bridge is unchanged; the operator must design around the free tier's fixed
retention and throughput.

## 1. Role in the agent

Aiven hosts the event bus. The bridge consumes an allowlisted topic and posts
the signed generic webhook. The platform never holds an Aiven API token and the
agent never queries Aiven.

## 2. Free tier and quotas

| Item | Value | Source |
|---|---|---|
| Services per organization | 1 | [S1] |
| Topics | Up to 5 | [S2] |
| Partitions | 2 per topic | [S2] |
| Throughput | Up to 250 KiB/s ingress and 250 KiB/s egress | [S1][S2] |
| Retention | Up to 3 days, fixed by the plan | [S2] |
| Cloud/region | Fixed, limited selection | [S2] |
| SLA | None; support via documentation | [S2] |
| Kafka Connect / integrations | Not included | [S2] |
| Idle behavior | Service can shut down when idle | [S1] |
| Credit card | Not required | [S1] |

The free tier is for learning, prototyping and evaluation, not production
paging. A 3-day retention means a bridge outage longer than the window loses
records; keep the bridge highly available or accept the gap. The 250 KiB/s cap
is aggregate, not per topic, and is far above the platform's 64 KiB record cap
for normal alert volumes.

## 3. Authentication

| Method | Configuration | Notes |
|---|---|---|
| SASL/SCRAM-SHA-256 or -512 | `security.protocol=SASL_SSL`, `sasl.mechanism=SCRAM-SHA-256`, service user + password | SASL is enabled by default on Aiven Kafka [S3] |
| Client certificate (mTLS) | `security.protocol=SSL`, client cert/key, Aiven CA | The alternative to SCRAM; download the CA and client material from the console [S5] |
| ACLs | Aiven ACLs or Kafka-native ACLs on topics, groups, transactional ids | Grant the bridge principal `Read`/`Describe` and group `Read` only [S4] |

Create a dedicated **service user** for the bridge. Download the CA certificate
(`ca.pem`) and, for mTLS, the client certificate and key. Store the password or
key in the secret manager or `connector_credentials` (`sasl_scram` / `mtls`);
never in a prompt, fixture or bridge log.

## 4. Bridge and trigger

Same commit protocol, fingerprint and caps as [`kafka.md`](kafka.md) §4. The
Aiven profile:

```text
KAFKA_BRIDGE_BOOTSTRAP_SERVERS   # host:port from the service overview
KAFKA_BRIDGE_SECURITY_PROTOCOL   # SASL_SSL or SSL
KAFKA_BRIDGE_SASL_MECHANISM      # SCRAM-SHA-256 or SCRAM-SHA-512
KAFKA_BRIDGE_SASL_USERNAME       # service user
KAFKA_BRIDGE_SASL_PASSWORD
KAFKA_BRIDGE_SSL_CA_PATH         # ca.pem
KAFKA_BRIDGE_SSL_CERT_PATH       # mTLS only
KAFKA_BRIDGE_SSL_KEY_PATH        # mTLS only
KAFKA_BRIDGE_TOPICS              # one of the five topics, no wildcard
KAFKA_BRIDGE_GROUP_ID
KAFKA_BRIDGE_WEBHOOK_URL
KAFKA_BRIDGE_WEBHOOK_SECRET
```

Aiven's free tier fixes the cluster shape; the bridge must not create topics or
alter retention. Provision the topics before starting the bridge and treat the
allowlist as immutable.

## 5. Read context

None. Aiven's service metadata and metrics are operational, not incident
evidence. A future `kafka.topic_lag` tool would be `read_only` and numeric only.

## 6. Framework fit

| Item | Value |
|---|---|
| Module | `packages/integrations/src/kafka-bridge/`; no Aiven SDK |
| Contract | Same `IncidentSignal`, HMAC and route |
| Source token | `kafka` after the contract change |
| Tools | None; bridge is trusted service code |
| Risk | Future `kafka.produce` = `sensitive` |
| Sandbox | Never; bridge only, sandbox egress deny |
| Credential | Service-user password or client key in the broker; env copy only in the bridge |

## 7. Operator checklist

1. Create the free Kafka service and record the region, plan and 3-day
   retention. Confirm the free tier is acceptable for the pilot.
2. Create up to five topics, two partitions each. Record the allowlist.
3. Create a service user; choose SCRAM or client certificate. Download the CA
   (and client cert/key for mTLS).
4. Grant read-only ACLs on the topic and group; no write/admin.
5. Create the endpoint binding and webhook secret; start the bridge in dry-run.
6. Send one fixture record; verify one task, one `202`, one offset commit and
   dedupe on replay.
7. Record the idle-shutdown behavior and the process that restarts the bridge.
8. Rotate the service-user password/certificate before the documented expiry.

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

Offline: the bridge tests from [`kafka.md`](kafka.md) §8, plus a SASL fixture
and a client-certificate fixture; a missing CA fails closed.

Live (only after explicit authorization, one bounded run):

- [ ] One record creates one task; the offset is committed once; no retry.
- [ ] Throughput and retention are recorded; no record older than 3 days is
      assumed to exist.
- [ ] The service user has no write/admin ACL (verified with an explicit deny
      test).
- [ ] The bridge reconnects after an idle shutdown without duplicating a task.

## 9. Risks

| Risk | Control |
|---|---|
| Free tier is not production-grade | Pilot only; document no SLA and fixed retention |
| 3-day retention loses records during an outage | Bridge HA or accepted gap; alert on lag |
| 250 KiB/s aggregate cap | Normal alert volumes; backpressure, not splitting |
| Idle shutdown | Restart supervision; health check |
| Service user over-privileged | Read/Describe only; ACL verification |
| CA/cert expiry | Rotation calendar; fail-closed startup |
| Region/data residency | Fixed free region; confirm before sending customer data |

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Aiven for Apache Kafka free tier (docs)](https://aiven.io/docs/products/kafka/free-tier/kafka-free-tier) |
| S2 | [Free Kafka plan](https://aiven.io/free-kafka) |
| S3 | [Enable and configure SASL](https://aiven.io/docs/products/kafka/howto/kafka-sasl-auth) |
| S4 | [Manage ACLs](https://aiven.io/docs/products/kafka/howto/manage-acls) |
| S5 | [Connect with Go (certificate download)](https://aiven.io/docs/products/kafka/howto/connect-with-go) |
