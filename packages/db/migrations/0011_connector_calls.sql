-- Device-daemon connector call queue (wave 17).
--
-- SECURITY: the server never holds a provider key. A call row carries typed
-- tool arguments only (`params`), never a provider secret, header or URL. The
-- device polls for work, looks the secret up in its own keychain by
-- `credential_id`, calls the provider and posts a bounded `result` back.
--
-- `params` and `result` are size-capped in the database as well as at the API
-- boundary: 64 KiB of arguments and 256 KiB of result. The JSON object CHECK
-- keeps the columns decodable by the repository mapper.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0010;
-- migration application belongs to the coordinator, never to repositories.
-- This migration has no DO blocks (scripts/apply-migration.ts splits on
-- line-ending semicolons).

CREATE TABLE IF NOT EXISTS connector_calls (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	device_id uuid NOT NULL
		REFERENCES connector_devices(id) ON DELETE CASCADE,
	credential_id uuid NOT NULL
		REFERENCES connector_credentials(id) ON DELETE CASCADE,
	task_id uuid NULL,
	connector_id text NOT NULL
		CHECK (connector_id ~ '^[a-z][a-z0-9-]{0,31}$'),
	tool_name text NOT NULL
		CHECK (tool_name ~ '^[a-z][a-z0-9_.-]{0,63}$'),
	params jsonb NOT NULL
		CHECK (jsonb_typeof(params) = 'object'),
	status text NOT NULL DEFAULT 'queued' CHECK (status IN (
		'queued',
		'claimed',
		'completed',
		'failed',
		'expired'
	)),
	result jsonb NULL
		CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
	error_code text NULL
		CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	claimed_at timestamptz NULL,
	completed_at timestamptz NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- A device result can never be used to inflate the row beyond the API cap.
	CHECK (octet_length(params::text) <= 65536),
	CHECK (result IS NULL OR octet_length(result::text) <= 262144)
);

-- Oldest-first claim for one device; also serves status reporting.
CREATE INDEX IF NOT EXISTS connector_calls_device_status_created_idx
	ON connector_calls (device_id, status, created_at);

-- Worker correlation: enqueue by task and await the terminal row.
CREATE INDEX IF NOT EXISTS connector_calls_task_idx
	ON connector_calls (task_id);
