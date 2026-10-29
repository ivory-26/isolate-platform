import "@tanstack/react-start/server-only";
import type {
	MembershipRepository,
	OrganizationRepository,
	UserRole,
} from "@isolate/db";
import type { OrganizationId, UserId } from "@isolate/shared";
import type { ActiveMembership, MembershipReader } from "./caller-scope.server";

export type CallerOrganization = {
	id: OrganizationId;
	name: string;
	slug: string;
	role: UserRole;
};

/**
 * Read a caller's active organization from the platform's own membership
 * table. The reader never trusts a requested organization: an organization the
 * caller is not a member of is simply not among the candidates.
 */
export function createPostgresMembershipReader(
	memberships: MembershipRepository,
): MembershipReader {
	return {
		async getActiveMembership(
			userId: UserId,
			requestedOrganizationId?: OrganizationId,
		): Promise<ActiveMembership | ActiveMembership[] | null> {
			const rows = await memberships.listForUser(userId);
			const entries: ActiveMembership[] = rows.map((row) => ({
				organizationId: row.organization_id,
				role: row.role,
			}));
			if (requestedOrganizationId === undefined) return entries;
			return (
				entries.find(
					(entry) => entry.organizationId === requestedOrganizationId,
				) ?? null
			);
		},
	};
}

/**
 * The organizations one caller belongs to. A membership without its
 * organization row is skipped rather than surfaced as a broken tenant.
 */
export async function listCallerOrganizations(
	memberships: MembershipRepository,
	organizations: OrganizationRepository,
	userId: UserId,
): Promise<CallerOrganization[]> {
	const rows = await memberships.listForUser(userId);
	const result: CallerOrganization[] = [];
	for (const row of rows) {
		const organization = await organizations.getById(row.organization_id);
		if (!organization) continue;
		result.push({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			role: row.role,
		});
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}
