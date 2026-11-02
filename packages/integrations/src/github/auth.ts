import { PlatformError } from "@isolate/shared";
import type { GitHubCredentials } from "./types";

/**
 * GitHub App token contract (wave 7).
 *
 * Installation tokens are minted server-side from the App private key, scoped
 * to one repository and least privilege, cached only until shortly before
 * expiry, and never logged, echoed in errors, or placed in a URL. The token is
 * consumed by the sandbox clone helper through create-time environment only.
 */
export type GitHubRepoPermission = "read" | "write";

/**
 * Permissions a token may request. `contents` stays required (defaults are
 * unchanged); wave 13 adds the read scopes for context assembly and the narrow
 * write scopes for audited comment/rerun calls:
 *
 *  - `actions: read` — workflow runs and job metadata (never log bodies)
 *  - `checks: read` — check suites and check runs
 *  - `issues: write` — comment on a pull request/issue
 *  - `administration: read` — branch protection and rulesets
 *
 * The minted token can never exceed what the App installation was granted.
 */
export type GitHubInstallationTokenRequest = {
	/** `owner/name`; the token is scoped to this repository only. */
	readonly repositoryFullName: string;
	readonly contents: GitHubRepoPermission;
	readonly pullRequests?: GitHubRepoPermission;
	readonly actions?: GitHubRepoPermission;
	readonly checks?: GitHubRepoPermission;
	readonly issues?: GitHubRepoPermission;
	readonly administration?: GitHubRepoPermission;
};

export type GitHubInstallationToken = {
	readonly token: string;
	/** ISO-8601 expiry reported by GitHub. */
	readonly expiresAt: string;
};

export interface GitHubTokenProvider {
	getInstallationToken(
		request: GitHubInstallationTokenRequest,
	): Promise<GitHubInstallationToken>;
}

export type GitHubTokenProviderOptions = {
	readonly appId: string;
	/** RSA private key in PKCS#8 PEM form; server-only. */
	readonly privateKeyPem: string;
	readonly installationId: string;
	readonly apiBaseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
};

/** App identity without a bound installation (wave 23 per-org installs). */
export type GitHubAppCredentials = {
	readonly appId: string;
	/** RSA private key in PKCS#8 PEM form; server-only. */
	readonly privateKeyPem: string;
	readonly apiBaseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
};

export type GitHubInstallationTokenByIdRequest = {
	/** Numeric installation id supplied by the caller (already tenant-bound). */
	readonly installationId: string;
	/** Optional bare repository name; when present the token is repo-scoped. */
	readonly repositoryName?: string;
	readonly permissions?: Readonly<Record<string, GitHubRepoPermission>>;
};

export type GitHubAppInstallationDetails = {
	readonly installationId: string;
	readonly accountLogin: string;
	readonly accountType: "User" | "Organization";
	readonly repositorySelection: "all" | "selected";
};

export interface GitHubInstallationTokenResolver {
	getInstallationToken(
		input: GitHubInstallationTokenByIdRequest,
	): Promise<GitHubInstallationToken>;
}

/** App JWT surface: mints tokens/details for a supplied installation id. */
export interface GitHubAppClient extends GitHubInstallationTokenResolver {
	getInstallation(input: {
		readonly installationId: string;
	}): Promise<GitHubAppInstallationDetails>;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_USER_AGENT = "isolate-platform";
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh this far ahead of `expires_at` so a token cannot expire in flight. */
const CACHE_SKEW_MS = 300_000;
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 600;
const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PKCS8_PEM_PATTERN =
	/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const WIRE_PERMISSION_NAMES = [
	"contents",
	"pull_requests",
	"actions",
	"checks",
	"issues",
	"administration",
] as const;

type NormalizedAppConfig = {
	readonly appId: string;
	readonly apiBaseUrl: string;
	readonly privateKeyDer: ArrayBuffer;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;
};

type NormalizedConfig = NormalizedAppConfig & {
	readonly installationId: string;
};

type ValidatedRequest = {
	readonly repositoryFullName: string;
	readonly repositoryName: string;
	/** Wire-shaped permissions (`pull_requests`, `administration`, ...). */
	readonly permissions: Readonly<Record<string, GitHubRepoPermission>>;
};

type CacheEntry = {
	readonly token: string;
	readonly expiresAt: string;
	readonly expiresAtMs: number;
};

function configError(message: string): PlatformError {
	return new PlatformError("MISSING_CONFIG", message);
}

function parseNumericIdentifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		throw configError(`GitHub App ${label} must be a numeric string`);
	}
	const numeric = Number(value);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) {
		throw configError(`GitHub App ${label} must be a positive safe integer`);
	}
	return value;
}

/** Accepts PEM text with real newlines, literal `\n` escapes, CRLF, or quotes. */
function normalizePemText(pem: string): string {
	let normalized = pem.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim();
	if (
		(normalized.startsWith('"') && normalized.endsWith('"')) ||
		(normalized.startsWith("'") && normalized.endsWith("'"))
	) {
		normalized = normalized.slice(1, -1).trim();
	}
	return normalized;
}

function pemToDer(pem: unknown): ArrayBuffer {
	if (typeof pem !== "string") {
		throw configError("GitHub App private key must be a PKCS#8 PEM string");
	}
	const match = PKCS8_PEM_PATTERN.exec(normalizePemText(pem));
	if (match === null) {
		throw configError("GitHub App private key must be a PKCS#8 PEM block");
	}
	const base64 = match[1].replace(/\s+/g, "");
	if (base64.length === 0 || !BASE64_BODY_PATTERN.test(base64)) {
		throw configError("GitHub App private key PEM body is not valid base64");
	}
	let binary: string;
	try {
		binary = atob(base64);
	} catch {
		throw configError("GitHub App private key PEM body is not valid base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

function normalizeApiBaseUrl(value: unknown): string {
	if (value === undefined) {
		return DEFAULT_API_BASE_URL;
	}
	if (typeof value !== "string" || value.length === 0) {
		throw configError("GitHub App apiBaseUrl must be a non-empty string");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw configError("GitHub App apiBaseUrl must be an absolute URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw configError("GitHub App apiBaseUrl must use http or https");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw configError("GitHub App apiBaseUrl must not embed credentials");
	}
	if (parsed.search !== "" || parsed.hash !== "") {
		throw configError(
			"GitHub App apiBaseUrl must not carry a query or fragment",
		);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function normalizeAppConfig(
	options: GitHubAppCredentials,
): NormalizedAppConfig {
	if (options === null || typeof options !== "object") {
		throw configError("GitHub App credential options are required");
	}
	const appId = parseNumericIdentifier(options.appId, "appId");
	const privateKeyDer = pemToDer(options.privateKeyPem);
	const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw configError("GitHub App fetchImpl must be a function");
	}
	const now = options.now ?? (() => Date.now());
	if (typeof now !== "function") {
		throw configError("GitHub App now must be a clock function");
	}
	return { appId, apiBaseUrl, privateKeyDer, fetchImpl, now };
}

function normalizeConfig(
	options: GitHubTokenProviderOptions,
): NormalizedConfig {
	const app = normalizeAppConfig(options);
	const installationId = parseNumericIdentifier(
		options.installationId,
		"installationId",
	);
	return { ...app, installationId };
}

function isRepoPermission(value: unknown): value is GitHubRepoPermission {
	return value === "read" || value === "write";
}

/**
 * Optional permission fields, in camelCase request form and snake_case wire
 * form. `contents` is handled separately because it is required.
 */
const OPTIONAL_PERMISSIONS = [
	["pullRequests", "pull_requests"],
	["actions", "actions"],
	["checks", "checks"],
	["issues", "issues"],
	["administration", "administration"],
] as const;

function validateRequest(
	request: GitHubInstallationTokenRequest,
): ValidatedRequest {
	if (
		request === null ||
		typeof request !== "object" ||
		typeof request.repositoryFullName !== "string" ||
		!REPOSITORY_FULL_NAME_PATTERN.test(request.repositoryFullName)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"repositoryFullName must be owner/name",
		);
	}
	if (!isRepoPermission(request.contents)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"contents permission must be read or write",
		);
	}
	const permissions: Record<string, GitHubRepoPermission> = {
		contents: request.contents,
	};
	for (const [field, wireName] of OPTIONAL_PERMISSIONS) {
		const value = request[field];
		if (value === undefined) continue;
		if (!isRepoPermission(value)) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				`${field} permission must be read or write`,
			);
		}
		permissions[wireName] = value;
	}
	const separator = request.repositoryFullName.indexOf("/");
	return {
		repositoryFullName: request.repositoryFullName,
		repositoryName: request.repositoryFullName.slice(separator + 1),
		permissions,
	};
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlFromText(text: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(text));
}

function statusError(status: number): PlatformError {	switch (status) {
		case 401:
			// The error union has no AUTH_REQUIRED; a rejected App JWT is a
			// broker-unavailable condition, never a caller-input failure.
			return new PlatformError(
				"INTEGRATION_UNAVAILABLE",
				"github app authentication was rejected (status 401)",
			);
		case 403:
			// The union has no FORBIDDEN; policy denial is the closest code.
			return new PlatformError(
				"POLICY_DENIED",
				"github app installation is not permitted (status 403)",
			);
		case 404:
			return new PlatformError(
				"NOT_FOUND",
				"github app installation was not found (status 404)",
			);
		case 429:
			return new PlatformError(
				"RATE_LIMITED",
				"github app authentication was rate limited (status 429)",
			);
		default:
			return status >= 500
				? new PlatformError(
						"INTEGRATION_UNAVAILABLE",
						`github app authentication is unavailable (status ${status})`,
					)
				: new PlatformError(
						"AGENT_EXECUTION_FAILED",
						`github app authentication failed (status ${status})`,
					);
	}
}

/**
 * Fixed status mapping shared by every App call (token, installation,
 * repository list). It never includes a provider body.
 */
export function githubAppStatusError(status: number): PlatformError {
	return statusError(status);
}

export const GITHUB_APP_API_BASE_URL = DEFAULT_API_BASE_URL;
export const GITHUB_APP_API_VERSION = GITHUB_API_VERSION;
export const GITHUB_APP_USER_AGENT = REQUEST_USER_AGENT;
export const GITHUB_APP_REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/**
 * Provider responses are untrusted input (§7). Only a non-empty token with a
 * parseable future expiry is accepted; the body itself never escapes.
 */
function parseTokenResponse(
	bodyText: string,
	nowMs: number,
): GitHubInstallationToken | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") {
		return null;
	}
	const candidate = parsed as { token?: unknown; expires_at?: unknown };
	if (typeof candidate.token !== "string" || candidate.token.length === 0) {
		return null;
	}
	if (typeof candidate.expires_at !== "string") {
		return null;
	}
	const expiresAtMs = Date.parse(candidate.expires_at);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return null;
	}
	return { token: candidate.token, expiresAt: candidate.expires_at };
}

/**
 * Lazily imports the App private key and signs short-lived App JWTs. Shared by
 * the repo-scoped token broker and the per-installation client so both have one
 * key-import path and one JWT shape.
 */
function createAppJwtFactory(
	config: NormalizedAppConfig,
): (nowMs: number) => Promise<string> {
	let signingKeyPromise: Promise<CryptoKey> | null = null;

	const importSigningKey = (): Promise<CryptoKey> => {
		if (signingKeyPromise === null) {
			signingKeyPromise = globalThis.crypto.subtle
				.importKey(
					"pkcs8",
					config.privateKeyDer,
					{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
					false,
					["sign"],
				)
				.catch(() => {
					throw configError("GitHub App private key could not be imported");
				});
		}
		return signingKeyPromise;
	};

	return async (nowMs: number): Promise<string> => {
		const issuedAtSeconds = Math.floor(nowMs / 1000);
		const header = base64UrlFromText(
			JSON.stringify({ alg: "RS256", typ: "JWT" }),
		);
		const payload = base64UrlFromText(
			JSON.stringify({
				iat: issuedAtSeconds - JWT_BACKDATE_SECONDS,
				exp: issuedAtSeconds + JWT_LIFETIME_SECONDS,
				iss: config.appId,
			}),
		);
		const signingInput = `${header}.${payload}`;
		const key = await importSigningKey();
		let signature: ArrayBuffer;
		try {
			signature = await globalThis.crypto.subtle.sign(
				"RSASSA-PKCS1-v1_5",
				key,
				new TextEncoder().encode(signingInput),
			);
		} catch {
			throw new PlatformError(
				"AGENT_EXECUTION_FAILED",
				"github app jwt signing failed",
			);
		}
		return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
	};
}

/**
 * Creates a GitHub App installation-token broker.
 *
 * Config is validated synchronously and fails closed (`MISSING_CONFIG`) before
 * any network call; the private key is parsed once and imported lazily. Tokens
 * are cached per repository and permission set until `expires_at − 300 s`,
 * concurrent requests for the same key share one exchange, and every failure
 * is reported through a fixed, credential-free `PlatformError` message.
 */
export function createGitHubAppTokenProvider(
	options: GitHubTokenProviderOptions,
): GitHubTokenProvider {
	const config = normalizeConfig(options);
	const cache = new Map<string, CacheEntry>();
	const inFlight = new Map<string, Promise<GitHubInstallationToken>>();
	const createAppJwt = createAppJwtFactory(config);

	const mintToken = async (
		request: ValidatedRequest,
	): Promise<GitHubInstallationToken> => {
		const jwt = await createAppJwt(config.now());
		const endpoint = `${config.apiBaseUrl}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`;
		let response: Response;
		try {
			response = await config.fetchImpl(endpoint, {
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
					"User-Agent": REQUEST_USER_AGENT,
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify({
					repository: request.repositoryName,
					permissions: request.permissions,
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			// Never surface the underlying error: it may embed request text.
			throw new PlatformError(
				"AGENT_EXECUTION_FAILED",
				"github app authentication request failed",
			);
		}

		let bodyText: string;
		try {
			bodyText = await response.text();
		} catch {
			bodyText = "";
		}
		if (!response.ok) {
			throw statusError(response.status);
		}
		const parsed = parseTokenResponse(bodyText, config.now());
		if (parsed === null) {
			throw new PlatformError(
				"INTEGRATION_UNAVAILABLE",
				"github returned an unusable installation token response",
			);
		}
		return parsed;
	};

	return {
		async getInstallationToken(request) {
			const validated = validateRequest(request);
			const permissionKey = Object.entries(validated.permissions)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, level]) => `${name}=${level}`)
				.join(",");
			const cacheKey = `${validated.repositoryFullName}|${permissionKey}`;
			const nowMs = config.now();

			const cached = cache.get(cacheKey);
			if (cached !== undefined) {
				if (nowMs < cached.expiresAtMs - CACHE_SKEW_MS) {
					return { token: cached.token, expiresAt: cached.expiresAt };
				}
				cache.delete(cacheKey);
			}

			const pending = inFlight.get(cacheKey);
			if (pending !== undefined) {
				return pending;
			}

			const minted = mintToken(validated)
				.then((token) => {
					cache.set(cacheKey, {
						token: token.token,
						expiresAt: token.expiresAt,
						expiresAtMs: Date.parse(token.expiresAt),
					});
					return token;
				})
				.finally(() => {
					inFlight.delete(cacheKey);
				});
			inFlight.set(cacheKey, minted);
			return minted;
		},
	};
}

function normalizeByIdInstallationId(value: unknown): string {
	return parseNumericIdentifier(value, "installationId");
}

function normalizePermissions(
	value: Readonly<Record<string, GitHubRepoPermission>> | undefined,
): Readonly<Record<string, GitHubRepoPermission>> | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"installation token permissions must be an object",
		);
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return undefined;
	const permissions: Record<string, GitHubRepoPermission> = {};
	for (const [name, level] of entries) {
		if (!(WIRE_PERMISSION_NAMES as readonly string[]).includes(name)) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"installation token permission name is not allowed",
			);
		}
		if (!isRepoPermission(level)) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"installation token permission must be read or write",
			);
		}
		permissions[name] = level;
	}
	return permissions;
}

function normalizeRepositoryName(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !REPOSITORY_NAME_PATTERN.test(value)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"repositoryName must be a bare GitHub repository name",
		);
	}
	return value;
}

async function readResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/**
 * App JWT client that mints a token for any supplied installation id. Unlike
 * `createGitHubAppTokenProvider`, no installation is bound at construction, so
 * one worker/web instance can serve every tenant. No token or provider body is
 * cached, logged or included in an error.
 */
export function createGitHubAppClient(
	options: GitHubAppCredentials,
): GitHubAppClient {
	const config = normalizeAppConfig(options);
	const createAppJwt = createAppJwtFactory(config);

	const getInstallationToken = async (
		input: GitHubInstallationTokenByIdRequest,
	): Promise<GitHubInstallationToken> => {
		if (input === null || typeof input !== "object") {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"installation token request is required",
			);
		}
		const installationId = normalizeByIdInstallationId(input.installationId);
		const repositoryName = normalizeRepositoryName(input.repositoryName);
		const permissions = normalizePermissions(input.permissions);
		const jwt = await createAppJwt(config.now());
		const endpoint = `${config.apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
		const body: Record<string, unknown> = {};
		if (repositoryName !== undefined) body.repository = repositoryName;
		if (permissions !== undefined) body.permissions = permissions;
		let response: Response;
		try {
			response = await config.fetchImpl(endpoint, {
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
					"User-Agent": REQUEST_USER_AGENT,
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
					Authorization: `Bearer ${jwt}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new PlatformError(
				"AGENT_EXECUTION_FAILED",
				"github app authentication request failed",
			);
		}
		const bodyText = await readResponseText(response);
		if (!response.ok) throw statusError(response.status);
		const parsed = parseTokenResponse(bodyText, config.now());
		if (parsed === null) {
			throw new PlatformError(
				"INTEGRATION_UNAVAILABLE",
				"github returned an unusable installation token response",
			);
		}
		return parsed;
	};

	const getInstallation = async (input: {
		readonly installationId: string;
	}): Promise<GitHubAppInstallationDetails> => {
		if (input === null || typeof input !== "object") {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"installation lookup request is required",
			);
		}
		const installationId = normalizeByIdInstallationId(input.installationId);
		const jwt = await createAppJwt(config.now());
		const endpoint = `${config.apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}`;
		let response: Response;
		try {
			response = await config.fetchImpl(endpoint, {
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": REQUEST_USER_AGENT,
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
					Authorization: `Bearer ${jwt}`,
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new PlatformError(
				"AGENT_EXECUTION_FAILED",
				"github app installation request failed",
			);
		}
		const bodyText = await readResponseText(response);
		if (!response.ok) throw statusError(response.status);
		return parseInstallationResponse(bodyText, installationId);
	};

	return { getInstallationToken, getInstallation };
}

/** Narrow resolver surface for callers that only mint installation tokens. */
export function createGitHubInstallationTokenResolver(
	options: GitHubAppCredentials,
): GitHubInstallationTokenResolver {
	const client = createGitHubAppClient(options);
	return {
		getInstallationToken: (input) => client.getInstallationToken(input),
	};
}

/** Untrusted App response; only the three bounded metadata fields escape. */
function parseInstallationResponse(
	bodyText: string,
	installationId: string,
): GitHubAppInstallationDetails {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		parsed = null;
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable installation response",
		);
	}
	const candidate = parsed as {
		account?: { login?: unknown; type?: unknown };
		repository_selection?: unknown;
	};
	const login = candidate.account?.login;
	const type = candidate.account?.type;
	const selection = candidate.repository_selection;
	if (
		typeof login !== "string" ||
		login.length === 0 ||
		login.length > 100 ||
		(type !== "User" && type !== "Organization") ||
		(selection !== "all" && selection !== "selected")
	) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable installation response",
		);
	}
	return {
		installationId,
		accountLogin: login,
		accountType: type,
		repositorySelection: selection,
	};
}

/**
 * Adapts a minted token into the credential shape consumed by
 * `createPrCreator` (rest-client.ts). The worker holds the token broker and
 * passes only the string into the creator; `createPrCreator` still requires a
 * payload-bound approval for every sensitive pull request, so this helper does
 * not touch the deny-default approval gate or the approval SHA binding.
 */
export function toGitHubCredentials(
	installation: GitHubInstallationToken,
): GitHubCredentials {
	if (
		typeof installation.token !== "string" ||
		installation.token.length === 0
	) {
		throw configError("github installation token is empty");
	}
	return { installationToken: installation.token, passwordless: true };
}
