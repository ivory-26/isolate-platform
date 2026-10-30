-- Tenant-scoped blob store (wave 11).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0007;
-- migration application belongs to the coordinator, never to repositories.
--
-- Large diffs and log bundles outgrow the 256 KiB inline artifact column. This
-- table keeps the bytes and `artifacts.storage_ref` points at them as
-- `blob:<sha256>`; small payloads keep using the inline column. Every row is
-- organization-scoped and reads always filter on organization_id, so a foreign
-- digest is indistinguishable from a missing one.
--
-- `(organization_id, sha256)` is the dedupe identity: the same bytes written
-- twice for one tenant resolve to one row (`ON CONFLICT DO NOTHING` in the
-- repository, then a tenant-scoped SELECT). The byte cap mirrors
-- `MAX_BLOB_BYTES` in the repository, which rejects oversize input before the
-- INSERT; both CHECKs are backstops, not the primary gate.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block below is intentionally a single line (one statement).

-- ---------------------------------------------------------------------------
-- Blob bytes ----------------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blobs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations(id),
	task_id uuid NULL REFERENCES tasks(id),
	kind text NOT NULL CHECK (kind IN ('diff', 'log_bundle', 'report', 'screenshot')),
	content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 128),
	byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
	sha256 text NOT NULL CHECK (char_length(sha256) = 64),
	bytes bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe identity: one row per organization and digest.
CREATE UNIQUE INDEX IF NOT EXISTS blobs_org_sha256_unique
	ON blobs (organization_id, sha256);

-- Task-scoped listing, newest first (operator and worker queries).
CREATE INDEX IF NOT EXISTS blobs_task_created_idx
	ON blobs (task_id, created_at DESC);
