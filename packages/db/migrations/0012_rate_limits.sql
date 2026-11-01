-- Durable fixed-window rate limits (wave 18).
--
-- One row per (bucket_key, window_start). `consume` is a single upsert so two
-- replicas observe one serialized counter and the limit can never be exceeded
-- in application memory. `expires_at` is the end of the window plus a small
-- grace, so `deleteExpired` can drop old buckets without touching a live one.
--
-- Keys are opaque server-built identifiers (`ip:<addr>:device`,
-- `device:<id>:claim`, `user:<id>:connector:connect`,
-- `org:<id>:connector:<connector>:calls`, `webhook:<mode>:global`); a request
-- value is never used verbatim as a key. No secret, token, body or provider
-- detail is ever stored here.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0011;
-- migration application belongs to the coordinator, never to repositories.
-- This migration has no DO blocks (scripts/apply-migration.ts splits on
-- line-ending semicolons).

CREATE TABLE IF NOT EXISTS rate_limit_counters (
	bucket_key text NOT NULL
		CHECK (char_length(bucket_key) BETWEEN 1 AND 300),
	window_start timestamptz NOT NULL,
	count integer NOT NULL DEFAULT 1 CHECK (count >= 0),
	expires_at timestamptz NOT NULL,
	PRIMARY KEY (bucket_key, window_start)
);

-- Bounded cleanup of expired windows.
CREATE INDEX IF NOT EXISTS rate_limit_counters_expires_at_idx
	ON rate_limit_counters (expires_at);
