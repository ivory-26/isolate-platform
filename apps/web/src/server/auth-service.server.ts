import "@tanstack/react-start/server-only";
import type {
	MembershipRepository,
	OrganizationRepository,
	UserRole,
} from "@isolate/db";
import {
	asOrganizationId,
	asUserId,
	type OrganizationId,
	type UserId,
} from "@isolate/shared";
import type { NeonAuthServer } from "@neondatabase/auth/server";
import {
	type AuthActionResult,
	type AuthFailureCode,
	authFailure,
	authFailureMessages,
	createOrganizationSchema,
	type OrganizationActionResult,
	type SessionView,
	selectOrganizationSchema,
	signInSchema,
	signUpSchema,
} from "../features/auth/contracts";
import { toIdentity } from "./auth-session.server";
import { listCallerOrganizations } from "./membership-reader.server";

export type { AuthActionResult, AuthFailureCode, SessionView };
export type SessionOrganization = {
	id: OrganizationId;
	name: string;
	slug: string;
	role: UserRole;
};

/**
 * Upstream error codes are never echoed. Only the shape of the failure is
 * reported back to the browser.
 */
function classifyUpstreamError(code: unknown): AuthFailureCode {
	const text = typeof code === "string" ? code : "";
	if (text.includes("ALREADY_EXISTS")) return "EMAIL_TAKEN";
	if (text.includes("BANNED")) return "ACCOUNT_DISABLED";
	if (
		text.includes("EMAIL_OR_PASSWORD") ||
		text.includes("INVALID_PASSWORD") ||
		text.includes("INVALID_CREDENTIALS") ||
		text.includes("USER_NOT_FOUND")
	)
		return "INVALID_CREDENTIALS";
	return "AUTH_UNAVAILABLE";
}

export function createAuthService(deps: {
	server: NeonAuthServer;
	memberships: MembershipRepository;
	organizations: OrganizationRepository;
	ensureTenancy: (identity: {
		id: UserId;
		email: string;
		name: string;
	}) => Promise<void>;
	readActiveOrganization(): OrganizationId | undefined;
	writeActiveOrganization(organizationId: OrganizationId): void;
}) {
	async function currentSession(): Promise<SessionView> {
		const result = await deps.server.getSession();
		if (result.error || !result.data?.user)
			return { user: null, organizations: [], activeOrganizationId: null };
		const identity = toIdentity({
			id: result.data.user.id,
			email: result.data.user.email,
			name: result.data.user.name,
		});
		if (!identity)
			return { user: null, organizations: [], activeOrganizationId: null };
		await deps.ensureTenancy(identity);
		const organizations = await listCallerOrganizations(
			deps.memberships,
			deps.organizations,
			identity.id,
		);
		const preferred = deps.readActiveOrganization();
		const active =
			organizations.find((entry) => entry.id === preferred) ?? organizations[0];
		return {
			user: {
				id: identity.id,
				email: identity.email,
				name: identity.name,
			},
			organizations: organizations.map((entry) => ({
				id: entry.id,
				name: entry.name,
				slug: entry.slug,
				role: entry.role,
			})),
			activeOrganizationId: active?.id ?? null,
		};
	}
	return {
		async signIn(input: unknown): Promise<AuthActionResult> {
			const parsed = signInSchema.safeParse(input);
			if (!parsed.success) return authFailure("INVALID_INPUT");
			try {
				const result = await deps.server.signIn.email({
					email: parsed.data.email,
					password: parsed.data.password,
				});
				if (result.error)
					return authFailure(classifyUpstreamError(result.error.code));
				return { ok: true };
			} catch {
				return authFailure("AUTH_UNAVAILABLE");
			}
		},
		async signUp(input: unknown): Promise<AuthActionResult> {
			const parsed = signUpSchema.safeParse(input);
			if (!parsed.success) return authFailure("INVALID_INPUT");
			try {
				const result = await deps.server.signUp.email({
					name: parsed.data.name,
					email: parsed.data.email,
					password: parsed.data.password,
				});
				if (result.error)
					return authFailure(classifyUpstreamError(result.error.code));
				return { ok: true };
			} catch {
				return authFailure("AUTH_UNAVAILABLE");
			}
		},
		async signOut(): Promise<AuthActionResult> {
			try {
				const result = await deps.server.signOut();
				if (result.error) return authFailure("AUTH_UNAVAILABLE");
				return { ok: true };
			} catch {
				return authFailure("AUTH_UNAVAILABLE");
			}
		},
		currentSession,
		/**
		 * The active organization is a preference. Selecting an organization the
		 * caller does not belong to is refused rather than silently accepted.
		 */
		async selectOrganization(input: unknown): Promise<AuthActionResult> {
			const parsed = selectOrganizationSchema.safeParse(input);
			if (!parsed.success) return authFailure("INVALID_INPUT");
			const view = await currentSession();
			if (!view.user) return authFailure("INVALID_CREDENTIALS");
			const target = view.organizations.find(
				(entry) => entry.id === parsed.data.organizationId.toLowerCase(),
			);
			if (!target) return authFailure("FORBIDDEN");
			deps.writeActiveOrganization(target.id as OrganizationId);
			return { ok: true };
		},
		/**
		 * A new organization is created together with the caller's owner
		 * membership, so the creator is never locked out of their own tenant.
		 */
		async createOrganization(
			input: unknown,
		): Promise<OrganizationActionResult> {
			const parsed = createOrganizationSchema.safeParse(input);
			if (!parsed.success)
				return {
					ok: false,
					error: {
						code: "INVALID_INPUT",
						message: authFailureMessages.INVALID_INPUT,
					},
				};
			const view = await currentSession();
			if (!view.user) {
				return {
					ok: false,
					error: {
						code: "AUTH_REQUIRED",
						message: authFailureMessages.AUTH_REQUIRED,
					},
				};
			}
			try {
				const created = await deps.organizations.createWithOwner({
					id: asOrganizationId(crypto.randomUUID()),
					name: parsed.data.name,
					slug: parsed.data.slug,
					ownerId: asUserId(view.user.id),
				});
				return {
					ok: true,
					organization: {
						id: created.id,
						name: created.name,
						slug: created.slug,
						role: "owner",
					},
				};
			} catch {
				// The slug is unique across tenants; any storage failure is
				// reported the same bounded way.
				return {
					ok: false,
					error: {
						code: "SLUG_TAKEN",
						message: authFailureMessages.SLUG_TAKEN,
					},
				};
			}
		},
	};
}
