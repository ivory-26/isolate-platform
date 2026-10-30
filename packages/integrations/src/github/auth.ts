import { PlatformError } from "@isolate/shared";

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

/**
 * Contract placeholder. The wave-7 GitHub lane replaces this body with the
 * RS256 JWT + installation-token exchange; the stub fails closed so a caller
 * can never mistake an unimplemented provider for a working one.
 */
export function createGitHubAppTokenProvider(
	_options: GitHubTokenProviderOptions,
): GitHubTokenProvider {
	return {
		async getInstallationToken() {
			throw new PlatformError(
				"MISSING_CONFIG",
				"GitHub App token provider is not configured",
			);
		},
	};
}
