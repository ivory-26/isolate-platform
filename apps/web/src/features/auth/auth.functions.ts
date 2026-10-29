import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	getAuthService,
	getAuthState as readAuthState,
} from "../../server/runtime.server";
import {
	type AuthActionResult,
	type AuthState,
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
} from "./contracts";

/**
 * The auth service needs a database and a Neon Auth configuration. When either
 * is missing the call fails closed with a bounded message instead of throwing.
 */
function service() {
	try {
		return getAuthService();
	} catch {
		return null;
	}
}

export const signIn = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = signInSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid sign-in request.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<AuthActionResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime) return authFailure("AUTH_UNAVAILABLE");
		return runtime.signIn(data);
	});

export const signUp = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = signUpSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid sign-up request.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<AuthActionResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime) return authFailure("AUTH_UNAVAILABLE");
		return runtime.signUp(data);
	});

export const startGoogleSignIn = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = socialProviderSchema.safeParse(input);
		if (!parsed.success) throw new Error("Unsupported sign-in provider.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<SocialSignInResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime)
			return {
				ok: false,
				error: {
					code: "AUTH_UNAVAILABLE",
					message: authFailureMessages.AUTH_UNAVAILABLE,
				},
			};
		return runtime.startGoogleSignIn(data);
	});

export const signOut = createServerFn({ method: "POST" }).handler(
	async (): Promise<AuthActionResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime) return authFailure("AUTH_UNAVAILABLE");
		return runtime.signOut();
	},
);

export const getSession = createServerFn({ method: "GET" }).handler(
	async (): Promise<SessionView> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime)
			return { user: null, organizations: [], activeOrganizationId: null };
		return runtime.currentSession();
	},
);

export const selectOrganization = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = selectOrganizationSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid organization selection.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<AuthActionResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime) return authFailure("AUTH_UNAVAILABLE");
		return runtime.selectOrganization(data);
	});

export const createOrganization = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = createOrganizationSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid organization request.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<OrganizationActionResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		const runtime = service();
		if (!runtime)
			return {
				ok: false,
				error: {
					code: "AUTH_UNAVAILABLE",
					message: authFailureMessages.AUTH_UNAVAILABLE,
				},
			};
		return runtime.createOrganization(data);
	});

/**
 * The runtime's authentication posture. It never carries a tenant's data, so
 * it is safe to render in the shared shell.
 */
export const getAuthState = createServerFn({ method: "GET" }).handler(
	async (): Promise<AuthState> => {
		setResponseHeader("Cache-Control", "private, no-store");
		return readAuthState();
	},
);
