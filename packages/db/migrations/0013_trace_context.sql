-- Run tracing for connector calls (wave 18).
--
-- The worker stamps one W3C traceparent on the enqueued call so the device
-- daemon can log the provider span under the same trace. No payload or
-- credential is stored here: the column is a fixed-shape identifier.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply after 0001-0012.

ALTER TABLE connector_calls
	ADD COLUMN IF NOT EXISTS traceparent text NULL
		CHECK (
			traceparent IS NULL OR
			traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
		);
