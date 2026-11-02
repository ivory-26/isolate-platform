# User setup — connect GitHub and your DevSecOps tools from the web

| Field | Value |
|---|---|
| Audience | Customers and customer admins using Isolate |
| Status | Wave 23 target flow; status is updated as lanes land |
| Security model | Provider secrets live on the customer's relay device, never in Isolate's database, browser, logs, model context or sandbox |
| Related | [`spec.md`](spec.md) §4 and §9–10, [`connector-onboarding.md`](connector-onboarding.md), [`connectors/DEVICE.md`](connectors/DEVICE.md) |

## 0. What you need

- An Isolate account with an **owner** or **admin** role in the workspace.
- A machine that can run the Isolate relay (a developer laptop, a VM, or a
  Kubernetes/Docker host). It needs outbound HTTPS to your Isolate URL.
- Your existing vendor account (Sentry, Grafana, Datadog, PagerDuty, Kubernetes,
  New Relic, Honeycomb, Axiom, SigNoz or GitHub).

You do **not** need to:

- create an Isolate-specific OAuth application at every vendor;
- paste provider keys into a deployment `.env`, a worker environment, a Modal
  sandbox or this website;
- edit YAML to connect a repository;
- restart the worker after adding a connector.

Vendor administrators may still have to create a service account, role or API
token **at the vendor**. Isolate guides that step and keeps the result on your
relay. No product can remove a vendor's own permission model.

## 1. Create the workspace

1. Open your Isolate URL and choose **Create account** (or **Sign in** with Google).
2. The first sign-in creates a personal workspace and makes you its owner.
3. Isolate opens **Setup** instead of an empty dashboard. The same checklist stays
   on Home until every step is complete.

## 2. Connect GitHub

1. On **Setup → GitHub**, choose **Install the Isolate GitHub App**.
2. GitHub asks which account/organization and which repositories the App may access.
   Choose **Only select repositories** unless you deliberately want all repositories.
3. Approve the installation. GitHub returns you to Isolate with the installation id.
4. Isolate lists the repositories available to that installation. Select the
   repositories you want Isolate to work on, set a default branch for each, and
   choose **Import**.
5. Isolate verifies that it can read each selected repository. A failure names the
   repository and the missing permission; it never prints a token.

The GitHub App private key stays in the Isolate deployment secret manager. It is
Isolate's platform identity, not your personal provider key. The App installation
is recorded per workspace, so two workspaces can use different accounts.

### What GitHub enables

- **Events:** failed workflow runs, failing check suites and (when enabled) security
  events can open an incident automatically.
- **Context:** Isolate reads the bounded Actions/check/commit/ruleset evidence for
  the incident.
- **Actions:** comments and workflow reruns are scoped writes; pushes and pull
  requests keep their existing payload-bound approval gates.

## 3. Install one relay

The relay is the customer-controlled process that holds provider secrets and reaches
private networks. You install it once per environment; every connector reuses it.

1. On **Setup → Relay**, choose **Register relay** and name it (for example
   `sre-laptop` or `prod-vm`).
2. Isolate shows a one-time install command containing a short-lived device token.
   Copy it and run it on the relay machine:

   ```bash
   curl -fsSL https://<your-isolate-host>/api/install/relay | sh -s -- \
     --server https://<your-isolate-host> \
     --token <one-time-device-token> \
     --name sre-laptop
   ```

   Docker and Helm equivalents use the same token and server URL. For a private
   fork, set `ISOLATE_RELAY_ARCHIVE_URL` on the relay machine to an https tarball
   of your release before running the command. The token is written to the
   relay's private config and is never shown again.
3. The relay starts, prints its loopback pairing URL and begins polling Isolate.
   Isolate flips the relay to **Active** on the first heartbeat. If it stays
   **Offline**, check outbound HTTPS and the server URL; no inbound port is required.
4. The relay stores provider secrets in an encrypted local store
   (`~/.isolate/secrets.json`, mode 0600) keyed from the device token. The plaintext
   key never leaves the machine.

### Relay states

| State | Meaning | Next action |
|---|---|---|
| Pending | Registered, never seen | Run the install command |
| Active | Heartbeating | Connect a source |
| Offline | Missed heartbeats | Start the relay / check network |
| Revoked | Token revoked | Register a new relay |

## 4. Connect a source

1. Open **Integrations** and choose a connector card (Sentry, Grafana, Datadog,
   PagerDuty, Kubernetes, New Relic, Honeycomb, Axiom, SigNoz or GitHub).
2. Isolate shows the connector's three capabilities separately:
   **event source**, **context provider** and **action provider**. You can enable a
   source while leaving its write tools off.
3. Choose the relay that will hold the credential. If none is active, Isolate sends
   you back to Setup → Relay.
4. Choose **Connect securely**. Isolate opens a one-time page on the relay's
   loopback address (`http://127.0.0.1:47821/pair?...`). The page is served by your
   relay, not by Isolate.
5. In that local page, paste the vendor credential (or complete the provider's
   delegated authorization). The relay stores it locally and confirms the pairing.
   The Isolate server receives only the connector id, a display name, an opaque
   credential reference, scopes and non-secret selectors.
6. Isolate performs **one** bounded verification read. On success the card shows
   **Connected**, the verification time and the relay name. On failure it shows a
   fixed reason code and the vendor's scope hint, never the provider's response body.
   Pairing completion records the connection as `pending_validation` until that
   read succeeds; the card says **verification pending** rather than claiming a
   verified connection. The verification route is the remaining step before the
   card can show **Connected**.

### Where to get the credential

Each connector page under [`connectors/`](connectors/) has the exact key-creation
path, minimum scopes and free-tier limits. The relay accepts the credential; it is
never added to the Isolate deployment environment.

## 5. Map resources and enable triggers

1. Map the provider's project/service/environment/cluster/topic to one or more
   imported GitHub repositories and a base branch.
2. Choose the event kinds you want. The safe default is **production** and
   **critical/high** only.
3. Choose the autonomy level:

   | Level | What Isolate may do | Default |
   |---|---|---|
   | A0 Observe | Record and show the event; no agent task | Available |
   | A1 Investigate | Diagnose with read-only evidence, no code change | Planned |
   | A2 Prepare fix | Clone, edit and validate in a Modal sandbox; no push | Default for approved triggers |
   | A3 Propose PR | Push and open a PR through the existing exact-payload approvals | Requires repository policy |

4. Set cooldown/grouping, maximum active incidents and per-incident budgets. Isolate
   applies the tighter of your rule and the platform caps.
5. Save. The rule appears on the integration card and in **Automations** (when the
   rule page is enabled).

## 6. What happens when an event arrives

1. The vendor (or the signed bridge) posts a delivery to Isolate.
2. Isolate verifies the raw body, resolves the workspace and subscription from
   server-side records, normalizes the signal, and computes a stable fingerprint.
3. A duplicate delivery is recorded as `deduplicated`; a resolved event updates the
   incident and does not open a new run.
4. A matching event creates a normal durable task. The webhook response returns
   quickly; it never runs an agent or fetches provider data synchronously.
5. The worker builds a bounded, cited context bundle, clones the mapped repository,
   runs the agent in a Modal sandbox, validates the change and records the outcome.
6. **Inbox** shows the delivery, matched rule, repository, dedupe result and task.
   **Home → Needs you** shows any approval; **Runs** shows the execution timeline
   and execution map.

## 7. Disconnect and rotate

- **Disconnect a source** from its integration card. Isolate marks the metadata row
  revoked and keeps the event/audit history. The relay deletes the local secret on
  its next poll; Isolate cannot delete a secret it never held.
- **Rotate a provider credential** by repeating the pairing flow with a new key and
  then revoking the old record. The old key stays valid at the vendor until you
  revoke it there; Isolate cannot revoke a vendor key it never held.
- **Rotate a relay** by registering a new relay, moving its config to the new token,
  and revoking the old one. Revocation is immediate for new calls; an in-flight call
  may finish or expire.

## 8. Operator checklist (deployment, not per customer)

Set these once in the deployment secret manager. Customers never see or edit them.

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection |
| `NEON_AUTH_*` | Sign-in and session cookies |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` / `_PATH`, `GITHUB_APP_SLUG` | Isolate's own GitHub App identity |
| `GITHUB_APP_STATE_SECRET` | Signs the 10-minute install-state round trip (>= 32 chars) |
| `DEVICE_GATEWAY_ENABLED=true` | Enables relay pairing and connector calls |
| `WEBHOOK_*` secrets | Inbound signature verification |
| `CONNECTOR_*` caps | Free-tier and per-task budgets |

Provider keys (`SENTRY_API_KEY`, `DATADOG_API_KEY`, `GRAFANA_TOKEN`, etc.) are not
deployment settings. They belong to the customer's relay.

## 9. Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| Pairing page does not open | Relay is not running or the loopback port is blocked | Start the relay; confirm `127.0.0.1:47821` is listening |
| Pairing code expired | Codes last 10 minutes and are one-time | Start a new pairing from Isolate |
| Relay stays offline | Outbound HTTPS failed or the token was revoked | Check the relay log; register a new relay if revoked |
| Verification fails with `POLICY_DENIED` | The vendor credential lacks a required scope/role | Follow the connector page's scope hint; never widen the Isolate token |
| Events arrive but no task is created | The rule is disabled, below the severity threshold, outside the environment allowlist, deduped or over the active-incident cap | Open Inbox and read the delivery's status/reason |
| Task runs but evidence is missing | The relay was offline or the provider returned partial data | The run records `truncated`/unavailable; retry later, never invent evidence |
| Approval stays pending | A human decision is required by design | Open Approvals; the payload hash binds the decision |
