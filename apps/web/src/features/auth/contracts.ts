import { z } from "zod";

/**
 * Client-safe auth contracts. The schemas run in the browser before a request
 * is sent, so they may not import anything server-only.
 */
export const signInSchema = z.strictObject({
	email: z.email().max(320),
	password: z.string().min(8).max(200),
});
export const signUpSchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	email: z.email().max(320),
	password: z.string().min(8).max(200),
});
export const selectOrganizationSchema = z.strictObject({
	organizationId: z.uuid(),
});
/**
 * Social providers the UI may start. Enumerated (not free text) so the
 * server can never be asked to forward an arbitrary provider name.
 */
export const socialProviderSchema = z.strictObject({
	provider: z.literal("google"),
});
export const createOrganizationSchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			"Use lowercase words separated by single hyphens.",
		),
});

export const authFailureMessages = {
	INVALID_INPUT: "Check the submitted fields and try again.",
	INVALID_CREDENTIALS:
		"That email address and password do not match an account.",
	EMAIL_TAKEN: "An account already exists for that email address.",
	ACCOUNT_DISABLED: "This account has been disabled.",
	AUTH_REQUIRED: "Sign in to continue.",
	FORBIDDEN: "You are not a member of that organization.",
	SLUG_TAKEN: "That organization address is already in use.",
	AUTH_UNAVAILABLE:
		"Sign-in is temporarily unavailable. Try again in a moment.",
} as const;

export type AuthFailureCode = keyof typeof authFailureMessages;
export type AuthActionResult =
	| { ok: true }
	| { ok: false; error: { code: AuthFailureCode; message: string } };
/**
 * Social sign-in is a redirect, not a credential exchange: the server returns
 * the provider URL for the browser to visit. The URL is always validated as
 * https before it leaves the server.
 */
export type SocialSignInResult =
	| { ok: true; url: string }
	| { ok: false; error: { code: AuthFailureCode; message: string } };
export type SessionUser = {
	id: string;
	email: string;
	name: string;
};
export type AuthRole = "owner" | "admin" | "member" | "viewer";
export type SessionOrganization = {
	id: string;
	name: string;
	slug: string;
	role: AuthRole;
};
export type SessionView = {
	user: SessionUser | null;
	organizations: SessionOrganization[];
	activeOrganizationId: string | null;
};

/**
 * The runtime's authentication posture.
 *
 * - `demo`: an explicit development/test mode with a fixed trusted scope.
 * - `authenticated`: a trusted session with at least one organization.
 * - `anonymous`: a configured auth host, but nobody is signed in.
 * - `unavailable`: no usable auth host, so nothing may be served.
 */
export type AuthState =
	| { mode: "demo" }
	| { mode: "anonymous" }
	| { mode: "unavailable" }
	| { mode: "authenticated"; session: SessionView };

export type OrganizationSummary = {
	id: string;
	name: string;
	slug: string;
	role: AuthRole;
};
export type OrganizationActionResult =
	| { ok: true; organization: OrganizationSummary }
	| { ok: false; error: { code: AuthFailureCode; message: string } };

export function authFailure(code: AuthFailureCode): AuthActionResult {
	return { ok: false, error: { code, message: authFailureMessages[code] } };
}
