-- Event-first integrations and web onboarding (wave 23).
--
-- Adds only the records the current schema cannot express:
--   * github_installations     per-organization GitHub App installation
--   * integration_subscriptions tenant-scoped trigger rules
--   * event_deliveries         bounded receipt ledger (no raw payloads)
--   * connector_pairings       one-time browser <-> relay pairing sessions
-- plus bounded event display fields on incident_signals and an autonomy level
-- on tasks.
--
-- SECURITY: no provider secret, OAuth refresh token, webhook secret or device
-- token is stored here. Pairing codes are stored as sha256 hashes. Delivery
-- rows keep a body hash, not the body.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0015.
-- Application belongs to the coordinator, never to repositories.
-- Keep DO blocks on one line: scripts/apply-migration.ts splits on line-ending
-- semicolons.

-- ---------------------------------------------------------------------------
-- GitHub App installation (one per organization installation) ----------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS github_installations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	installation_id bigint NOT NULL CHECK (installation_id > 0),
	account_login text NOT NULL
		CHECK (char_length(account_login) BETWEEN 1 AND 100),
	account_type text NOT NULL DEFAULT 'Organization'
		CHECK (account_type IN ('User', 'Organization')),
	repository_selection text NOT NULL DEFAULT 'selected'
		CHECK (repository_selection IN ('all', 'selected')),
	status text NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'suspended', 'revoked')),
	created_by uuid NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (installation_id),
	UNIQUE (organization_id, installation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS github_installations_org_id_unique
	ON github_installations (organization_id, id);

CREATE INDEX IF NOT EXISTS github_installations_org_status_idx
	ON github_installations (organization_id, status);

-- Repositories may belong to one installation. NULL keeps legacy registrations.
CREATE UNIQUE INDEX IF NOT EXISTS repositories_org_id_unique
	ON repositories (organization_id, id);

ALTER TABLE repositories
	ADD COLUMN IF NOT EXISTS github_installation_id uuid;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_org_installation_fk') THEN ALTER TABLE repositories ADD CONSTRAINT repositories_org_installation_fk FOREIGN KEY (organization_id, github_installation_id) REFERENCES github_installations (organization_id, id) ON DELETE SET NULL; END IF; END $$;

CREATE INDEX IF NOT EXISTS repositories_installation_idx
	ON repositories (organization_id, github_installation_id)
	WHERE github_installation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integration subscriptions (event -> repository trigger rules) --------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_subscriptions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	display_name text NOT NULL
		CHECK (char_length(display_name) BETWEEN 1 AND 100),
	-- Empty means "the connector's default event set"; at most 16 kinds.
	event_kinds text[] NOT NULL DEFAULT '{}'::text[]
		CHECK (array_length(event_kinds, 1) IS NULL OR array_length(event_kinds, 1) <= 16),
	environment_allowlist text[] NOT NULL DEFAULT ARRAY['production']::text[]
		CHECK (array_length(environment_allowlist, 1) IS NULL OR array_length(environment_allowlist, 1) <= 16),
	min_severity text NOT NULL DEFAULT 'high'
		CHECK (min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
	repository_id uuid NULL,
	base_branch text NULL CHECK (base_branch IS NULL OR char_length(base_branch) BETWEEN 1 AND 255),
	autonomy_level text NOT NULL DEFAULT 'A2'
		CHECK (autonomy_level IN ('A0', 'A1', 'A2', 'A3')),
	enabled boolean NOT NULL DEFAULT true,
	config jsonb NOT NULL DEFAULT '{}'::jsonb
		CHECK (jsonb_typeof(config) = 'object'),
	created_by uuid NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, connector_id, display_name)
);

CREATE INDEX IF NOT EXISTS integration_subscriptions_org_connector_enabled_idx
	ON integration_subscriptions (organization_id, connector_id, enabled);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_subscriptions_org_repository_fk') THEN ALTER TABLE integration_subscriptions ADD CONSTRAINT integration_subscriptions_org_repository_fk FOREIGN KEY (organization_id, repository_id) REFERENCES repositories (organization_id, id) ON DELETE SET NULL; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Event delivery receipts (bounded; never a raw provider payload) ------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_deliveries (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	subscription_id uuid NULL,
	delivery_id text NULL
		CHECK (delivery_id IS NULL OR char_length(delivery_id) BETWEEN 1 AND 128),
	source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 32),
	event_kind text NOT NULL CHECK (char_length(event_kind) BETWEEN 1 AND 64),
	severity text NOT NULL DEFAULT 'info'
		CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
	fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 128),
	verification text NOT NULL
		CHECK (verification IN ('provider_signature', 'shared_hmac', 'bridge_identity', 'canonical_refetch')),
	status text NOT NULL DEFAULT 'received'
		CHECK (status IN ('received', 'verified', 'rejected', 'deduplicated', 'task_created', 'task_updated', 'ignored')),
	reason_code text NULL
		CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	signal_id uuid NULL REFERENCES incident_signals(id) ON DELETE SET NULL,
	task_id uuid NULL REFERENCES tasks(id) ON DELETE SET NULL,
	body_sha256 text NOT NULL
		CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
	received_at timestamptz NOT NULL DEFAULT now(),
	processed_at timestamptz NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS event_deliveries_org_delivery_unique
	ON event_deliveries (organization_id, connector_id, delivery_id)
	WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_deliveries_org_received_idx
	ON event_deliveries (organization_id, received_at DESC);

CREATE INDEX IF NOT EXISTS event_deliveries_org_status_idx
	ON event_deliveries (organization_id, status, received_at DESC);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_deliveries_org_subscription_fk') THEN ALTER TABLE event_deliveries ADD CONSTRAINT event_deliveries_org_subscription_fk FOREIGN KEY (organization_id, subscription_id) REFERENCES integration_subscriptions (organization_id, id) ON DELETE SET NULL; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Connector pairing sessions (browser starts, relay claims, server completes) -
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS connector_pairings (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	device_id uuid NOT NULL
		REFERENCES connector_devices(id) ON DELETE CASCADE,
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	display_name text NOT NULL
		CHECK (char_length(display_name) BETWEEN 1 AND 100),
	auth_kind text NOT NULL CHECK (auth_kind IN (
		'api_key', 'oauth_client_credentials', 'oauth_authorization_code',
		'service_account_json', 'bot_token', 'self_host_url_token'
	)),
	credential_ref text NOT NULL
		CHECK (char_length(credential_ref) BETWEEN 1 AND 200),
	scopes text[] NOT NULL DEFAULT '{}'::text[]
		CHECK (array_length(scopes, 1) IS NULL OR array_length(scopes, 1) <= 32),
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb
		CHECK (jsonb_typeof(metadata) = 'object'),
	-- sha256 hex of the one-time pairing code. The code itself never persists.
	code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
	status text NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'claimed', 'completed', 'expired', 'cancelled')),
	created_by uuid NULL,
	expires_at timestamptz NOT NULL,
	claimed_at timestamptz NULL,
	completed_at timestamptz NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS connector_pairings_org_status_idx
	ON connector_pairings (organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS connector_pairings_device_idx
	ON connector_pairings (device_id, status, created_at DESC);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_pairings_org_device_fk') THEN ALTER TABLE connector_pairings ADD CONSTRAINT connector_pairings_org_device_fk FOREIGN KEY (organization_id, device_id) REFERENCES connector_devices (organization_id, id) ON DELETE CASCADE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Bounded event display fields + task autonomy -------------------------------
-- ---------------------------------------------------------------------------

ALTER TABLE incident_signals
	ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incident_signals_title_length_check') THEN ALTER TABLE incident_signals ADD CONSTRAINT incident_signals_title_length_check CHECK (char_length(title) <= 400); END IF; END $$;

ALTER TABLE incident_signals
	ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incident_signals_summary_length_check') THEN ALTER TABLE incident_signals ADD CONSTRAINT incident_signals_summary_length_check CHECK (char_length(summary) <= 8000); END IF; END $$;

ALTER TABLE incident_signals
	ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incident_signals_links_array_check') THEN ALTER TABLE incident_signals ADD CONSTRAINT incident_signals_links_array_check CHECK (jsonb_typeof(links) = 'array'); END IF; END $$;

ALTER TABLE incident_signals
	ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1
		CHECK (occurrence_count >= 1);

ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS autonomy_level text NOT NULL DEFAULT 'A2';

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_autonomy_level_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_autonomy_level_check CHECK (autonomy_level IN ('A0', 'A1', 'A2', 'A3')); END IF; END $$;
