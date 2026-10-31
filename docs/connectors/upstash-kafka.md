# Upstash Kafka connector (discontinued)

| Field | Value |
|---|---|
| Status | **Design-only — no code; do not implement** |
| Free tier verified | 2026-10-31 — **none**: Upstash Kafka was discontinued; the product, docs and pricing pages return `404` [S1][S2] |
| Auth | Historical: SASL/SCRAM for Kafka, token for the REST API; no current documented contract — **UNVERIFIED** |
| Inbound | None native; there is no bridge target because the service is gone |
| Read | None — produce/consume only |
| Writes | None; do not add `kafka.produce` for this vendor |
| Design reference | [`docs/connector-usage.md`](../connector-usage.md) §4–§6; [`kafka.md`](kafka.md) for the replacement bridge |

This page exists so an operator who finds an old Upstash Kafka cluster, or an
old bookmark to its REST API, does not build a connector against a product that
no longer accepts new users. It is a migration note, not a connector plan.

## 1. Role in the agent

None. Upstash Kafka was a serverless Kafka offering with a per-message REST
API and a free tier. Upstash announced on **2024-09-06** that it would
"discontinue support for Upstash Kafka starting in six months" and directed
users to QStash or Upstash Workflow [S1]. The Kafka docs, product page and
pricing page are now `404`; no current free tier or SLA exists [S2].

The correct role is a **source to migrate away from**. Use a supported Kafka
provider with the bridge in [`kafka.md`](kafka.md), or a workflow/queue product
if the use case was task scheduling rather than event streaming. Do not put a
dead vendor's credential into `connector_credentials`.

## 2. Free tier and quotas

| Item | Status | Evidence |
|---|---|---|
| Current free tier | None | Product/docs/pricing `404` on 2026-10-31 [S2] |
| New signups | Closed | Announcement says support ends and points to other products [S1] |
| Historical free messages | 10,000/day (third-party summaries; the official pricing page is gone) | **UNVERIFIED** [S3] |
| Historical paid price | $0.20 per 100K messages (single-zone), $0.60 (multi-zone), $0.25/GB storage at launch | Launch post, 2021; not a current offer [S4] |
| Retention / partitions | Not documented on any live page | **UNVERIFIED** |
| SLA | None current | Product withdrawn |

Do not quote the historical free tier as if it were available. The only
verified current fact is that the product pages are gone and the vendor says
support was discontinued.

## 3. Authentication

Historical shape, for migration forensics only:

| Item | Historical | Current |
|---|---|---|
| Kafka | SASL/SCRAM username/password over TLS | Endpoint gone; **UNVERIFIED** |
| REST | Bearer token against the regional REST URL | Endpoint gone; **UNVERIFIED** |
| Credential storage | Vendor console; no platform integration | Not applicable |
| Rotation | Vendor console | Not applicable |

If an old credential is still present in a secret manager, revoke it at the
vendor if the console still allows it, then delete it. Do not copy it into a
fixture, a prompt, a ticket or this repository.

## 4. Bridge and trigger

There is no bridge for Upstash Kafka. The bridge in
`packages/integrations/src/kafka-bridge/` targets the Kafka protocol and a
supported broker; pointing it at a withdrawn endpoint would fail and would
create a false sense of support.

Migration path:

1. Choose a supported provider: self-hosted Apache Kafka, Confluent Cloud
   (trial), Redpanda (trial/self-host) or Aiven (free tier). See the sibling
   pages.
2. Recreate the topic with the partitions and retention the workload needs.
3. Re-point producers. If producers used the Upstash REST API, they need a
   Kafka client or a supported REST proxy; the Upstash REST shape is not a
   standard Kafka API.
4. Deploy the bridge against the new cluster with a read-only principal.
5. Keep the old cluster read-only until the migration window closes, then
   delete it and revoke every credential.

## 5. Read context

None. There is no API to read.

## 6. Framework fit

| Item | Value |
|---|---|
| Module | None; no adapter, no bridge profile |
| Contract | Not applicable |
| Source token | Do not add an `upstash` source; the replacement is `kafka` |
| Tools | None |
| Risk | None; the only action is migration/deletion |
| Sandbox | Not applicable |
| Credential | Revoke and delete; do not migrate the secret |

## 7. Operator checklist

1. Inventory any Upstash Kafka cluster, REST URL, token or SCRAM user still in
   a secret manager or CI variable.
2. Confirm with the vendor whether the cluster is reachable; do not assume the
   free tier still exists.
3. Migrate producers and consumers to a supported provider; do not build a new
   integration on the old endpoint.
4. Deploy the bridge only against the new cluster.
5. Revoke the old credential, delete the old cluster and remove the old
   environment variables.
6. Record the migration date and the replacement provider. There are no
   Upstash-specific `.env` names to add; use the replacement provider's names.

## 8. Acceptance checklist

There is no live acceptance. The migration is complete when:

- [ ] No code, fixture, CI variable or secret manager entry references Upstash
      Kafka.
- [ ] The old cluster is deleted or confirmed unreachable.
- [ ] The replacement bridge passes the [`kafka.md`](kafka.md) §8 checks.
- [ ] One fixture record through the replacement creates one task and dedupes
      on replay.

## 9. Risks

| Risk | Control |
|---|---|
| Building on a withdrawn product | This page; no adapter, no env names |
| Old credential still valid | Inventory, revoke, delete |
| Data loss at shutdown | Migrate producers before deleting; keep a read-only overlap |
| Historical pricing mistaken for current | Mark UNVERIFIED; cite the live 404 check |
| REST producer incompatibility | Rewrite to a Kafka client; do not emulate the dead API |
| Vendor documentation gone | Use the new provider's docs; keep this page as the record |

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Announcing Upstash Workflow and deprecating Upstash Kafka](https://upstash.com/blog/workflow-kafka) (2024-09-06) |
| S2 | Live checks: `https://upstash.com/docs/kafka`, `https://upstash.com/kafka`, `https://upstash.com/pricing/kafka` all return `404` on 2026-10-31 |
| S3 | Third-party free-tier summaries (for example `free-for-life`); **UNVERIFIED**, official page gone |
| S4 | [Upstash launches serverless Kafka](https://upstash.com/blog/serverless-kafka-launch) (2021-11-29; historical pricing) |
