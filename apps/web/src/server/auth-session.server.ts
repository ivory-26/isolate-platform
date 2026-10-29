import "@tanstack/react-start/server-only";
import type {
	MembershipRepository,
	OrganizationRepository,
	UserRepository,
} from "@isolate/db";
import { asOrganizationId, type UserId } from "@isolate/shared";
import type { NeonAuthServer } from "@neondatabase/auth/server";
import { z } from "zod";
import type { SessionResolver } from "./caller-scope.server";

const uuidSchema = z.uuid();

export type PlatformIdentity = {
	id: UserId;
	email: string;
	name: string;
};

function readText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

/**
 * Normalize an upstream auth identity. A malformed id is not an identity.
 */
export function toIdentity(user: {
	id: unknown;
	email: unknown;
	name?: unknown;
}): PlatformIdentity | null {
	const parsedId = uuidSchema.safeParse(user.id);
	if (!parsedId.success) return null;
	const email = readText(user.email);
	if (email.length === 0) return null;
	const providedName = readText(user.name);
	const fallbackName = email.split("@")[0] ?? email;
	const name = providedName.length > 0 ? providedName : fallbackName;
	return {
		id: parsedId.data.toLowerCase() as UserId,
		email,
		name: name.slice(0, 120),
	};
}

/**
 * Mirror an authenticated identity into the platform data model.
 *
 * The identity bridge is the id: Neon Auth issues uuid user ids and
 * `public.users.id` holds the same value, so a membership, a task's author and
 * the auth session all point at one person without a second mapping table.
 */
export async function ensurePlatformTenancy(
	deps: {
		users: UserRepository;
		memberships: MembershipRepository;
		organizations: OrganizationRepository;
	},
	identity: PlatformIdentity,
): Promise<void> {
	await ensurePlatformUser(deps.users, identity);
	await ensurePersonalWorkspace(deps, identity);
}

async function ensurePlatformUser(
	users: UserRepository,
	identity: PlatformIdentity,
): Promise<void> {
	const existing = await users.getById(identity.id);
	const unchanged =
		existing !== null &&
		existing.email === identity.email &&
		existing.display_name === identity.name;
	if (unchanged) return;
	await users.ensure({
		id: identity.id,
		email: identity.email,
		displayName: identity.name,
	});
}

/**
 * Give every new identity a personal workspace so a fresh account is never a
 * caller without any organization. The repository re-checks ownership inside
 * its transaction, so two concurrent first logins cannot both create one.
 */
async function ensurePersonalWorkspace(
	deps: {
		memberships: MembershipRepository;
		organizations: OrganizationRepository;
	},
	identity: PlatformIdentity,
): Promise<void> {
	const memberships = await deps.memberships.listForUser(identity.id);
	if (memberships.length > 0) return;
	await deps.organizations.createIfUnowned({
		id: asOrganizationId(crypto.randomUUID()),
		name: identity.name.slice(0, 120),
		slug: personalWorkspaceSlug(identity.email, identity.id),
		ownerId: identity.id,
	});
}

/**
 * Resolve the Neon Auth session and mirror it into the platform data model.
 *
 * The session resolver answers only "who is calling". It never decides which
 * organization is active; that is the membership reader's job.
 */
export function createNeonAuthSessionResolver(deps: {
	server: NeonAuthServer;
	users: UserRepository;
	memberships: MembershipRepository;
	organizations: OrganizationRepository;
}): SessionResolver {
	return {
		async getSession(): Promise<{ userId: UserId } | null> {
			const result = await deps.server.getSession();
			if (result.error || !result.data?.user) return null;
			const identity = toIdentity({
				id: result.data.user.id,
				email: result.data.user.email,
				name: result.data.user.name,
			});
			if (!identity) return null;
			await ensurePlatformTenancy(
				{
					users: deps.users,
					memberships: deps.memberships,
					organizations: deps.organizations,
				},
				identity,
			);
			return { userId: identity.id };
		},
	};
}

/**
 * Slugs are unique, so the owner's id keeps two people with the same email
 * local part in separate workspaces.
 */
export function personalWorkspaceSlug(email: string, userId: string): string {
	const local = email
		.split("@")[0]
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const suffix = userId.replace(/-/g, "").slice(0, 8).toLowerCase();
	return `${local || "workspace"}-${suffix}`;
}
