# DefectDojo connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | BSD-3-Clause (open-source edition), verified 2026-10-31; self-hosted |
| Auth | `Authorization: Token <api-key>` for API v2 |
| Inbound | Notification webhooks are experimental and unsigned; treat them as hints and re-fetch |
| Read | API v2 findings, tests, engagements and products |
| Writes | None in scope; finding status changes are proposed as `scoped_write` |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

DefectDojo is an open-source vulnerability management and correlation platform. It does not scan anything itself: scanners import results into it, and humans triage the resulting findings. The connector's value is the triage state and the product/engagement context, not raw scanner output.

## 1. Role in the agent

DefectDojo answers "is this finding already tracked, for which asset, and what did the team decide". It is the right trigger when a new finding crosses the organisation's severity threshold and the team uses DefectDojo as the system of record. It is not a scanner and must not be used to import arbitrary files from a task.

Kinds proposed: `finding_created` (a new finding for an in-scope asset), `finding_reopened`, `engagement_added` (only if the workflow wants it).

Severity mapping is direct:

| DefectDojo severity | `IncidentSignal.severity` |
|---|---|
| `Critical` | `critical` |
| `High` | `high` |
| `Medium` | `medium` |
| `Low` | `low` |
| `Info` | `info` |

Fingerprint: `defectdojo:<productId>:<findingId>`. A finding keeps its id across reimports, so a reimported duplicate does not create a second task. The test id and import id are traceability, not identity.

Evidence: finding title, severity, component name/version, file path and line, CWE, CVE/OSV ids, active/verified/duplicate flags, and the product/engagement names. Do not include the full description, request/response pairs, or attachments.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | BSD-3-Clause for the open-source edition | [S1] |
| Editions | Open-source and Pro editions exist; this page covers the open-source API | [S2] |
| Cost | Free; you pay for the application containers, database, Redis and storage | [S1], [S2] |
| SaaS | Not required; self-hosted via containers or Helm | [S1] |
| API rate limit | No API quota is documented for a self-hosted instance — **UNVERIFIED** as a number | [S3] |
| Retention | No vendor retention; findings persist until deleted by an operator | [S3] |
| Webhooks | Marked **experimental** in the open-source documentation; behaviour may change | [S4] |

Self-host cost caveats: a Celery worker and Redis are part of the normal deployment, imports can be CPU-heavy, and deduplication runs inside an asset. Database growth is driven by imported scan files, so retention is an operator policy, not a product limit.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| Read | API v2 token | Sent as `Authorization: Token <key>` [S5] |
| Write (not in scope) | Separate token | Never reuse the read token |
| Inbound | None | The webhook has no signature; no credential is presented by DefectDojo |

The token inherits the user's permissions. Create a dedicated service user with read access to the in-scope products only; do not use a superuser token. Access control is applied at the Organization (API: `product_type`) and Asset (API: `product`) level, not at engagements or tests [S6].

Because the inbound webhook is unsigned, the receiver must never trust its body as the trigger. Use it to learn that something changed, then read the canonical finding through the API with the read token. That read is also the authorization check: a finding outside the token's products returns `404`.

Rotation: create a second token for the service user, deploy, verify, revoke the first. There is no webhook secret to rotate on the DefectDojo side.

## 4. Inbound trigger

DefectDojo's notification webhooks are **experimental** and carry no HMAC or signature header. The documented request headers are descriptive only [S4]:

| Header | Meaning |
|---|---|
| `X-DefectDojo-Event` | Event name, for example `scan_added` |
| `X-DefectDojo-Instance` | Base URL of the sending instance |
| `User-Agent` | `DefectDojo-<version>` |

Supported events include `product_type_added`, `product_added`, `engagement_added`, `test_added`, `scan_added` and `ping`. The payload embeds a `user` object with `email`, `first_name` and `last_name`, which is PII and must never reach a task or a model [S4].

Design rule: **no task from the webhook body**. The webhook is a hint. The adapter (or bridge) extracts only the event name and the finding/test id, then fetches the finding through the API. If the fetch fails, no task is created.

The webhook also cannot be accepted by the current receiver directly, because its header is neither `x-hub-signature-256` nor the generic `x-isolate-signature`. Two options:

1. A dedicated mode selected by `x-defectdojo-event`, which must not accept the body as an `IncidentSignal`; it only triggers a re-fetch. This is a transport change and needs a contract commit first.
2. A bridge that verifies network placement (private ingress, allowlist), re-fetches, and signs the normalized signal with `WEBHOOK_SIGNING_SECRET` (`${timestamp}.${body}`, ±300 s, 64 KiB).

Webhook endpoint state transitions are driven by HTTP responses; an inactive endpoint is not retried [S4]. The platform must therefore reconcile by polling the API for new findings if the webhook is disabled, rather than assuming it always fires. Delivery retry counts are not documented — **UNVERIFIED**.

`defectdojo` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter.

## 5. Read-only context

| Need | Endpoint | Fields used | Source |
|---|---|---|---|
| Finding | `GET /api/v2/findings/{id}/` | title, severity, component_name, component_version, file_path, line, cwe, vuln_ids, active, verified, duplicate, false_p, date | [S5] |
| Findings for a test | `GET /api/v2/findings/?test={id}` | Same, filtered | [S5] |
| Test | `GET /api/v2/tests/{id}/` | scan_type, target_start/end, environment, test_title | [S5] |
| Engagement | `GET /api/v2/engagements/{id}/` | name, status, engagement_type, product | [S5] |
| Product (Asset) | `GET /api/v2/products/{id}/` | name, product_type, description (bounded) | [S5] |

Fixed plan: finding (1) → test (1) → product (1); engagement only if the test does not already name it. Pagination is `limit`/`offset`; the default page is 25 results [S5]. Caps: 4 calls, one page each, 100 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout.

Never read: request/response pairs, attachments, full descriptions, the `user` object, notes, or the full import history. The finding's `description` can contain payloads or secrets; take a redacted, bounded excerpt only when the task needs it.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/defectdojo/` |
| Source enum | Add `defectdojo` to `INCIDENT_SOURCES` before the adapter |
| Tools | `defectdojo.get_finding` (`read_only`), `defectdojo.list_test_findings` (`read_only`), `defectdojo.set_finding_status` (`scoped_write`, proposed) |
| Risk bands | Status change is `scoped_write` and audited; risk acceptance is `sensitive` (human decision); deleting a finding, test or product is `destructive` and out of scope |
| Env names | `DEFECTDOJO_URL`, `DEFECTDOJO_TOKEN`, `DEFECTDOJO_WEBHOOK_SECRET` |
| Sandbox | Server-side only. The token never enters the sandbox; no file upload or import from the sandbox; egress deny |
| Tests | Fake API, unsigned-hint path (no task without re-fetch), severity map, dedupe, `404` on foreign product, `429`, redaction of `user` |

`DEFECTDOJO_WEBHOOK_SECRET` exists only for the bridge; DefectDojo itself has no signing secret. The read token is never reused for status changes.

## 7. Operator setup checklist

1. Confirm the edition and version; webhooks are experimental and event names may differ between releases.
2. Create a service user with read access to the in-scope Organizations/Assets; issue an API v2 token.
3. Create a notification webhook in DefectDojo pointing at the bridge (private network or allowlisted ingress).
4. Deploy the bridge; it re-fetches the finding and signs the normalized signal with `WEBHOOK_SIGNING_SECRET`.
5. Add `defectdojo` to `INCIDENT_SOURCES`; deploy the contract before enabling task creation.
6. Map the product/asset to the bound repository; the payload cannot choose a tenant.
7. Send a `ping`, then create a disposable finding; confirm no task from the ping and one task from the finding.
8. Disable the webhook and confirm reconciliation polling still discovers the finding.

```dotenv
# Names only. Values are server-side and never documented here.
DEFECTDOJO_URL=
DEFECTDOJO_TOKEN=
DEFECTDOJO_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Unsigned webhook payload alone creates **no** task; a re-fetch is mandatory.
- [ ] `ping` is ignored; `scan_added`/`test_added` map to one finding signal.
- [ ] `user.email`, names, request/response and attachments never appear in a bundle.
- [ ] Severity map, duplicate/false-positive flags, and fingerprint stability across reimport.
- [ ] Foreign product returns `404`; caps and `truncated` honored.

Live (opt-in, local, free):

- [ ] One local container smoke with a disposable finding; webhook to bridge to signed delivery.
- [ ] One re-fetch; one task; one deduped resend.
- [ ] No metered spend; record container images and database size.

## 9. Risks and never in model context

- **Never**: API tokens, the `user` object (email, first/last name), request/response pairs, attachments, notes, full descriptions.
- **Never**: raw imported scan files. DefectDojo may store them; the connector does not read them.
- The webhook is unsigned and can be forged; it is only a hint, and the API read is the trust boundary.
- Experimental webhooks can change shape or be disabled without notice; reconciliation is required.
- Finding text and component names are untrusted data and may contain injected instructions.
- Cross-asset deduplication does not exist; the same CVE may appear in several assets. Fingerprint per product to avoid merging unrelated tasks.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [DefectDojo/django-DefectDojo](https://github.com/DefectDojo/django-DefectDojo) (BSD-3-Clause) |
| S2 | [DefectDojo documentation](https://docs.defectdojo.com/) |
| S3 | [Import from API](https://docs.defectdojo.com/import_data/import_scan_files/api_pipeline_modelling/) |
| S4 | [Notification webhooks](https://docs.defectdojo.com/automation/api/notification_webhooks/) |
| S5 | [DefectDojo API v2](https://docs.defectdojo.com/automation/api/api-v2-docs/) |
| S6 | [Asset hierarchy](https://github.com/DefectDojo/django-DefectDojo/blob/master/docs/content/asset_modelling/OS_hierarchy/OS__asset_hierarchy.md) |
| S7 | [About notifications](https://docs.defectdojo.com/admin/notifications/about_notifications/) |
