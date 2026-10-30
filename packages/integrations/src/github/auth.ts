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

export type GitHubInstallationTokenRequest = {
	/** `owner/name`; the token is scoped to this repository only. */
	readonly repositoryFullName: string;
	readonly contents: GitHubRepoPermission;
	readonly pullRequests?: GitHubRepoPermission;
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
const PKCS8_PEM_PATTERN =
	/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type NormalizedConfig = {
	readonly appId: string;
	readonly installationId: string;
	readonly apiBaseUrl: string;
	readonly privateKeyDer: ArrayBuffer;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;
};

type ValidatedRequest = {
	readonly repositoryFullName: string;
	readonly repositoryName: string;
	readonly contents: GitHubRepoPermission;
	readonly pullRequests?: GitHubRepoPermission;
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

function pemToDer(pem: unknown): ArrayBuffer {
	if (typeof pem !== "string") {
		throw configError("GitHub App private key must be a PKCS#8 PEM string");
	}
	const match = PKCS8_PEM_PATTERN.exec(pem);
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

function normalizeConfig(
	options: GitHubTokenProviderOptions,
): NormalizedConfig {
	if (options === null || typeof options !== "object") {
		throw configError("GitHub App token provider options are required");
	}
	const appId = parseNumericIdentifier(options.appId, "appId");
	const installationId = parseNumericIdentifier(
		options.installationId,
		"installationId",
	);
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
	return {
		appId,
		installationId,
		apiBaseUrl,
		privateKeyDer,
		fetchImpl,
		now,
	};
}

function isRepoPermission(value: unknown): value is GitHubRepoPermission {
	return value === "read" || value === "write";
}

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
	if (
		request.pullRequests !== undefined &&
		!isRepoPermission(request.pullRequests)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pullRequests permission must be read or write",
		);
	}
	const separator = request.repositoryFullName.indexOf("/");
	return {
		repositoryFullName: request.repositoryFullName,
		repositoryName: request.repositoryFullName.slice(separator + 1),
		contents: request.contents,
		...(request.pullRequests === undefined
			? {}
			: { pullRequests: request.pullRequests }),
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

function statusError(status: number): PlatformError {
	switch (status) {
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

	const createAppJwt = async (nowMs: number): Promise<string> => {
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
					permissions:
						request.pullRequests === undefined
							? { contents: request.contents }
							: {
									contents: request.contents,
									pull_requests: request.pullRequests,
								},
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
			const cacheKey = `${validated.repositoryFullName}|${validated.contents}|${validated.pullRequests ?? ""}`;
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
