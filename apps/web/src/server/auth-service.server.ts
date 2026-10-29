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
	type SocialSignInResult,
	selectOrganizationSchema,
	signInSchema,
	signUpSchema,
	socialProviderSchema,
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

function socialFailure(code: AuthFailureCode): SocialSignInResult {
	return { ok: false, error: { code, message: authFailureMessages[code] } };
}

/**
 * Upstream codes are diagnostic labels, not messages. They are bounded and
 * stripped to safe characters so a log line can never carry payload text.
 */
export function boundedCode(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	const cleaned = text.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
	return cleaned.length > 0 ? cleaned : "UNKNOWN";
}

/**
 * The provider URL must be a plain public https URL. Anything else (relative,
 * userinfo, localhost, non-http) is discarded rather than handed to the
 * browser as a redirect.
 */
export function readAuthRedirectUrl(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const candidate = (data as Record<string, unknown>).url;
	if (typeof candidate !== "string" || candidate.length > 4096) return null;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hostname === "localhost" ||
		url.hostname.endsWith(".local") ||
		!url.hostname.includes(".")
	) {
		return null;
	}
	return url.toString();
}

/** A same-origin callback built from the request, never from client input. */
export function socialCallbackUrl(origin: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return null;
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.origin !== origin
	) {
		return null;
	}
	return `${parsed.origin}/auth/callback`;
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
	/** The current request's own origin (test seam; never client input). */
	requestOrigin(): string;
	/**
	 * Bounded diagnostics sink for upstream auth failures. It receives a stage
	 * label and the upstream error CODE only — never a message, token or user
	 * data. The browser still sees a generic failure.
	 */
	onUpstreamError?: (event: { stage: string; code: string }) => void;
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
				if (result.error) {
					deps.onUpstreamError?.({
						stage: "email_signin",
						code: boundedCode(result.error.code),
					});
					return authFailure(classifyUpstreamError(result.error.code));
				}
				return { ok: true };
			} catch (error) {
				deps.onUpstreamError?.({
					stage: "email_signin",
					code: boundedCode(error instanceof Error ? error.name : "UNKNOWN"),
				});
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
				if (result.error) {
					deps.onUpstreamError?.({
						stage: "email_signup",
						code: boundedCode(result.error.code),
					});
					return authFailure(classifyUpstreamError(result.error.code));
				}
				return { ok: true };
			} catch (error) {
				deps.onUpstreamError?.({
					stage: "email_signup",
					code: boundedCode(error instanceof Error ? error.name : "UNKNOWN"),
				});
				return authFailure("AUTH_UNAVAILABLE");
			}
		},
		/**
		 * Starts Google sign-in. The upstream flow stores a challenge cookie on
		 * this origin (relayed by the SDK) and returns the provider URL; the
		 * browser visits it and comes back to `/auth/callback`, where the
		 * verifier is exchanged for first-party session cookies.
		 */
		async startGoogleSignIn(input: unknown): Promise<SocialSignInResult> {
			const parsed = socialProviderSchema.safeParse(input);
			if (!parsed.success) return socialFailure("INVALID_INPUT");
			const origin = deps.requestOrigin();
			const callbackURL = socialCallbackUrl(origin);
			if (!callbackURL) {
				deps.onUpstreamError?.({
					stage: "social_signin",
					code: "UNUSABLE_REQUEST_ORIGIN",
				});
				return socialFailure("AUTH_UNAVAILABLE");
			}
			try {
				const result = await deps.server.signIn.social({
					provider: parsed.data.provider,
					callbackURL,
					disableRedirect: true,
				});
				if (result.error) {
					deps.onUpstreamError?.({
						stage: "social_signin",
						code: boundedCode(result.error.code),
					});
					return socialFailure(classifyUpstreamError(result.error.code));
				}
				const url = readAuthRedirectUrl(result.data);
				if (!url) {
					deps.onUpstreamError?.({
						stage: "social_signin",
						code: "UNUSABLE_PROVIDER_URL",
					});
					return socialFailure("AUTH_UNAVAILABLE");
				}
				return { ok: true, url };
			} catch (error) {
				deps.onUpstreamError?.({
					stage: "social_signin",
					code: boundedCode(error instanceof Error ? error.name : "UNKNOWN"),
				});
				return socialFailure("AUTH_UNAVAILABLE");
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
