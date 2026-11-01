-- Composite tenant integrity for connectors (wave 18 hardening).
--
-- Separate FKs only prove that a device/credential id exists somewhere; they
-- do not prove it belongs to the same organization. These composite keys make
-- a cross-tenant reference impossible at the database level, with the gateway
-- checks remaining as defense in depth.
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply after 0001-0014.

CREATE UNIQUE INDEX IF NOT EXISTS connector_devices_org_id_unique
	ON connector_devices (organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS connector_credentials_org_id_unique
	ON connector_credentials (organization_id, id);

ALTER TABLE connector_credentials
	DROP CONSTRAINT IF EXISTS connector_credentials_org_device_fk;
ALTER TABLE connector_credentials
	ADD CONSTRAINT connector_credentials_org_device_fk
	FOREIGN KEY (organization_id, device_id)
	REFERENCES connector_devices (organization_id, id)
	ON DELETE CASCADE;

ALTER TABLE connector_calls
	DROP CONSTRAINT IF EXISTS connector_calls_org_device_fk;
ALTER TABLE connector_calls
	ADD CONSTRAINT connector_calls_org_device_fk
	FOREIGN KEY (organization_id, device_id)
	REFERENCES connector_devices (organization_id, id)
	ON DELETE CASCADE;

ALTER TABLE connector_calls
	DROP CONSTRAINT IF EXISTS connector_calls_org_credential_fk;
ALTER TABLE connector_calls
	ADD CONSTRAINT connector_calls_org_credential_fk
	FOREIGN KEY (organization_id, credential_id)
	REFERENCES connector_credentials (organization_id, id)
	ON DELETE CASCADE;

ALTER TABLE connector_usage_ledger
	DROP CONSTRAINT IF EXISTS connector_usage_ledger_org_credential_fk;
ALTER TABLE connector_usage_ledger
	ADD CONSTRAINT connector_usage_ledger_org_credential_fk
	FOREIGN KEY (organization_id, credential_id)
	REFERENCES connector_credentials (organization_id, id)
	ON DELETE CASCADE;
