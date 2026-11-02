import "@tanstack/react-start/server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type GitHubInstallationRepository,
	hasCapability,
	type PgSql,
	PostgresGitHubInstallationRepository,
	PostgresRepositoryRepository,
	type RepositoryRepository,
} from "@isolate/db";
import {
	createGitHubAppClient,
	type GitHubAppCredentials,
	listInstallationRepositories as listAppInstallationRepositories,
} from "@isolate/integrations";
import {
	type OrganizationId,
	PlatformError,
	type UserId,
} from "@isolate/shared";
import { z } from "zod";
import {
	type GitHubSetupFailureCode,
	type GitHubSetupResult,
	type InstallationRepositoriesReadModel,
	importRepositoriesSchema,
	type RepositoriesImportResult,
	type RepositorySummary,
	type StartGitHubInstallResult,
} from "../features/repositories/contracts";
import { summarizeRepositoryRow } from "./catalog-read.server";
import {
	assertJsonRequest,
	assertSameOrigin,
	RequestGuardError,
} from "./request-guard.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";
import { getUiSql, requireUiScope } from "./ui-runtime.server";

/**
 * Per-organization GitHub App onboarding (wave 23).
 *
 * Flow: `/api/github/install` signs a short-lived state (organization, user,
 * nonce) and redirects to GitHub; `/api/github/callback` verifies the state and
 * the caller's membership, then stores the installation; `/api/github/repositories`
 * lists the installation's repositories; `/api/repositories/import` imports at
 * most 25 of them.
 *
 * SECURITY:
 * - Identity is the server session + membership row, never a request field.
 * - State is HMAC-SHA256 signed, expires after 10 minutes, and binds the
 *   organization, user and a random nonce. No state table exists.
 * - The App private key, App JWT and installation token never leave this
 *   module: no token, key or state is logged, echoed or returned.
 * - A missing App configuration is a fixed `GITHUB_APP_NOT_CONFIGURED`
 *   result, never a crash or a partially configured flow.
 */

export const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
export const GITHUB_INSTALL_CLOCK_SKEW_MS = 60 * 1000;
export const GITHUB_INSTALL_MAX_BODY_BYTES = 16 * 1024;
export const GITHUB_APP_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
export const MIN_GITHUB_STATE_SECRET_CHARS = 32;

export type GitHubAppRuntimeConfig = {
	readonly slug: string;
	readonly appId: string;
	readonly privateKeyPem: string;
	readonly stateSecret: string;
	readonly apiBaseUrl?: string;
};

/** Platform error used only inside this module (never serialized). */
export class GitHubAppNotConfiguredError extends Error {
	constructor() {
		super("GitHub App is not configured");
		this.name = "GitHubAppNotConfiguredError";
	}
}

/** Fixed failure text; no entry interpolates request data or env values. */
export const GITHUB_SETUP_FAILURE_MESSAGES: Record<
	GitHubSetupFailureCode,
	string
> = {
	INVALID_INPUT: "The GitHub request is invalid.",
	AUTH_REQUIRED: "Sign in to connect GitHub.",
	FORBIDDEN:
		"This action requires an owner or admin role in this organization.",
	NOT_FOUND: "The requested GitHub record was not found.",
	RATE_LIMITED: "GitHub is rate limiting Isolate. Try again shortly.",
	GITHUB_APP_NOT_CONFIGURED:
		"The GitHub App is not configured for this deployment.",
	GITHUB_INSTALLATION_REQUIRED:
		"Install the Isolate GitHub App for this organization first.",
	UNAVAILABLE: "GitHub is temporarily unavailable.",
};

const FAILURE_STATUS: Record<GitHubSetupFailureCode, number> = {
	INVALID_INPUT: 400,
	AUTH_REQUIRED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	RATE_LIMITED: 429,
	GITHUB_APP_NOT_CONFIGURED: 503,
	GITHUB_INSTALLATION_REQUIRED: 409,
	UNAVAILABLE: 503,
};

function failure<T>(code: GitHubSetupFailureCode): GitHubSetupResult<T> {
	return {
		ok: false,
		error: { code, message: GITHUB_SETUP_FAILURE_MESSAGES[code] },
	};
}

function failureFromError<T>(error: unknown): GitHubSetupResult<T> {
	if (error instanceof GitHubAppNotConfiguredError) {
		return failure("GITHUB_APP_NOT_CONFIGURED");
	}
	if (error instanceof RequestGuardError) {
		return failure(error.status === 403 ? "FORBIDDEN" : "INVALID_INPUT");
	}
	if (error instanceof ControlPlaneError) {
		if (error.code === "AUTH_REQUIRED") return failure("AUTH_REQUIRED");
		if (error.code === "FORBIDDEN") return failure("FORBIDDEN");
		if (error.code === "INVALID_INPUT") return failure("INVALID_INPUT");
		return failure("UNAVAILABLE");
	}
	if (error instanceof PlatformError) {
		switch (error.code) {
			case "MISSING_CONFIG":
				return failure("GITHUB_APP_NOT_CONFIGURED");
			case "VALIDATION_FAILED":
				return failure("INVALID_INPUT");
			case "NOT_FOUND":
				return failure("NOT_FOUND");
			case "RATE_LIMITED":
				return failure("RATE_LIMITED");
			case "POLICY_DENIED":
				return failure("FORBIDDEN");
			default:
				return failure("UNAVAILABLE");
		}
	}
	// Never serialize a driver error, stack or provider body.
	return failure("UNAVAILABLE");
}

function requireManageCapability(scope: CallerScope): void {
	if (!hasCapability(scope.role, "member:manage")) {
		throw new ControlPlaneError("FORBIDDEN");
	}
}

function configuredAppCredentials(
	config: GitHubAppRuntimeConfig | null,
	fetchImpl?: typeof fetch,
	now?: () => number,
): GitHubAppCredentials {
	if (config === null) throw new GitHubAppNotConfiguredError();
	return {
		appId: config.appId,
		privateKeyPem: config.privateKeyPem,
		...(config.apiBaseUrl === undefined
			? {}
			: { apiBaseUrl: config.apiBaseUrl }),
		...(fetchImpl === undefined ? {} : { fetchImpl }),
		...(now === undefined ? {} : { now }),
	};
}

/**
 * Reads the deployment's App identity. Any missing/incomplete value returns
 * `null` (a fixed NOT_CONFIGURED result at the boundary), never a throw that
 * could surface a path or key fragment. No value is logged.
 */
export function readGitHubAppRuntimeConfig(
	env: Record<string, string | undefined>,
): GitHubAppRuntimeConfig | null {
	const slug = env.GITHUB_APP_SLUG?.trim();
	const appId = env.GITHUB_APP_ID?.trim();
	const stateSecret = env.GITHUB_APP_STATE_SECRET?.trim();
	if (
		slug === undefined ||
		!GITHUB_APP_SLUG_PATTERN.test(slug) ||
		appId === undefined ||
		!/^\d+$/.test(appId) ||
		stateSecret === undefined ||
		stateSecret.length < MIN_GITHUB_STATE_SECRET_CHARS
	) {
		return null;
	}
	const inlineKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
	const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
	let privateKeyPem: string;
	if (inlineKey?.includes("END PRIVATE KEY") === true) {
		privateKeyPem = inlineKey;
	} else if (keyPath !== undefined && keyPath.length > 0) {
		try {
			privateKeyPem = readFileSync(keyPath, "utf8");
		} catch {
			return null;
		}
		if (!privateKeyPem.includes("END PRIVATE KEY")) return null;
	} else {
		return null;
	}
	const apiBaseUrl = env.GITHUB_API_BASE_URL?.trim();
	return {
		slug,
		appId,
		privateKeyPem,
		stateSecret,
		...(apiBaseUrl === undefined || apiBaseUrl.length === 0
			? {}
			: { apiBaseUrl }),
	};
}

const installStateSchema = z
	.strictObject({
		v: z.literal(1),
		organizationId: z.uuid(),
		userId: z.uuid(),
		nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().positive(),
	})
	.strict();

export type GitHubInstallState = {
	organizationId: OrganizationId;
	userId: UserId;
	nonce: string;
	issuedAt: number;
	expiresAt: number;
};

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

/**
 * Builds a signed state token. The payload is bounded JSON; the signature is
 * HMAC-SHA256 over the encoded payload with the server-only state secret.
 */
export function createGitHubInstallState(input: {
	organizationId: OrganizationId;
	userId: UserId;
	secret: string;
	now?: Date | number;
	nonce?: string;
}): { state: string; expiresAt: Date } {
	if (
		typeof input.secret !== "string" ||
		input.secret.length < MIN_GITHUB_STATE_SECRET_CHARS
	) {
		throw new GitHubAppNotConfiguredError();
	}
	const nowMs =
		input.now === undefined
			? Date.now()
			: typeof input.now === "number"
				? input.now
				: input.now.getTime();
	const issuedAt = Math.floor(nowMs);
	const expiresAt = issuedAt + GITHUB_INSTALL_STATE_TTL_MS;
	const nonce = input.nonce ?? randomBytes(16).toString("base64url");
	const payload = {
		v: 1 as const,
		organizationId: input.organizationId,
		userId: input.userId,
		nonce,
		issuedAt,
		expiresAt,
	};
	const encoded = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
	const signature = base64Url(
		createHmac("sha256", input.secret).update(encoded).digest(),
	);
	return { state: `${encoded}.${signature}`, expiresAt: new Date(expiresAt) };
}

/** Verifies signature, age, expiry and shape. Any failure returns `null`. */
export function verifyGitHubInstallState(
	state: string,
	options: { secret: string; now?: Date | number },
): GitHubInstallState | null {
	if (
		typeof state !== "string" ||
		state.length === 0 ||
		state.length > 2048 ||
		typeof options.secret !== "string" ||
		options.secret.length < MIN_GITHUB_STATE_SECRET_CHARS
	) {
		return null;
	}
	const separator = state.lastIndexOf(".");
	if (separator <= 0 || separator === state.length - 1) return null;
	const encoded = state.slice(0, separator);
	const provided = state.slice(separator + 1);
	if (!/^[A-Za-z0-9_-]{43}$/.test(provided)) return null;
	const expected = createHmac("sha256", options.secret)
		.update(encoded)
		.digest();
	let supplied: Buffer;
	try {
		supplied = Buffer.from(provided, "base64url");
	} catch {
		return null;
	}
	if (
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	const result = installStateSchema.safeParse(parsed);
	if (!result.success) return null;
	const nowMs =
		options.now === undefined
			? Date.now()
			: typeof options.now === "number"
				? options.now
				: options.now.getTime();
	if (
		result.data.expiresAt <= nowMs ||
		result.data.issuedAt > nowMs + GITHUB_INSTALL_CLOCK_SKEW_MS ||
		result.data.expiresAt - result.data.issuedAt >
			GITHUB_INSTALL_STATE_TTL_MS ||
		result.data.expiresAt - nowMs > GITHUB_INSTALL_STATE_TTL_MS
	) {
		return null;
	}
	return {
		organizationId: result.data.organizationId as OrganizationId,
		userId: result.data.userId as UserId,
		nonce: result.data.nonce,
		issuedAt: result.data.issuedAt,
		expiresAt: result.data.expiresAt,
	};
}

/* ------------------------------------------------------------------------- */
/* Service                                                                    */
/* ------------------------------------------------------------------------- */

const completeInstallInputSchema = z
	.strictObject({
		state: z.string().min(1).max(2048),
		installationId: z.string().regex(/^[1-9][0-9]{0,19}$/),
		setupAction: z.string().min(1).max(32).optional(),
	})
	.strict();

export type CompleteGitHubInstallInput = z.input<
	typeof completeInstallInputSchema
>;

export type CompleteGitHubInstallResult = {
	installationId: string;
	accountLogin: string;
};

export type GitHubInstallServiceDependencies = {
	installations: GitHubInstallationRepository;
	repositories: RepositoryRepository;
	appConfig: GitHubAppRuntimeConfig | null;
	fetchImpl?: typeof fetch;
	now?: () => number;
};

export type GitHubInstallService = {
	startInstall(
		scope: CallerScope,
	): Promise<GitHubSetupResult<StartGitHubInstallResult>>;
	completeInstall(
		scope: CallerScope,
		input: unknown,
	): Promise<GitHubSetupResult<CompleteGitHubInstallResult>>;
	listRepositories(
		scope: CallerScope,
	): Promise<GitHubSetupResult<InstallationRepositoriesReadModel>>;
	importRepositories(
		scope: CallerScope,
		input: unknown,
	): Promise<GitHubSetupResult<RepositoriesImportResult>>;
};

function appClient(dependencies: GitHubInstallServiceDependencies) {
	return createGitHubAppClient(
		configuredAppCredentials(
			dependencies.appConfig,
			dependencies.fetchImpl,
			dependencies.now,
		),
	);
}

async function activeInstallation(
	dependencies: GitHubInstallServiceDependencies,
	organizationId: OrganizationId,
) {
	const installation =
		await dependencies.installations.findActiveByOrganization(organizationId);
	if (installation === null) {
		throw new PlatformError(
			"NOT_FOUND",
			"no active GitHub installation for this organization",
		);
	}
	return installation;
}

export function createGitHubInstallService(
	dependencies: GitHubInstallServiceDependencies,
): GitHubInstallService {
	const raw: GitHubInstallService = {
		async startInstall(scope) {
			requireManageCapability(scope);
			const config = dependencies.appConfig;
			if (config === null) throw new GitHubAppNotConfiguredError();
			const nowMs =
				dependencies.now === undefined ? Date.now() : dependencies.now();
			const { state } = createGitHubInstallState({
				organizationId: scope.organizationId,
				userId: scope.userId,
				now: nowMs,
				secret: config.stateSecret,
			});
			return {
				ok: true,
				value: {
					url: `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`,
				},
			};
		},

		async completeInstall(scope, input) {
			requireManageCapability(scope);
			const parsed = completeInstallInputSchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			const config = dependencies.appConfig;
			if (config === null) throw new GitHubAppNotConfiguredError();
			const state = verifyGitHubInstallState(parsed.data.state, {
				secret: config.stateSecret,
				...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
			});
			if (state === null) return failure("INVALID_INPUT");
			if (
				state.organizationId !== scope.organizationId ||
				state.userId !== scope.userId
			) {
				return failure("FORBIDDEN");
			}
			const details = await appClient(dependencies).getInstallation({
				installationId: parsed.data.installationId,
			});
			const stored = await dependencies.installations.upsert({
				organizationId: scope.organizationId,
				installationId: details.installationId,
				accountLogin: details.accountLogin,
				accountType: details.accountType,
				repositorySelection: details.repositorySelection,
				status: "active",
				createdBy: scope.userId,
			});
			// The numeric installation id is globally unique: a row owned by
			// another tenant is a fixed refusal, not a reassignment.
			if (stored === null) return failure("FORBIDDEN");
			return {
				ok: true,
				value: {
					installationId: stored.installation_id,
					accountLogin: stored.account_login,
				},
			};
		},

		async listRepositories(scope) {
			requireManageCapability(scope);
			if (dependencies.appConfig === null) {
				throw new GitHubAppNotConfiguredError();
			}
			const installation = await activeInstallation(
				dependencies,
				scope.organizationId,
			);
			const result = await listAppInstallationRepositories(
				{
					client: appClient(dependencies),
					...(dependencies.fetchImpl === undefined
						? {}
						: { fetchImpl: dependencies.fetchImpl }),
					...(dependencies.appConfig.apiBaseUrl === undefined
						? {}
						: { apiBaseUrl: dependencies.appConfig.apiBaseUrl }),
				},
				{ installationId: installation.installation_id },
			);
			return {
				ok: true,
				value: {
					repositories: result.repositories.map((repository) => ({
						fullName: repository.fullName,
						defaultBranch: repository.defaultBranch,
						private: repository.private,
						installationId: repository.installationId,
					})),
					truncated: result.truncated,
				},
			};
		},

		async importRepositories(scope, input) {
			requireManageCapability(scope);
			const parsed = importRepositoriesSchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			if (dependencies.appConfig === null) {
				throw new GitHubAppNotConfiguredError();
			}
			const installation = await activeInstallation(
				dependencies,
				scope.organizationId,
			);
			const available = await listAppInstallationRepositories(
				{
					client: appClient(dependencies),
					...(dependencies.fetchImpl === undefined
						? {}
						: { fetchImpl: dependencies.fetchImpl }),
					...(dependencies.appConfig.apiBaseUrl === undefined
						? {}
						: { apiBaseUrl: dependencies.appConfig.apiBaseUrl }),
				},
				{ installationId: installation.installation_id },
			);
			const byFullName = new Map(
				available.repositories.map((repository) => [
					repository.fullName.toLowerCase(),
					repository,
				]),
			);
			const imported: RepositorySummary[] = [];
			const skipped: string[] = [];
			for (const requested of parsed.data.fullNames) {
				const repository = byFullName.get(requested.toLowerCase());
				if (repository === undefined) {
					skipped.push(requested);
					continue;
				}
				const created = await dependencies.repositories.create({
					organizationId: scope.organizationId,
					externalFullName: repository.fullName,
					defaultBranch: repository.defaultBranch,
					githubInstallationId: installation.id,
				});
				if (!created.ok) {
					// Duplicate inside the tenant: idempotent skip.
					skipped.push(requested);
					continue;
				}
				imported.push(summarizeRepositoryRow(created.repository));
			}
			return { ok: true, value: { imported, skipped } };
		},
	};

	// Every method is total: configuration, repository and provider failures
	// collapse to the fixed result union instead of throwing at a route.
	const guard = <T>(
		action: () => Promise<GitHubSetupResult<T>>,
	): Promise<GitHubSetupResult<T>> =>
		action().catch((error: unknown) => failureFromError<T>(error));
	return {
		startInstall: (scope) => guard(() => raw.startInstall(scope)),
		completeInstall: (scope, input) =>
			guard(() => raw.completeInstall(scope, input)),
		listRepositories: (scope) => guard(() => raw.listRepositories(scope)),
		importRepositories: (scope, input) =>
			guard(() => raw.importRepositories(scope, input)),
	};
}

function dependenciesFor(
	sql: PgSql,
	env: Record<string, string | undefined>,
	overrides: Pick<GitHubInstallServiceDependencies, "fetchImpl" | "now"> = {},
): GitHubInstallServiceDependencies {
	return {
		installations: new PostgresGitHubInstallationRepository(sql),
		repositories: new PostgresRepositoryRepository(sql),
		appConfig: readGitHubAppRuntimeConfig(env),
		...overrides,
	};
}

export function createGitHubInstallServiceForSql(
	sql: PgSql,
	env: Record<string, string | undefined> = process.env,
	overrides: Pick<GitHubInstallServiceDependencies, "fetchImpl" | "now"> = {},
): GitHubInstallService {
	return createGitHubInstallService(dependenciesFor(sql, env, overrides));
}

/**
 * Resolves the trusted caller and runs one service call. Failures collapse to
 * the fixed `GitHubSetupResult` union; nothing thrown escapes to a route.
 */
export async function runGitHubSetupAction<T>(
	action: (
		scope: CallerScope,
		service: GitHubInstallService,
	) => Promise<GitHubSetupResult<T>>,
	options: { env?: Record<string, string | undefined> } = {},
): Promise<GitHubSetupResult<T>> {
	try {
		const scope = await requireUiScope("member:manage");
		const service = createGitHubInstallServiceForSql(
			getUiSql(),
			options.env ?? process.env,
		);
		return await action(scope, service);
	} catch (error) {
		return failureFromError(error);
	}
}

/* ------------------------------------------------------------------------- */
/* Route adapters                                                             */
/* ------------------------------------------------------------------------- */

const NO_STORE = { "cache-control": "no-store" } as const;

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function failureResponse<T>(result: GitHubSetupResult<T>): Response {
	if (result.ok) return json(200, result.value);
	return json(FAILURE_STATUS[result.error.code], {
		error: result.error,
	});
}

function tooLarge(): Response {
	return json(413, { error: "The request body is too large." });
}

class BodyTooLargeError extends Error {
	constructor() {
		super("body too large");
		this.name = "BodyTooLargeError";
	}
}

async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes) {
			throw new BodyTooLargeError();
		}
	}
	if (request.body === null) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let finished = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				finished = true;
				break;
			}
			total += next.value.byteLength;
			if (total > maxBytes) throw new BodyTooLargeError();
			chunks.push(next.value);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readJsonObject(
	request: Request,
	maxBytes: number,
): Promise<unknown> {
	let text: string;
	try {
		text = await readBoundedBody(request, maxBytes);
	} catch (error) {
		if (error instanceof BodyTooLargeError) throw error;
		throw new ControlPlaneError("INVALID_INPUT");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ControlPlaneError("INVALID_INPUT");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ControlPlaneError("INVALID_INPUT");
	}
	return parsed;
}

const CONNECTED_REDIRECT = "/repositories?github=connected";

function callbackRedirect(code?: GitHubSetupFailureCode): Response {
	const location =
		code === undefined
			? CONNECTED_REDIRECT
			: `/repositories?github=error&code=${encodeURIComponent(code)}`;
	return new Response(null, {
		status: 302,
		headers: { location, ...NO_STORE },
	});
}

export type GitHubRouteOptions = {
	env?: Record<string, string | undefined>;
	/** Route tests supply the resolved scope; production resolves the session. */
	scope?: CallerScope;
	service?: GitHubInstallService;
};

async function serviceAction<T>(
	options: GitHubRouteOptions,
	action: (
		scope: CallerScope,
		service: GitHubInstallService,
	) => Promise<GitHubSetupResult<T>>,
): Promise<GitHubSetupResult<T>> {
	try {
		const scope = options.scope ?? (await requireUiScope("member:manage"));
		const service =
			options.service ??
			createGitHubInstallServiceForSql(getUiSql(), options.env ?? process.env);
		return await action(scope, service);
	} catch (error) {
		return failureFromError(error);
	}
}

/** `GET /api/github/install` → 302 to GitHub's installation page. */
export async function handleGitHubInstallRoute(
	_request: Request,
	options: GitHubRouteOptions = {},
): Promise<Response> {
	const result = await serviceAction(options, (scope, service) =>
		service.startInstall(scope),
	);
	if (!result.ok) return failureResponse(result);
	return new Response(null, {
		status: 302,
		headers: { location: result.value.url, ...NO_STORE },
	});
}

/** `GET /api/github/callback` → verifies state, stores, redirects to the app. */
export async function handleGitHubCallbackRoute(
	request: Request,
	options: GitHubRouteOptions = {},
): Promise<Response> {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return callbackRedirect("INVALID_INPUT");
	}
	const state = url.searchParams.get("state");
	const installationId = url.searchParams.get("installation_id");
	const setupAction = url.searchParams.get("setup_action");
	if (state === null || installationId === null) {
		return callbackRedirect("INVALID_INPUT");
	}
	const result = await serviceAction(options, (scope, service) =>
		service.completeInstall(scope, {
			state,
			installationId,
			...(setupAction === null ? {} : { setupAction }),
		}),
	);
	return result.ok ? callbackRedirect() : callbackRedirect(result.error.code);
}

/** `GET /api/github/repositories` → bounded installation repository list. */
export async function handleGitHubRepositoriesRoute(
	_request: Request,
	options: GitHubRouteOptions = {},
): Promise<Response> {
	const result = await serviceAction(options, (scope, service) =>
		service.listRepositories(scope),
	);
	return failureResponse(result);
}

/** `POST /api/repositories/import` with `{ fullNames: string[] }` (<= 25). */
export async function handleRepositoryImportRoute(
	request: Request,
	options: GitHubRouteOptions = {},
): Promise<Response> {
	try {
		assertSameOrigin(request);
		assertJsonRequest(request);
	} catch (error) {
		return failureResponse(failureFromError(error));
	}
	let input: unknown;
	try {
		input = await readJsonObject(request, GITHUB_INSTALL_MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof BodyTooLargeError) return tooLarge();
		return failureResponse(failure("INVALID_INPUT"));
	}
	const result = await serviceAction(options, (scope, service) =>
		service.importRepositories(scope, input),
	);
	return failureResponse(result);
}
