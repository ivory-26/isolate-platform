# Wazuh connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | GPL-2.0 for most of the code, AGPL-3.0 for the engine, verified 2026-10-31; self-hosted |
| Auth | JWT from `POST /security/user/authenticate` using HTTP basic credentials |
| Inbound | Integrator daemon with a `custom-*` script (no native generic webhook) |
| Read | Manager API agents and rules only; no raw alert fetch in v1 |
| Writes | None in scope; active response and agent actions are `sensitive`/`destructive` |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

Wazuh is an open-source SIEM/XDR platform: agents and agentless devices send events, decoders parse them, rules match them, and the manager generates alerts. It is not a SaaS and has no cloud control plane in the self-hosted deployment.

## 1. Role in the agent

Wazuh answers "which host or agent triggered which detection rule, at what level, and how often". It is a host-security trigger (intrusion, file integrity, malware, authentication abuse), not a code-vulnerability scanner.

Kinds proposed: `security_alert` (a rule fired), `agent_disconnected`, `integrity_change` (FIM), `authentication_failure` (only at high levels).

Severity mapping (platform mapping, not a vendor field):

| Wazuh `rule.level` | `IncidentSignal.severity` |
|---|---|
| 15–16 | `critical` |
| 12–14 | `high` |
| 8–11 | `medium` |
| 3–7 | `low` |
| 0–2 | `info` |

The default alert threshold is level 3; level 12 is the default email threshold [S4]. A rule level is a detection-confidence signal, not a CVSS score. Do not promote a level 10 event to `critical` because the host is production; keep the mapping and let the trigger policy decide.

Fingerprint: `wazuh:<agent.id>:<rule.id>:<sha256(location)[:16]>`. The alert id changes per event and would create a task per repetition, so it is traceability only. The location hash keeps a username or file path out of the task provenance.

Evidence: rule id, level, description, agent id/name, decoder, and a bounded location. Never the raw event.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License (most code) | GNU GPL version 2 | [S1] |
| License (engine) | GNU AGPL version 3 | [S1] |
| License (shared libs) | GPL-2.0-only OR AGPL-3.0-or-later | [S1] |
| Cost | Free; you pay for manager, indexer, dashboard and storage hosts | [S1], [S2] |
| SaaS | None required; all components are self-hosted | [S2] |
| API limit | No published API quota for the manager API — **UNVERIFIED** | [S2] |
| Alert retention | Indexer lifecycle policy is operator-configured; no fixed default was verified — **UNVERIFIED** | [S3] |

Copyleft matters: if you distribute a modified Wazuh or a derivative work, the GPL/AGPL obligations apply. Running it unmodified as a self-hosted service does not create a distribution obligation, but this is not legal advice. The integration script you write is a separate program that talks over HTTP; keep it that way rather than linking proprietary code into the manager.

Cost caveats: the indexer is the expensive component (CPU, RAM, disk); alert volume drives storage; the manager API is not an analytics store. Do not turn the connector into a bulk alert exporter.

## 3. Auth and least privilege

| Step | Detail |
|---|---|
| Login | `POST https://<manager>:55000/security/user/authenticate?raw=true` with HTTP basic credentials |
| Token | JWT, default lifetime **900 s** [S9] |
| Subsequent calls | `Authorization: Bearer <jwt>` |
| Cluster | The API listens only on the master node [S2] |
| Service account | A dedicated API user with read-only RBAC; never the default `admin` |

The manager generates the `wazuh` and `wazuh-internal-client` passwords at install and stores them in a root-only credentials file [S2]. That file is never read, copied or printed by this connector. Create a dedicated read-only API user and role for the adapter, and rotate its password on the organisation's schedule.

JWT handling: mint on demand, cache until `expires_at − 60 s`, never log the token, never put it in a URL. A `401` triggers one re-authentication, not a loop.

Least privilege: read access to agents and rules only. No active-response, no agent restart, no RBAC or cluster administration.

## 4. Inbound trigger

Wazuh's integrator forwards alerts, but it has **no generic HTTP webhook type**. Supported integration names are `slack`, `pagerduty`, `virustotal`, `shuffle`, `maltiverse` and `custom-*`; a custom integration runs a script from `/var/ossec/integrations` [S5], [S6].

So the trigger is a small **custom integration script** that:

1. Receives one alert as JSON (`<alert_format>json</alert_format>`).
2. Applies a server-side filter (`<rule_id>`, `<level>`, `<group>`) so only high-value rules reach the platform; `max_log` is bounded 165–1024 [S5].
3. Drops `full_log`, `data`, command lines, usernames and IPs **before** signing.
4. Builds a strict `IncidentSignal` and posts it with `x-isolate-timestamp` and `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}`, ±300 s, 64 KiB.

Wazuh alert JSON frequently exceeds 64 KiB once `full_log` is included; stripping it is mandatory, not optional. If the signal still does not fit, send only the metadata and no location. The `wazuh` value must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

Dedupe is `(organization, source, fingerprint)` for 30 minutes; a flapping rule on the same agent and location collapses to one task. The alert id, if included, belongs in `links` (for example a dashboard deep link), not in the fingerprint.

A webhook receiver is not an execution path: the script cannot approve, isolate or restart anything.

## 5. Read-only context

| Need | Endpoint | Fields used | Source |
|---|---|---|---|
| Agent status | `GET /agents?select=id,name,status,version,lastKeepAlive,group` | id, name, status, version, last keep-alive, group | [S2] |
| One agent | `GET /agents/{agent_id}` | same, plus manager host and node | [S2] |
| Rule definition | `GET /rules?rule_ids={id}` (exact query parameter **UNVERIFIED**) | id, level, description, groups, filename | [S2] |
| Alert body | **Not fetched in v1** | `wazuh-alerts-*` lives in the indexer and contains raw events | [S3] |

The manager API does not expose an alerts endpoint; alerts are stored in `alerts.log`/`alerts.json` and forwarded to the indexer [S4], [S3]. Querying the indexer is technically possible but returns `full_log`, `data.srcip`, `data.srcuser`, command lines and file paths. V1 therefore does **not** fetch alert bodies at all: the context bundle is the notification payload's allowlisted fields plus the rule definition and agent status.

Fixed plan: agent (1) + rule (1) = 2 calls per bundle. Caps: 100 items, 4,000 characters per excerpt, 256 KiB total, 10 s timeout. A missing agent or rule sets `truncated: true`.

If a future wave adds indexer search, it must be a fixed query with an allowlist projection (`rule.id`, `rule.level`, `rule.description`, `agent.id`, `timestamp`), a narrow time window, `_source` filtering, and no `full_log`, `data`, `predecoder` or `syscheck` fields. It must not be a free-text search.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/wazuh/` |
| Source enum | Add `wazuh` to `INCIDENT_SOURCES` before the adapter |
| Tools | `wazuh.get_agent` (`read_only`), `wazuh.get_rule` (`read_only`), `wazuh.list_agents` (`read_only`) |
| Risk bands | Active response, agent restart and agent isolation are `sensitive` (approval); deleting an agent is `destructive`. None is in scope |
| Env names | `WAZUH_URL`, `WAZUH_USER`, `WAZUH_PASSWORD`, `WAZUH_WEBHOOK_SECRET` |
| Sandbox | Server-side only. No manager credential in the sandbox; no ability to run `wazuh-control`, `agent_control` or active-response commands |
| Tests | Fake API with JWT expiry, rule-level mapping, location hashing, 64 KiB oversize rejection, `401` re-auth once, tenant isolation |

`WAZUH_URL` is the manager API origin on port 55000 with a trusted certificate. `WAZUH_USER`/`WAZUH_PASSWORD` are server-only; the JWT is derived and never persisted in the task. `WAZUH_WEBHOOK_SECRET` belongs to the integration script.

## 7. Operator setup checklist

1. Confirm the deployment model (all-in-one or distributed) and that the manager API is reachable only from the connector network.
2. Create a read-only API user and role; do not use `admin`.
3. Install the custom integration script in `/var/ossec/integrations` with root ownership and no world-write bit.
4. Configure `<integration>` with `custom-<name>`, `<alert_format>json</alert_format>`, and filters for the rules and levels in scope.
5. Set the HMAC secret on the script and the platform; point it at `https://<host>/api/webhooks/wazuh`.
6. Add `wazuh` to `INCIDENT_SOURCES`; deploy the contract before enabling the script.
7. Send a synthetic level 12 alert and a level 5 alert; confirm only the in-scope one creates a task.
8. Rotate the API password and the HMAC secret once; confirm the old credentials stop working.

```dotenv
# Names only. Values are server-side and never documented here.
WAZUH_URL=
WAZUH_USER=
WAZUH_PASSWORD=
WAZUH_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Integration-script unit tests: level filter, PII stripping, oversize rejection, signature vector.
- [ ] JWT cache and one re-auth on `401`; no token in logs.
- [ ] Severity map at boundaries 2/3, 7/8, 11/12, 14/15.
- [ ] Fingerprint stable for repeated alerts; alert id not in the key.
- [ ] Reader caps and `truncated` on missing agent/rule.

Live (opt-in, local, free):

- [ ] One local container smoke (manager + indexer + dashboard is heavy; a manager-only lab is acceptable for the API).
- [ ] One synthetic signed delivery; one task; one deduped resend.
- [ ] No metered spend; record container images and memory.

## 9. Risks and never in model context

- **Never**: `full_log`, `data` (source IP, username, command line), `syscheck` entries, agent keys, API passwords, JWTs, the credentials file.
- **Never**: raw `alerts.json` lines or indexer hits. V1 does not fetch them.
- Agent names and groups can reveal topology; expose only the name needed to identify the host.
- Rule descriptions and locations are provider text; they can contain injected instructions.
- A level is not a severity score; remapping it per environment makes incidents incomparable.
- The integrator script runs on the manager with elevated privileges; keep it minimal and auditable.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [Wazuh LICENSE](https://github.com/wazuh/wazuh/blob/main/LICENSE) (GPL-2.0, AGPL-3.0 engine) |
| S2 | [Wazuh manager API getting started](https://github.com/wazuh/wazuh-documentation/blob/main/source/user-manual/api/getting-started.rst) |
| S3 | [Wazuh indexer API use cases](https://documentation.wazuh.com/current/user-manual/indexer-api/use-case.html) |
| S4 | [Alert management](https://github.com/wazuh/wazuh-documentation/blob/main/source/user-manual/manager/alert-management.rst) |
| S5 | [Integrator configuration reference](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/integration.html) |
| S6 | [External API integration](https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html) |
| S7 | [Rules classification](https://github.com/wazuh/wazuh-documentation/blob/main/source/user-manual/ruleset/rules/rules-classification.rst) |
| S8 | [Agent enrollment](https://documentation.wazuh.com/current/user-manual/agent/agent-enrollment/) |
| S9 | [Wazuh API reference](https://documentation.wazuh.com/current/user-manual/api/reference.html) |
