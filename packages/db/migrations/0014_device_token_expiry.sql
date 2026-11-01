-- Device token expiry (wave 18 hardening).
--
-- A registered device token is time-bounded. NULL means "legacy token with no
-- expiry"; new registrations set a finite expiry and rotation replaces the
-- hash. Verification rejects an expired token before any call is claimed.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply after 0001-0013.

ALTER TABLE connector_devices
	ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS connector_devices_expires_idx
	ON connector_devices (expires_at)
	WHERE expires_at IS NOT NULL;
