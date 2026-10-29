import "@tanstack/react-start/server-only";
import type { UserRole } from "@isolate/db";
import {
	asOrganizationId,
	asUserId,
	asWorkflowDefinitionId,
	type OrganizationId,
	type UserId,
} from "@isolate/shared";
import { z } from "zod";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Trusted caller identity seams (W4-A).
 *
 * Only a server-side session adapter may say who is calling, and only a
 * server-side membership reader may say which organization is active. Request
 * headers, cookies and form fields are never identity inputs here.
 */
export type SessionIdentity = { userId: UserId };
export interface SessionResolver {
	getSession(): Promise<SessionIdentity | null>;
}
export type ActiveMembership = {
	organizationId: OrganizationId;
	role: UserRole;
};
export interface MembershipReader {
	getActiveMembership(
		userId: UserId,
		requestedOrganizationId?: OrganizationId,
	): Promise<ActiveMembership | ActiveMembership[] | null>;
}
export type CallerScopeDependencies = {
	session: SessionResolver;
	memberships: MembershipReader;
	/** Optional organization selected by a future route; must be an active membership. */
	requestedOrganizationId?: OrganizationId;
};

const uuidSchema = z.uuid();
const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
const membershipSchema = z.strictObject({
	organizationId: uuidSchema,
	role: roleSchema,
});
function normalizeUuid(value: string): string {
	return value.toLowerCase();
}
function selectedMembership(
	value: ActiveMembership | ActiveMembership[] | null,
	requestedOrganizationId: string | undefined,
): ActiveMembership | null {
	const entries = value === null ? [] : Array.isArray(value) ? value : [value];
	const candidates: ActiveMembership[] = [];
	for (const entry of entries) {
		const parsed = membershipSchema.safeParse(entry);
		if (!parsed.success) continue;
		candidates.push({
			organizationId: asOrganizationId(
				normalizeUuid(parsed.data.organizationId),
			),
			role: parsed.data.role,
		});
	}
	if (requestedOrganizationId !== undefined) {
		const requested = normalizeUuid(requestedOrganizationId);
		return (
			candidates.find(
				(entry) => normalizeUuid(entry.organizationId) === requested,
			) ?? null
		);
	}
	// Deterministic when a user belongs to multiple organizations: no request
	// preference means the lexicographically first active membership.
	return (
		candidates.sort((a, b) =>
			a.organizationId < b.organizationId
				? -1
				: a.organizationId > b.organizationId
					? 1
					: 0,
		)[0] ?? null
	);
}

/** Resolve the trusted tenant/actor pair or fail closed. */
export async function resolveCallerScope(
	deps: CallerScopeDependencies,
): Promise<CallerScope> {
	let session: SessionIdentity | null;
	try {
		session = await deps.session.getSession();
	} catch {
		throw new ControlPlaneError("AUTH_REQUIRED");
	}
	if (
		session === null ||
		typeof session !== "object" ||
		typeof session.userId !== "string"
	)
		throw new ControlPlaneError("AUTH_REQUIRED");
	const userId = uuidSchema.safeParse(session.userId);
	if (!userId.success) throw new ControlPlaneError("AUTH_REQUIRED");

	let requestedOrganizationId: string | undefined;
	if (deps.requestedOrganizationId !== undefined) {
		const requested = uuidSchema.safeParse(deps.requestedOrganizationId);
		if (!requested.success) throw new ControlPlaneError("FORBIDDEN");
		requestedOrganizationId = requested.data;
	}

	let memberships: ActiveMembership | ActiveMembership[] | null;
	try {
		memberships = await deps.memberships.getActiveMembership(
			asUserId(normalizeUuid(userId.data)),
			requestedOrganizationId === undefined
				? undefined
				: asOrganizationId(requestedOrganizationId),
		);
	} catch {
		throw new ControlPlaneError("FORBIDDEN");
	}
	const membership = selectedMembership(memberships, requestedOrganizationId);
	if (membership === null) throw new ControlPlaneError("FORBIDDEN");
	return {
		organizationId: membership.organizationId,
		userId: asUserId(normalizeUuid(userId.data)),
	};
}

/** Demo identity/config. Shared by the local store and the dev adapter. */
export type RuntimeConfig = {
	nodeEnv?: string;
	localDemo?: string;
	databaseUrl?: string;
};
export const localDemo = {
	organizationId: asOrganizationId("10000000-0000-4000-8000-000000000001"),
	userId: asUserId("10000000-0000-4000-8000-000000000002"),
	repositoryId: "10000000-0000-4000-8000-000000000003",
	workflowDefinitionId: asWorkflowDefinitionId(
		"10000000-0000-4000-8000-000000000004",
	),
	workflowVersion: 1,
	workflowVersionId: "10000000-0000-4000-8000-000000000005",
} as const;

function localDemoEnabled(config: RuntimeConfig): boolean {
	return (
		(config.nodeEnv === "development" || config.nodeEnv === "test") &&
		config.localDemo === "true" &&
		!config.databaseUrl
	);
}

/**
 * Test/development-only adapter preserving the pre-W4 demo behavior. It is not
 * authentication: an unauthenticated demo must never point at a database.
 */
export function createLocalDemoAdapters(config: RuntimeConfig): {
	session: SessionResolver;
	memberships: MembershipReader;
} {
	if (!localDemoEnabled(config)) throw new ControlPlaneError("AUTH_REQUIRED");
	const membership: ActiveMembership = {
		organizationId: localDemo.organizationId,
		role: "owner",
	};
	return {
		session: {
			async getSession() {
				return { userId: localDemo.userId };
			},
		},
		memberships: {
			async getActiveMembership(userId, requestedOrganizationId) {
				if (normalizeUuid(userId) !== localDemo.userId) return null;
				if (
					requestedOrganizationId !== undefined &&
					normalizeUuid(requestedOrganizationId) !== localDemo.organizationId
				)
					return null;
				return { ...membership };
			},
		},
	};
}

/** Synchronous demo guard kept for the existing local-mode contract/tests. */
export function resolveLocalScope(config: RuntimeConfig): CallerScope {
	if (!localDemoEnabled(config)) throw new ControlPlaneError("AUTH_REQUIRED");
	return {
		organizationId: localDemo.organizationId,
		userId: localDemo.userId,
	};
}
