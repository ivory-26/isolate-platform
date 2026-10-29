import type { OrganizationId, UserId } from "@isolate/shared";
import type { MembershipRepository } from "../repositories/membership-repository";
import { isUserRole } from "../repositories/membership-repository";
import type { OrganizationRepository } from "../repositories/organization-repository";
import { requireNonEmpty } from "../repositories/task-repository";
import type { UserRepository } from "../repositories/user-repository";
import type { MembershipRow, OrganizationRow, UserRow } from "../schema";

/**
 * In-memory tenancy fakes. They mirror the Postgres drivers' constraints
 * (unique email per user, unique organization slug, one membership per
 * organization/user pair) so a test cannot pass against a fake that the
 * database would reject.
 */

export class InMemoryUserRepository implements UserRepository {
	private readonly rows = new Map<UserId, UserRow>();

	async ensure(input: {
		id: UserId;
		email: string;
		displayName: string;
	}): Promise<UserRow> {
		requireNonEmpty(input.id, "id");
		requireNonEmpty(input.email, "email");
		requireNonEmpty(input.displayName, "displayName");
		for (const row of this.rows.values()) {
			if (row.email === input.email && row.id !== input.id) {
				throw new Error("users_email_key");
			}
		}
		const existing = this.rows.get(input.id);
		const row: UserRow = {
			id: input.id,
			email: input.email,
			display_name: input.displayName,
			created_at: existing?.created_at ?? new Date(),
		};
		this.rows.set(input.id, row);
		return row;
	}

	async getById(id: UserId): Promise<UserRow | null> {
		return this.rows.get(id) ?? null;
	}
}

function membershipKey(organizationId: string, userId: string): string {
	return `${organizationId}:${userId}`;
}

export class InMemoryMembershipRepository implements MembershipRepository {
	private readonly rows = new Map<string, MembershipRow>();

	async listForUser(userId: UserId): Promise<MembershipRow[]> {
		return [...this.rows.values()]
			.filter((row) => row.user_id === userId)
			.sort((a, b) => a.organization_id.localeCompare(b.organization_id));
	}

	async getForUser(
		userId: UserId,
		organizationId: OrganizationId,
	): Promise<MembershipRow | null> {
		return this.rows.get(membershipKey(organizationId, userId)) ?? null;
	}

	async add(input: {
		organizationId: OrganizationId;
		userId: UserId;
		role: MembershipRow["role"];
	}): Promise<MembershipRow> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.userId, "userId");
		if (!isUserRole(input.role)) throw new Error("unknown membership role");
		const key = membershipKey(input.organizationId, input.userId);
		const existing = this.rows.get(key);
		const row: MembershipRow = {
			organization_id: input.organizationId,
			user_id: input.userId,
			role: input.role,
			created_at: existing?.created_at ?? new Date(),
		};
		this.rows.set(key, row);
		return row;
	}

	async remove(input: {
		organizationId: OrganizationId;
		userId: UserId;
	}): Promise<boolean> {
		return this.rows.delete(membershipKey(input.organizationId, input.userId));
	}

	async countForUser(userId: UserId): Promise<number> {
		return (await this.listForUser(userId)).length;
	}
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
	private readonly rows = new Map<OrganizationId, OrganizationRow>();
	private readonly slugs = new Map<string, OrganizationId>();

	/** Without a membership source the owner membership cannot be created. */
	constructor(private readonly memberships?: MembershipRepository) {}

	async createWithOwner(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow> {
		const row = this.insert(input);
		await this.memberships?.add({
			organizationId: input.id,
			userId: input.ownerId,
			role: "owner",
		});
		return row;
	}

	async createIfUnowned(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow | null> {
		if (this.memberships) {
			const existing = await this.memberships.listForUser(input.ownerId);
			if (existing.length > 0) return null;
		}
		return this.createWithOwner(input);
	}

	async getById(id: OrganizationId): Promise<OrganizationRow | null> {
		return this.rows.get(id) ?? null;
	}

	async getBySlug(slug: string): Promise<OrganizationRow | null> {
		const id = this.slugs.get(slug);
		return id === undefined ? null : (this.rows.get(id) ?? null);
	}

	private insert(input: {
		id: OrganizationId;
		name: string;
		slug: string;
	}): OrganizationRow {
		requireNonEmpty(input.id, "id");
		requireNonEmpty(input.name, "name");
		requireNonEmpty(input.slug, "slug");
		if (this.slugs.has(input.slug)) throw new Error("organizations_slug_key");
		const row: OrganizationRow = {
			id: input.id,
			name: input.name,
			slug: input.slug,
			created_at: new Date(),
		};
		this.rows.set(input.id, row);
		this.slugs.set(input.slug, input.id);
		return row;
	}
}

export function createInMemoryTenancy(): {
	users: InMemoryUserRepository;
	memberships: InMemoryMembershipRepository;
	organizations: InMemoryOrganizationRepository;
} {
	const memberships = new InMemoryMembershipRepository();
	return {
		users: new InMemoryUserRepository(),
		memberships,
		organizations: new InMemoryOrganizationRepository(memberships),
	};
}
