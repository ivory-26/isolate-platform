# OpenSSF Scorecard connector

| Field | Value |
|---|---|
| Status | **Design-only — no code** |
| Code | none — no code exists in this repository |
| License/free | Apache-2.0 for the CLI and the GitHub Action, verified 2026-10-31; free |
| Auth | None for the public API; a GitHub token for CLI scans of private repositories |
| Inbound | None native; GitHub Actions or scheduled CI through a signed bridge |
| Read | Public results API, or the JSON/SARIF artifact from a run |
| Writes | None in scope |
| Design reference | [`docs/devsecops-connectors.md`](../devsecops-connectors.md) §2, §4, §5 |

OpenSSF Scorecard assesses a repository's security practices (branch protection, code review, pinned dependencies, token permissions and similar) and produces a score per check. It is an assessment tool, not a scanner and not an incident system.

## 1. Role in the agent

Scorecard answers "which supply-chain practice in this repository is weak, and what is the evidence". It is a good trigger for repository-hardening work and a context source when a task touches CI permissions, branch protection or dependency pinning.

Kinds proposed: `scorecard_regression` (a check score dropped), `scorecard_threshold` (a check is below policy), `scorecard_new_repository` (first scan).

Severity is a platform policy, because Scorecard has no severity field. The checks documentation assigns each check a risk level (`High`, `Medium` or `Low`, with `Critical` used for the most serious checks) [S5]. Proposed mapping:

| Check risk | Score ≤ 3 | Score 4–6 | Score 7–8 | Score 9–10 |
|---|---|---|---|---|
| Critical / High | `high` | `medium` | `low` | `info` |
| Medium | `medium` | `low` | `info` | `info` |
| Low | `low` | `info` | `info` | `info` |

Only a score **drop** or a below-threshold score should create a task; a stable mid-range score is not an incident. State the previous score and the run date in the summary so the agent can tell a regression from a long-standing gap.

Fingerprint: `scorecard:<platform>/<owner>/<repo>:<checkName>`. The run date and score are evidence, not identity. A regression and a threshold breach for the same check share a fingerprint inside the dedupe window and collapse.

## 2. Free/OSS licensing and quotas

| Item | Fact | Source |
|---|---|---|
| License | Apache-2.0 | [S1] |
| Cost | Free; no paid tier | [S1] |
| Public API | `https://api.scorecard.dev`, free, CDN-cached | [S1], [S2] |
| CLI | Free; GitHub API rate limits apply and a token raises them | [S1] |
| API coverage | Weekly public scans omit `CI-Tests`, `Contributors` and `Dependency-Update-Tool` because of API cost | [S1] |
| Retention | Results are published weekly; the API serves cached, purged results | [S1] |

Cost caveats: the CLI calls the GitHub API many times per check; unauthenticated runs hit rate limits quickly. A `GITHUB_AUTH_TOKEN` is required for private repositories and strongly recommended for public ones. The token is a GitHub credential and must be a read-only, short-lived token in CI — never a personal token with write scopes.

The API is a convenience, not an SLA: a missing project simply has no published result, and the connector must fall back to a CLI run or mark the bundle `truncated`.

## 3. Auth and least privilege

| Mode | Credential | Notes |
|---|---|---|
| Public API | None | Read-only public results |
| CLI | `GITHUB_AUTH_TOKEN` | Read-only access to the repository; `read_api` is enough for GitLab [S1] |
| GitHub Action | `GITHUB_TOKEN` | `security-events: write` only if uploading SARIF; `id-token: write` only for `publish_results` [S3] |
| Bridge | HMAC secret | Generic signed transport |

The Scorecard token is a GitHub credential, not a Scorecard credential. Scope it to the repositories in scope and to read-only permissions. Never grant `repo` write, `admin:org` or workflow permissions. For the Action, the default `GITHUB_TOKEN` with `security-events: write` and `id-token: write` is sufficient; do not add a PAT.

Rotation follows GitHub token policy: short-lived tokens in CI, no long-lived PAT stored in the connector. The bridge HMAC secret rotates independently.

## 4. Inbound trigger

Scorecard has **no webhook**. The trigger is a CI run, normally the Scorecard GitHub Action on a schedule or repository change, or a CLI run in another CI system [S1], [S3].

The Action writes `results.json` or `results.sarif` (`results_format: json | sarif | intoto`) and optionally publishes to the API with `publish_results: true` [S3]. A bridge compares the current run with the previous stored result and emits a signal only for a regression or a threshold breach:

| Property | Value |
|---|---|
| Endpoint | `POST /api/webhooks/<any>` |
| Signature | `x-isolate-signature: sha256=<hex>` over `${timestamp}.${rawBody}` |
| Freshness | ±300 s |
| Body cap | 64 KiB |
| Dedupe | `(organization, source, fingerprint)` for 30 minutes |

The comparison state (previous score per check) belongs to the bridge or a platform table keyed by `(organization, repository, check)`; it is not in the signed body. Without it, every scheduled run would look like a new incident.

The Action can also upload SARIF to GitHub code scanning; that is a separate delivery channel and does not replace the platform signal.

`scorecard` must be added to `INCIDENT_SOURCES` in a contract commit before the adapter exists.

## 5. Read-only context

| Need | Endpoint / artifact | Fields used | Source |
|---|---|---|---|
| Published result | `GET https://api.scorecard.dev/projects/...` (exact result path **UNVERIFIED**) | `date`, `repo`, `scorecard`, `score`, `checks[]` | [S1], [S2] |
| Check detail | Same, `checks[]` | `name`, `score`, `reason`, `details`, `documentation` | [S1] |
| CLI result | `scorecard --repo=... --format=json` | Same JSON shape | [S1] |
| Action result | `results.sarif` | Rule id, level, message, location | [S3] |

The exact JSON path for a project result is **UNVERIFIED**: the public badge URL has the form `/projects/{platform}/{owner}/{repo}/badge`, and the API base is documented, but the non-badge path was not extracted from a schema page [S1]. Confirm it against a live public project before coding; do not guess a path in production.

Fixed plan: one API call or one stored artifact per bundle. Caps: 50 items (one per check), 4,000 characters per excerpt, 256 KiB total, 10 s timeout. A missing check in the weekly API (the three omitted checks) sets `truncated: true` and the reason.

Never read: the repository contents, workflow logs, contributor identities or commit history. Scorecard's `reason` and `details` are derived text; they can name users or files, so bound and redact them.

## 6. Framework fit

| Item | Proposal |
|---|---|
| Module | `packages/integrations/src/scorecard/` |
| Source enum | Add `scorecard` to `INCIDENT_SOURCES` before the adapter |
| Tools | `scorecard.get_result` (`read_only`), `scorecard.get_check` (`read_only`), `scorecard.request_scan` (`scoped_write`, optional) |
| Risk bands | No provider writes. A scan trigger is `scoped_write` because it spends GitHub API quota and CI time; deleting results is out of scope |
| Env names | `SCORECARD_URL`, `SCORECARD_TOKEN`, `SCORECARD_WEBHOOK_SECRET` |
| Sandbox | Server-side only. The GitHub token never enters the sandbox; no CLI execution in the sandbox; egress deny |
| Tests | API fixtures, missing checks, score regression vs stable score, threshold policy, `404` project, tenant isolation |

`SCORECARD_URL` defaults to `https://api.scorecard.dev`; `SCORECARD_TOKEN` is the GitHub token used only by a server-side CLI fallback, not by the API. `SCORECARD_WEBHOOK_SECRET` belongs to the bridge.

## 7. Operator setup checklist

1. Decide whether the source is the public API, the GitHub Action, or a CLI run. Public repositories can use the API; private ones need the Action or CLI with a token.
2. For the Action, set `results_file`, `results_format: sarif`, and `publish_results: true` only if you accept publication [S3].
3. For the CLI, use a read-only GitHub token and pin the Scorecard version (Docker image or release binary) [S1].
4. Deploy the bridge with a 32+ character HMAC secret; point it at `https://<host>/api/webhooks/scorecard`.
5. Store the previous score per check; the bridge needs it to detect a regression.
6. Add `scorecard` to `INCIDENT_SOURCES`; deploy the contract before enabling the bridge.
7. Run twice with an unchanged repository; confirm no task. Change a check score; confirm one task.
8. Confirm the token is read-only and the Action has no write permission beyond SARIF upload.

```dotenv
# Names only. Values are server-side and never documented here.
SCORECARD_URL=
SCORECARD_TOKEN=
SCORECARD_WEBHOOK_SECRET=
```

## 8. Acceptance checklist

Offline:

- [ ] API fixture with all checks, and one with the three weekly-omitted checks absent.
- [ ] Regression detection: same score creates nothing; a drop creates one task.
- [ ] Threshold policy table at scores 3/4, 6/7, 8/9.
- [ ] Missing project returns a partial bundle, not a false "perfect score".
- [ ] No token in any bundle, log or error; tenant isolation.

Live (opt-in, free):

- [ ] One API read for a public repository; one synthetic signed delivery.
- [ ] One CLI run against a disposable public repository, if the CLI path is implemented.
- [ ] No metered spend; record API calls and runtime.

## 9. Risks and never in model context

- **Never**: the GitHub token, the Action's OIDC token, private repository contents, workflow logs, contributor identities.
- **Never**: an absent check treated as score 10. Missing data is `truncated`, not a pass.
- A score is not a vulnerability. A high score does not mean the code is safe, and a low score is not an exploit.
- Scorecard checks call GitHub APIs; rate limits and API errors can change a score between runs. Record the run date and version.
- Check `reason` and `details` can name users or files; bound and redact them.
- Publishing results with `publish_results: true` makes the score public; confirm this is acceptable before enabling it.

## 10. Sources

All accessed 2026-10-31.

| ID | Source |
|---|---|
| S1 | [ossf/scorecard](https://github.com/ossf/scorecard) (Apache-2.0) |
| S2 | [Scorecard API](https://api.scorecard.dev) |
| S3 | [ossf/scorecard-action](https://github.com/ossf/scorecard-action) |
| S4 | [Scorecard viewer](https://scorecard.dev/) |
| S5 | [Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md) |
