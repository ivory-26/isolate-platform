import { describe, expect, test } from "bun:test";
import type { OrganizationId } from "@isolate/shared";
import type { NeonAuthServer } from "@neondatabase/auth/server";
import {
	createAuthService,
	readAuthRedirectUrl,
	socialCallbackUrl,
} from "./auth-service.server";
import { completeOAuthCallback } from "./oauth-callback.server";

const ORIGIN = "https://app.example.com";
const SETTINGS = {
	baseUrl: "https://auth.example.com/neondb/auth",
	cookieSecret: "x".repeat(32),
	sameSite: "lax" as const,
};

describe("readAuthRedirectUrl", () => {
	test("accepts a plain public https URL", () => {
		expect(
			readAuthRedirectUrl({
				url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
			}),
		).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
	});

	test("rejects non-https, userinfo, localhost and non-URL values", () => {
		for (const data of [
			null,
			{},
			{ url: 42 },
			{ url: "http://accounts.google.com/x" },
			{ url: "https://user:pass@accounts.google.com/x" },
			{ url: "https://localhost/x" },
			{ url: "https://machine.local/x" },
			{ url: "not a url" },
		]) {
			expect(readAuthRedirectUrl(data)).toBeNull();
		}
	});
});

describe("socialCallbackUrl", () => {
	test("builds a same-origin callback without trailing slash", () => {
		expect(socialCallbackUrl(ORIGIN)).toBe(`${ORIGIN}/auth/callback`);
	});

	test("rejects malformed origins", () => {
		expect(socialCallbackUrl("javascript:alert(1)")).toBeNull();
		expect(socialCallbackUrl("https://app.example.com/path")).toBeNull();
		expect(socialCallbackUrl("https://user@app.example.com")).toBeNull();
	});
});

type SocialCall = {
	provider: string;
	callbackURL?: string;
	disableRedirect?: boolean;
};

function serviceWith(options: {
	socialResult?: { data: unknown; error: unknown };
	origin?: string;
}) {
	const calls: SocialCall[] = [];
	const server = {
		signIn: {
			social: async (input: SocialCall) => {
				calls.push(input);
				return (
					options.socialResult ?? {
						data: { url: "https://accounts.google.com/x" },
						error: null,
					}
				);
			},
		},
		getSession: async () => ({ data: null, error: null }),
	} as unknown as NeonAuthServer;
	const service = createAuthService({
		server,
		memberships: {} as never,
		organizations: {} as never,
		ensureTenancy: async () => {},
		readActiveOrganization: () => undefined as OrganizationId | undefined,
		writeActiveOrganization: () => {},
		requestOrigin: () => options.origin ?? ORIGIN,
	});
	return { service, calls };
}

describe("startGoogleSignIn", () => {
	test("returns the provider URL and requests a same-origin callback", async () => {
		const { service, calls } = serviceWith({});
		expect(await service.startGoogleSignIn({ provider: "google" })).toEqual({
			ok: true,
			url: "https://accounts.google.com/x",
		});
		expect(calls).toEqual([
			{
				provider: "google",
				callbackURL: `${ORIGIN}/auth/callback`,
				disableRedirect: true,
			},
		]);
	});

	test("maps upstream failures and invalid input to bounded codes", async () => {
		const failing = serviceWith({
			socialResult: {
				data: null,
				error: { code: "INVALID_OAUTH_CONFIGURATION" },
			},
		});
		expect(
			await failing.service.startGoogleSignIn({ provider: "google" }),
		).toMatchObject({ ok: false, error: { code: "AUTH_UNAVAILABLE" } });

		const { service } = serviceWith({});
		expect(
			await service.startGoogleSignIn({ provider: "github" }),
		).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
	});

	test("fails closed when the request origin is unusable", async () => {
		const { service } = serviceWith({ origin: "not-an-origin" });
		expect(
			await service.startGoogleSignIn({ provider: "google" }),
		).toMatchObject({ ok: false, error: { code: "AUTH_UNAVAILABLE" } });
	});

	test("refuses a provider response without a safe URL", async () => {
		const { service } = serviceWith({
			socialResult: {
				data: { url: "http://accounts.google.com/x" },
				error: null,
			},
		});
		expect(
			await service.startGoogleSignIn({ provider: "google" }),
		).toMatchObject({ ok: false, error: { code: "AUTH_UNAVAILABLE" } });
	});
});

describe("completeOAuthCallback", () => {
	test("relays the exchange cookies and the cleaned redirect", async () => {
		const response = await completeOAuthCallback(
			new Request(`${ORIGIN}/auth/callback?neon_auth_session_verifier=v`),
			SETTINGS,
			async () => ({
				action: "redirect_oauth" as const,
				redirectUrl: new URL(`${ORIGIN}/auth/callback`),
				cookies: ["__Secure-neon-auth.session_token=abc; Path=/; Secure"],
			}),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/callback`);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.getSetCookie()).toEqual([
			"__Secure-neon-auth.session_token=abc; Path=/; Secure",
		]);
	});

	test("sends authenticated callers home and failures back to login", async () => {
		const allowed = await completeOAuthCallback(
			new Request(`${ORIGIN}/auth/callback`),
			SETTINGS,
			async () => ({ action: "allow" as const, headers: {}, cookies: [] }),
		);
		expect(allowed.headers.get("location")).toBe(`${ORIGIN}/`);

		const failed = await completeOAuthCallback(
			new Request(`${ORIGIN}/auth/callback`),
			SETTINGS,
			async () => {
				throw new Error("upstream down");
			},
		);
		expect(failed.headers.get("location")).toBe(
			`${ORIGIN}/login?authError=callback`,
		);
	});
});
