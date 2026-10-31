-- Per-organization connector metadata, device registry and free-tier ledger.
--
-- SECURITY: user provider keys are NEVER stored on the server. The secret lives
-- on the user's device (OS keychain / browser storage). This database stores
-- only connector metadata, a device registration, and a sha256 hash of the
-- device auth token. There is no encrypted_payload, no wrapped DEK and no
-- operator key: the server cannot decrypt a provider credential because it
-- never receives one.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0009;
-- migration application belongs to the coordinator, never to repositories.
--
-- A connector call is proxied to the device: the worker sends a typed request
-- to the registered device endpoint, the device attaches the provider secret
-- and calls the provider, and the bounded response is returned. `credential_ref`
-- is an opaque device-side identifier (e.g. a keychain item name), never the
-- secret itself. `token_hash` authenticates the device and cannot be reversed.
--
-- `connector_usage_ledger` is the durable free-tier counter: `consume`
-- increments and refuses an overage in one statement (`WHERE request_count <
-- limit`), never in application memory.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block would be intentionally a single line. This migration has none.

-- ---------------------------------------------------------------------------
-- Connector devices (user-owned execution proxy) -----------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connector_devices (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	user_id uuid NULL,
	display_name text NOT NULL
		CHECK (char_length(display_name) BETWEEN 1 AND 100),
	-- sha256 hex of the device auth token; the token itself never reaches the DB.
	token_hash text NOT NULL
		CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	status text NOT NULL DEFAULT 'pending' CHECK (status IN (
		'pending',
		'active',
		'revoked'
	)),
	last_seen_at timestamptz NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, display_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_devices_token_hash_unique
	ON connector_devices (token_hash);

CREATE INDEX IF NOT EXISTS connector_devices_org_status_idx
	ON connector_devices (organization_id, status);

-- ---------------------------------------------------------------------------
-- Connector credentials (metadata only; the secret stays on the device) ------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connector_credentials (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	device_id uuid NOT NULL
		REFERENCES connector_devices(id) ON DELETE CASCADE,
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
	-- Opaque device-side reference (keychain item / credential name), never a secret.
	credential_ref text NOT NULL
		CHECK (char_length(credential_ref) BETWEEN 1 AND 200),
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
	UNIQUE (organization_id, connector_id, display_name),
	UNIQUE (device_id, connector_id, credential_ref)
);

-- Active-credential resolution for one tenant and connector.
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
