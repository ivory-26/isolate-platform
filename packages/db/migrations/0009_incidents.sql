-- GitHub-native incident signals (wave 13).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0008;
-- migration application belongs to the coordinator, never to repositories.
--
-- A webhook is a task source, not an execution path. `incident_signals` stores
-- one bounded, normalized row per inbound delivery and the task row keeps the
-- provenance (`incident_source`, `incident_fingerprint`) that ties a task back
-- to the signal it was opened for. No provider payload, credential or raw log
-- is persisted here: only the bounded identity fields the intake service has
-- already validated against `incidentSignalSchema` in @isolate/shared.
--
-- Dedupe is a 30-minute bucket per (organization, source, fingerprint): the
-- expression index below floors `received_at` to a 1800 s boundary, so a burst
-- of deliveries for one fingerprint opens ONE task while the same fingerprint
-- in a later half-hour opens another. The repository inserts with
-- `ON CONFLICT DO NOTHING` and then reads the surviving row, so a concurrent
-- duplicate resolves to the same signal id instead of a second row.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block below is intentionally a single line (one statement).

-- ---------------------------------------------------------------------------
-- Task provenance ------------------------------------------------------------
-- ---------------------------------------------------------------------------

-- Source token of the signal that opened this task; NULL for a normal submit.
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS incident_source text;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_incident_source_length_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_incident_source_length_check CHECK (incident_source IS NULL OR char_length(incident_source) <= 32); END IF; END $$;

-- Source-stable dedupe key (never a delivery id); NULL for a normal submit.
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS incident_fingerprint text;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_incident_fingerprint_length_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_incident_fingerprint_length_check CHECK (incident_fingerprint IS NULL OR char_length(incident_fingerprint) BETWEEN 1 AND 128); END IF; END $$;

-- The max-2 concurrent incident tasks cap counts this window per organization.
CREATE INDEX IF NOT EXISTS tasks_org_incident_created_idx
	ON tasks (organization_id, created_at DESC)
	WHERE incident_fingerprint IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Incident signals -----------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incident_signals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 32),
	kind text NOT NULL CHECK (char_length(kind) <= 64),
	severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
	service text NOT NULL CHECK (char_length(service) <= 128),
	fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 128),
	delivery_id text NULL CHECK (delivery_id IS NULL OR char_length(delivery_id) <= 128),
	received_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe identity: one signal per tenant, source, fingerprint and 30-minute
-- bucket. The bucket is computed from the UTC wall clock so every operand is
-- IMMUTABLE (Postgres rejects `to_timestamp` here: it is only STABLE).
CREATE UNIQUE INDEX IF NOT EXISTS incident_signals_dedupe_unique
	ON incident_signals (
		organization_id,
		source,
		fingerprint,
		(floor(extract(epoch from (received_at AT TIME ZONE 'UTC')) / 1800))
	);

-- Operator listing: newest signals first for one tenant.
CREATE INDEX IF NOT EXISTS incident_signals_org_received_idx
	ON incident_signals (organization_id, received_at DESC);
