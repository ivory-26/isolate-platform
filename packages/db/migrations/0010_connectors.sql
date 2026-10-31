-- Per-organization connector credentials and free-tier ledger (wave 16).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0009;
-- migration application belongs to the coordinator, never to repositories.
--
-- Each row is one user-owned connection for one organization. The secret is
-- stored only as an AES-256-GCM envelope: `encrypted_payload` packs
-- nonce || tag || ciphertext and `wrapped_dek` is the DEK sealed under the
-- operator KEK (`CONNECTOR_CREDENTIAL_KEY`). Neither key nor plaintext is in
-- the database, and the repository's summary select list excludes both bytea
-- columns. The AAD binds organization, connector, display name and key
-- version, so a moved ciphertext fails authentication.
--
-- Revocation keeps the row for provenance and zeroes both bytea columns, so
-- they are intentionally allowed to be empty. `connector_usage_ledger` is the
-- durable free-tier counter: `consume` increments and refuses an overage in
-- one statement (`WHERE request_count < limit`), never in application memory.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block would be intentionally a single line. This migration has none.

-- ---------------------------------------------------------------------------
-- Connector credentials ------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connector_credentials (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	display_name text NOT NULL
		CHECK (char_length(display_name) BETWEEN 1 AND 100),
	auth_kind text NOT NULL CHECK (auth_kind IN (
		'api_key',
		'oauth_client_credentials',
		'oauth_authorization_code',
		'service_account_json',
		'bot_token',
		'self_host_url_token'
	)),
	encrypted_payload bytea NOT NULL,
	wrapped_dek bytea NOT NULL,
	key_version integer NOT NULL DEFAULT 1 CHECK (key_version >= 1),
	scopes text[] NOT NULL DEFAULT '{}',
	status text NOT NULL DEFAULT 'pending_validation' CHECK (status IN (
		'pending_validation',
		'active',
		'invalid',
		'revoked'
	)),
	free_tier_profile jsonb NOT NULL DEFAULT '{}'::jsonb
		CHECK (jsonb_typeof(free_tier_profile) = 'object'),
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb
		CHECK (jsonb_typeof(metadata) = 'object'),
	last_validated_at timestamptz NULL,
	last_used_at timestamptz NULL,
	created_by uuid NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, connector_id, display_name)
);

-- Operator listing and active-credential resolution for one tenant.
CREATE INDEX IF NOT EXISTS connector_credentials_org_connector_status_idx
	ON connector_credentials (organization_id, connector_id, status);

-- ---------------------------------------------------------------------------
-- Connector usage ledger -----------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connector_usage_ledger (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	credential_id uuid NOT NULL
		REFERENCES connector_credentials(id) ON DELETE CASCADE,
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	period date NOT NULL,
	request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
	error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (credential_id, period)
);

-- Per-organization connector reporting for one period.
CREATE INDEX IF NOT EXISTS connector_usage_ledger_org_connector_period_idx
	ON connector_usage_ledger (organization_id, connector_id, period);
