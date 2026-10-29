-- Authentication and tenancy access (W5-AUTH).
--
-- Identity: Neon Managed Better Auth owns credentials and sessions in the
-- Neon-managed `neon_auth` schema. Its `user.id` is a uuid, and the platform's
-- `public.users.id` is a uuid, so the authenticated user id IS the platform
-- user id. No separate identity table is needed, and `memberships.user_id`,
-- `tasks.created_by` and `workflow_versions.created_by` keep pointing at the
-- same person the session belongs to.
--
-- Tenancy: `public.organizations` + `public.memberships` stay the source of
-- truth for who may see what (ARCHITECTURE.md §5, §11). Better Auth's
-- organization plugin is NOT used for tenancy; Neon runs it server-side for
-- its own UI, and it cannot express the platform's `viewer` role.
--
-- This migration adds only the index the "which organizations may this caller
-- see?" lookup needs: the memberships primary key is (organization_id,
-- user_id) and cannot serve the reverse lookup by user.

CREATE INDEX IF NOT EXISTS memberships_user_id_idx
	ON memberships (user_id);
