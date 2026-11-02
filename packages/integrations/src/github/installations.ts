import { PlatformError } from "@isolate/shared";
import {
	GITHUB_APP_API_BASE_URL,
	GITHUB_APP_API_VERSION,
	GITHUB_APP_REQUEST_TIMEOUT_MS,
	GITHUB_APP_USER_AGENT,
	type GitHubAppClient,
	githubAppStatusError,
} from "./auth";

/**
 * GitHub App installation reads (wave 23): list the repositories an
 * installation can see. The caller supplies a tenant-resolved installation id;
 * this module never decides tenancy.
 *
 * Bounds: at most 100 repositories are returned, a full name is at most 200
 * characters in `owner/name` form and a default branch at most 255. The token
 * is taken only into the Authorization header and never logged, cached in a
 * module singleton or included in an error.
 */

export const MAX_INSTALLATION_REPOSITORIES = 100;
export const MAX_INSTALLATION_REPOSITORY_NAME_CHARS = 200;
export const MAX_INSTALLATION_BRANCH_CHARS = 255;
const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type InstallationRepositorySummary = {
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
	readonly installationId: string;
};

export type InstallationRepositoriesResult = {
	readonly repositories: InstallationRepositorySummary[];
	/** True when the installation holds more repositories than were returned. */
	readonly truncated: boolean;
};

export type InstallationRepositoriesDependencies = {
	readonly client: Pick<GitHubAppClient, "getInstallationToken">;
	readonly fetchImpl?: typeof fetch;
	readonly apiBaseUrl?: string;
	readonly timeoutMs?: number;
};

export type ListInstallationRepositoriesInput = {
	readonly installationId: string;
};

function validateInstallationId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!INSTALLATION_ID_PATTERN.test(value) ||
		value.length > 20
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"installationId must be a positive numeric string",
		);
	}
	return value;
}

function normalizeApiBaseUrl(value: string | undefined): string {
	const candidate = value ?? GITHUB_APP_API_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new PlatformError(
			"MISSING_CONFIG",
			"GitHub API base URL must be absolute",
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"GitHub API base URL must use http or https",
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"GitHub API base URL must not embed credentials",
		);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function validateRepositoryEntry(
	entry: unknown,
	installationId: string,
): InstallationRepositorySummary | null {
	if (entry === null || typeof entry !== "object") return null;
	const candidate = entry as {
		full_name?: unknown;
		default_branch?: unknown;
		private?: unknown;
	};
	const fullName = candidate.full_name;
	const branch = candidate.default_branch;
	if (
		typeof fullName !== "string" ||
		fullName.length > MAX_INSTALLATION_REPOSITORY_NAME_CHARS ||
		!REPOSITORY_FULL_NAME_PATTERN.test(fullName)
	) {
		return null;
	}
	if (
		typeof branch !== "string" ||
		branch.trim().length === 0 ||
		branch.length > MAX_INSTALLATION_BRANCH_CHARS
	) {
		return null;
	}
	if (typeof candidate.private !== "boolean") return null;
	return {
		fullName,
		defaultBranch: branch,
		private: candidate.private,
		installationId,
	};
}

/**
 * GET /installation/repositories for one installation. The installation token
 * is minted through the injected App client, so tests can fake the exchange;
 * `fetchImpl` is injected separately so the list call itself is also fakeable.
 */
export async function listInstallationRepositories(
	dependencies: InstallationRepositoriesDependencies,
	input: ListInstallationRepositoriesInput,
): Promise<InstallationRepositoriesResult> {
	const installationId = validateInstallationId(input.installationId);
	const token = await dependencies.client.getInstallationToken({
		installationId,
	});
	const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"GitHub installation fetch must be a function",
		);
	}
	const baseUrl = normalizeApiBaseUrl(dependencies.apiBaseUrl);
	const timeoutMs = dependencies.timeoutMs ?? GITHUB_APP_REQUEST_TIMEOUT_MS;
	const endpoint = `${baseUrl}/installation/repositories?per_page=${MAX_INSTALLATION_REPOSITORIES}&page=1`;
	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: "GET",
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": GITHUB_APP_USER_AGENT,
				"X-GitHub-Api-Version": GITHUB_APP_API_VERSION,
				Authorization: `Bearer ${token.token}`,
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		throw new PlatformError(
			"AGENT_EXECUTION_FAILED",
			"github installation repository request failed",
		);
	}
	let bodyText: string;
	try {
		bodyText = await response.text();
	} catch {
		bodyText = "";
	}
	if (!response.ok) throw githubAppStatusError(response.status);
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable repository response",
		);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable repository response",
		);
	}
	const candidate = parsed as { total_count?: unknown; repositories?: unknown };
	if (!Array.isArray(candidate.repositories)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable repository response",
		);
	}
	const raw = candidate.repositories.slice(0, MAX_INSTALLATION_REPOSITORIES);
	const repositories: InstallationRepositorySummary[] = [];
	for (const entry of raw) {
		const repository = validateRepositoryEntry(entry, installationId);
		if (repository !== null) repositories.push(repository);
	}
	const totalCount =
		typeof candidate.total_count === "number" &&
		Number.isFinite(candidate.total_count)
			? candidate.total_count
			: raw.length;
	return {
		repositories,
		truncated:
			totalCount > repositories.length ||
			candidate.repositories.length > MAX_INSTALLATION_REPOSITORIES ||
			repositories.length < raw.length,
	};
}
