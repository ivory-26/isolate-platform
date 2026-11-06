# Deployment — GitHub App operator checklist

| Field | Value |
|---|---|
| Audience | Operators deploying Isolate |
| Scope | The deployment-level GitHub App identity and its fixed failure behavior |
| Status | Wave 24; names and validation checked against `apps/web/src/server/github-install.server.ts` |
| Related | [`USER-SETUP.md`](USER-SETUP.md) §2 and §8, [`connectors/env-reference.md`](connectors/env-reference.md), [`connectors/github.md`](connectors/github.md), [`KNOWN-LIMITS.md`](KNOWN-LIMITS.md) |

This page covers the one GitHub App that the **deployment** owns. Customers do not
create their own App and never see these values. Each workspace installs the same
App and gets its own installation row.

## 1. Secret-manager names

Set these in the deployment secret manager. Never commit them, print them, put them
in a prompt, or return them from a server action.

| Name | Required | Validation / purpose |
|---|---|---|
| `GITHUB_APP_ID` | Yes | Numeric App id |
| `GITHUB_APP_SLUG` | Yes | Public App slug, `^[A-Za-z0-9][A-Za-z0-9-]{0,99}$`; used by the install redirect |
| `GITHUB_APP_PRIVATE_KEY` | One key form | Inline PKCS#8 PEM; must contain an `END PRIVATE KEY` marker |
| `GITHUB_APP_PRIVATE_KEY_PATH` | One key form | Server-side file containing the PKCS#8 PEM; must be readable by the web process |
| `GITHUB_APP_STATE_SECRET` | Yes | At least 32 characters; HMAC key for the ten-minute install state |
| `GITHUB_API_BASE_URL` | No | API origin override; default `https://api.github.com` |
| `GITHUB_APP_INSTALLATION_ID` | No | Legacy single-binding fallback only; not used by the per-workspace install flow |

Use exactly one of `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_PRIVATE_KEY_PATH` for
normal operation. If both are present, the inline key is read first. An inline value
without the end marker, or an unreadable path, counts as not configured.

`GITHUB_APP_SLUG` and `GITHUB_APP_STATE_SECRET` are **deployment-level** values.
They identify and sign for the whole deployment and must never be generated,
stored or rotated per tenant. A second workspace uses the same App and the same
slug; only its installation row is new.

`WEBHOOK_GITHUB_SECRET` is a separate inbound verifier secret used by the webhook
receiver. It is deployment-level too, but it is not part of the App identity and
does not affect the install flow.

## 2. Checklist

1. Create the GitHub App under the deployment owner. Set the **Post installation
   → Setup URL** to `https://<your-isolate-host>/api/github/callback` and enable
   **Redirect on update**. The Setup URL is what receives `installation_id` +
   `state` after install; the OAuth "Callback URL" field is not used by this flow.
   Set the webhook URL to `https://<your-isolate-host>/api/webhooks` only when
   event intake is enabled.
2. Grant only the permissions the connector needs. The current read set and the two
   scoped writes are listed in [`connectors/github.md`](connectors/github.md).
3. Generate a private key in the App settings and place it in the secret manager,
   inline or at a path that only the web process can read.
4. Generate a random state secret of at least 32 characters and store it as
   `GITHUB_APP_STATE_SECRET`. It signs the ten-minute install state; it is not a
   provider key.
5. Set `GITHUB_APP_ID` and `GITHUB_APP_SLUG`. Set `GITHUB_API_BASE_URL` only for a
   non-default API origin.
6. Deploy or restart the web process so the configuration is re-read.
7. Confirm the flow in a non-production environment first. A configured deployment
   sends `GET /api/github/install` to GitHub's App installation page. A missing or
   invalid setting returns the fixed `GITHUB_APP_NOT_CONFIGURED` result.
8. Check the logs for names and fixed codes only. A key fragment, slug value or
   state token in a log is a defect.

## 3. Fixed behavior when configuration is missing

The install flow fails closed. It never starts a partial redirect, never falls back
to another App, and never surfaces a path or key fragment.

| Condition | Result |
|---|---|
| Any required App value missing or invalid | `GITHUB_APP_NOT_CONFIGURED`, HTTP 503, message "The GitHub App is not configured for this deployment." |
| Private key inline but missing the end marker | `GITHUB_APP_NOT_CONFIGURED` |
| Private-key path unreadable or not a PEM | `GITHUB_APP_NOT_CONFIGURED` |
| State secret shorter than 32 characters | `GITHUB_APP_NOT_CONFIGURED` |
| State expired, tampered or bound to another user/workspace | Install callback refused; start a new install |
| No installation for the workspace yet | `GITHUB_INSTALLATION_REQUIRED`, HTTP 409 |

A `503` here is configuration, not a GitHub outage. Fix the deployment setting; do
not retry in a loop and do not weaken validation.

## 4. Rotation

- **State secret:** rotate it in the secret manager and restart. Only install states
  issued in the previous ten minutes become invalid; existing installations are
  unaffected. This is a deployment-wide operation, not a tenant action.
- **Private key:** generate the replacement in GitHub, store it, deploy, then
  revoke the old key in GitHub. Existing installation tokens are short-lived and
  expire on their own.
- **Slug:** changing it changes the public install URL. It is still one
  deployment-level value; do not create per-tenant Apps to avoid a slug change.

## 5. What not to do

- Do not put any App value in a client bundle, a task prompt, a relay config, a
  fixture, a screenshot or an issue.
- Do not provision a separate GitHub App per customer. The product model is one
  deployment App with per-workspace installations.
- Do not describe GitHub as connected when the App settings are missing. The
  fixed error is the correct state.
