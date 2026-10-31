# Falco connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0 for Falco, Falcosidekick and Falco Talon, verified 2026-10-31; free |
| Auth | Static header or mTLS between Falcosidekick and the bridge; no platform credential |
| Inbound | Falcosidekick webhook output (unsigned) through a signed bridge |
| Read | None; the event payload is the context |
| Writes | None in scope; Talon response actions are `sensitive`/`destructive` |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

Falco is a runtime security engine for Linux and Kubernetes. It evaluates syscalls and Kubernetes audit events against rules and emits alerts. It has no incident API and no read surface; everything the platform knows comes from the alert.

## 1. Role in the agent

Falco answers "what happened at runtime, on which workload, and how severe is the rule". It is the trigger for container escape attempts, unexpected shell execution, sensitive-file reads, crypto-mining and privilege escalation.

Kinds proposed: `runtime_alert` (one rule fired), `k8s_audit_alert` (audit source), `plugin_alert` (a source plugin).

Severity mapping:

| Falco priority | `IncidentSignal.severity` |
|---|---|
| `emergency`, `alert`, `critical` | `critical` |
| `error` | `high` |
| `warning` | `medium` |
| `notice` | `low` |
| `informational`, `debug` | `info` |

The priority is the rule author's severity, not a CVSS score. Keep the mapping literal; do not promote based on namespace or image name.

Fingerprint: `falco:<rule>:<k8s.ns.name>/<k8s.pod.name>:<container.id[:12]>` when Kubernetes fields exist, otherwise `falco:<rule>:<hostname>:<proc.name>`. A repeated alert for the same rule and workload collapses inside the 30-minute dedupe bucket. The event `uuid` is traceability, not identity.

Evidence: rule name, priority, a bounded `output` string, namespace/pod/container, image repository and tag (not the full image id), and the event time. Never the full `output_fields` map.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| Falco | Apache-2.0 | [S1] |
| Falcosidekick | Apache-2.0 | [S2] |
| Falco Talon | Apache-2.0 | [S3] |
| Cost | Free; you pay for the DaemonSet on every node and for the event pipeline | [S1], [S4] |
| SaaS | None required | [S1] |
| Rate limit | No vendor API quota; event volume is bounded by the rules and the outputs' rate limits | [S2] |
| Retention | No vendor retention; events exist only in your pipeline | [S2] |

Cost caveats: Falco runs one pod per node with a kernel driver (eBPF or kmod), so memory and CPU scale with node count. Falcosidekick and Talon add small deployments. High-cardinality rules can generate enormous event volume; tune rules and `minimumpriority` before enabling the connector.

## 3. Auth and least privilege

| Link | Credential | Notes |
|---|---|---|
| Falco to Falcosidekick | None (in-cluster) | Keep the service internal |
| Falcosidekick to bridge | Static `Authorization` header or mTLS | Configured with `customheaders` or `mutualtls` [S5] |
| Bridge to platform | HMAC secret | Generic signed transport |

There is no Falco API token to scope. The least-privilege work is on the receiving side: the bridge accepts only the signed/authenticated path, is not exposed publicly, and has no Kubernetes write permission. The service account used by Falco/Talon must not be cluster-admin; Talon in particular needs only the resources named by its rules.

A static header is a shared secret, not a signature: it authenticates the sender but does not protect the body against modification if TLS terminates incorrectly. Prefer mTLS on the Falcosidekick to bridge hop, and always re-sign with HMAC at the bridge.

## 4. Inbound trigger

Falco has no webhook of its own. Falcosidekick provides a `webhook` output with `address`, `method`, `customheaders`, `mutualtls`, `checkcert` and `minimumpriority` [S5]. It sends the Falco event JSON; it does **not** compute a body signature.

The supported path is therefore:

```
Falco DaemonSet → Falcosidekick (webhook output, static header or mTLS)
                → bridge (trim, redact, normalize)
                → POST /api/webhooks/falco (HMAC over ${timestamp}.${body})
```

| Property | Value |
|---|---|
| Platform endpoint | `POST /api/webhooks/<any>` |
| Signature | `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}` |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Secret floor | 32 characters |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes |

A Falco event with a large `output_fields` map can exceed 64 KiB. The bridge keeps a fixed allowlist (`rule`, `priority`, `output` bounded to 4,000 characters, `k8s.ns.name`, `k8s.pod.name`, `container.id`, `container.image.repository`, `container.image.tag`, `time`) and drops everything else before signing.

Set `minimumpriority` so debug and informational noise never leaves the cluster. `falco` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

## 5. Read-only context

There is no read API. The context bundle is assembled from the event and, optionally, a bounded Kubernetes metadata read:

| Need | Source | Fields used |
|---|---|---|
| Rule and priority | Event payload | `rule`, `priority`, `tags` |
| Workload identity | Event payload | `k8s.ns.name`, `k8s.pod.name`, `container.id`, `container.image.repository`, `container.image.tag` |
| Human-readable summary | Event payload | `output`, redacted and capped at 4,000 characters |
| Pod labels/owner | Kubernetes API (optional) | labels and owner reference only; exact path **UNVERIFIED** in this design |
| Host identity | Event payload | `hostname` (bounded) |

Caps: at most 3 items per bundle, 4,000 characters per excerpt, 256 KiB total, 10 s timeout. No item may include `output_fields` wholesale: it routinely contains `proc.cmdline`, `user.name`, `user.uid`, `fd.name`, environment variables and file paths.

Never fetch: process memory, `/proc` contents, container filesystems, Kubernetes Secrets, or Talon action results that embed command output. If the agent needs the command line to diagnose, it must be redacted (secrets, tokens, URLs with credentials) and bounded; command lines are the highest-risk field in the event.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/falco/` |
| Source enum | Add `falco` to `INCIDENT_SOURCES` before the adapter |
| Tools | `falco.get_alert` (`read_only`, from the stored bounded signal), `falco.get_workload` (`read_only`, optional Kubernetes metadata) |
| Risk bands | No Falco writes. Talon actions (`terminate`, `delete`, `cordon`, `drain`, `labelize`, `networkpolicy`, `exec`) are **`sensitive`**; `delete` and `terminate` are `destructive` if they remove a workload. All are out of scope for v1 |
| Env names | `FALCO_URL`, `FALCO_TOKEN`, `FALCO_WEBHOOK_SECRET` |
| Sandbox | Server-side only. No cluster token, no Talon endpoint, no ability to exec into a pod; egress deny |
| Tests | Payload fixtures for each priority, missing Kubernetes fields, oversize event rejection, redaction seeds for `proc.cmdline`/`env`, dedupe |

`FALCO_URL` is the bridge or Talon endpoint that Falcosidekick posts to; the platform itself never calls it. `FALCO_TOKEN` is the static header value Falcosidekick presents; `FALCO_WEBHOOK_SECRET` signs the platform delivery. Never let the sandbox call `FALCO_URL` directly.

Talon is a separate response engine that consumes Falco events and executes actions [S3], [S6]. It must be disabled by default. Enabling it turns an alert into an automated cluster mutation; every action needs an approval, an audit row and a rollback plan.

## 7. Operator setup checklist

1. Deploy Falco as a DaemonSet with the `falcosecurity/falco` Helm chart; choose the driver (eBPF or kmod) and verify it loads on the nodes.
2. Enable Falcosidekick and configure the `webhook` output with `address`, `minimumpriority` and either `customheaders` or `mutualtls`.
3. Deploy the bridge in-cluster or on a private network segment; it must not be publicly reachable.
4. Set a 32+ character HMAC secret and point the bridge at `https://<host>/api/webhooks/falco`.
5. Add `falco` to `INCIDENT_SOURCES`; deploy the contract before enabling the output.
6. Send one synthetic `Critical` event and one `Debug` event; confirm only the first is forwarded and creates a task.
7. Leave Talon uninstalled unless a separate approved wave adds response actions.
8. Rotate the static header and the HMAC secret once; confirm the old values are rejected.

```dotenv
# Names only. Values are server-side and never documented here.
FALCO_URL=
FALCO_TOKEN=
FALCO_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] Event fixture per priority; severity map exact at `critical`/`error`/`warning`/`notice` boundaries.
- [ ] Oversize event trimmed to the allowlist; no `output_fields` map in the bundle.
- [ ] Redaction of command lines, environment variables, usernames and file paths.
- [ ] Fingerprint stable for repeated rule/workload; `uuid` not in the key.
- [ ] Bridge rejects unsigned, stale and tampered deliveries.

Live (opt-in, local, free):

- [ ] One local `kind` cluster smoke: Falco DaemonSet + Falcosidekick + a synthetic rule.
- [ ] One event reaches the bridge; one task; one deduped resend.
- [ ] Talon not installed; no response action executed. No metered spend.

## 9. Risks and never in model context

- **Never**: `output_fields` wholesale, `proc.cmdline`, `user.name`/`uid`, `fd.name`, environment variables, container image digests, Kubernetes Secrets.
- **Never**: Talon action output (command stdout, pod logs) or the Talon API.
- Runtime events describe live incidents; an attacker who can write a rule output could attempt prompt injection. Treat every field as untrusted.
- Automated response can delete production workloads. It is out of scope and must stay behind a separate approval.
- Namespace and pod names reveal topology; expose only what identifies the workload.
- Falcosidekick has no body signature; a static header plus TLS is not equivalent to HMAC. Re-sign at the bridge.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [falcosecurity/falco](https://github.com/falcosecurity/falco) (Apache-2.0) |
| S2 | [falcosecurity/falcosidekick](https://github.com/falcosecurity/falcosidekick) (Apache-2.0) |
| S3 | [falcosecurity/falco-talon](https://github.com/falcosecurity/falco-talon) (Apache-2.0) |
| S4 | [Falco on Kubernetes](https://falco.org/docs/setup/kubernetes/) |
| S5 | [Falcosidekick webhook output](https://github.com/falcosecurity/falcosidekick/blob/master/docs/outputs/webhook.md) |
| S6 | [Falco Talon actionners](https://falco-talon.github.io/docs/actionners/list/) |
| S7 | [Falco rule fields (priority)](https://falco.org/docs/reference/rules/rule-fields/) |
| S8 | [Falcosidekick payload type](https://github.com/falcosecurity/falcosidekick/blob/master/types/types.go) |
