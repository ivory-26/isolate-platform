import { z } from "zod";

/**
 * Client-safe repository contracts.
 *
 * The same schema validates the registration form in the browser and the
 * server function payload, so a crafted request cannot widen what the
 * database layer accepts. Providers are enumerated; the full name and branch
 * are shape-checked only (the platform never rewrites authored identifiers).
 */
export const repositoryProviders = ["github"] as const;
export const repositoryProviderSchema = z.enum(["github"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

/** Bounded list read: the server never returns more than this many rows. */
export const MAX_REPOSITORY_ROWS = 200;
export const MAX_REPOSITORY_SEARCH_LENGTH = 100;
export const MAX_EXTERNAL_FULL_NAME_LENGTH = 200;
export const MAX_DEFAULT_BRANCH_LENGTH = 255;

/** Mirrors the persistence bounds in `@isolate/db` (0006 migration). */
export const MIN_VALIDATION_TIMEOUT_MS = 1_000;
export const MAX_VALIDATION_TIMEOUT_MS = 900_000;
export const DEFAULT_VALIDATION_TIMEOUT_MS = 300_000;
export const MAX_VALIDATION_COMMAND_LENGTH = 512;

const VALIDATION_COMMAND_FORBIDDEN = /[;|&><$`]/;

function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function isOwnerRepo(value: string): boolean {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [owner, repo] = parts;
	if (owner.length === 0 || repo.length === 0) return false;
	return !["", ".", ".."].includes(owner) && !["", ".", ".."].includes(repo);
}

export const repositoryFullNameSchema = z
	.string()
	.trim()
	.min(3, "Use the owner/repo form.")
	.max(MAX_EXTERNAL_FULL_NAME_LENGTH, "Use at most 200 characters.")
	.regex(
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
		"Use the owner/repo form without spaces.",
	)
	.refine(isOwnerRepo, "Use the owner/repo form without spaces.");

export const repositoryDefaultBranchSchema = z
	.string()
	.trim()
	.min(1, "Enter the default branch.")
	.max(MAX_DEFAULT_BRANCH_LENGTH, "Use at most 255 characters.")
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
		"Use a branch name without spaces or leading punctuation.",
	)
	.refine(
		(value) => !value.includes("//") && !value.endsWith("/"),
		"Use a branch name without repeated or trailing slashes.",
	);

export const repositoryValidationCommandSchema = z
	.string()
	.trim()
	.max(MAX_VALIDATION_COMMAND_LENGTH, "Use at most 512 characters.")
	.refine(
		(value) =>
			!VALIDATION_COMMAND_FORBIDDEN.test(value) && !hasControlCharacter(value),
		"Shell metacharacters are not allowed in the validation command.",
	);

export const repositoryValidationTimeoutSchema = z
	.number()
	.int()
	.min(MIN_VALIDATION_TIMEOUT_MS, "Use at least 1,000 ms.")
	.max(MAX_VALIDATION_TIMEOUT_MS, "Use at most 900,000 ms.");

export const registerRepositorySchema = z.strictObject({
	provider: repositoryProviderSchema,
	externalFullName: repositoryFullNameSchema,
	defaultBranch: repositoryDefaultBranchSchema,
	/** Optional; an empty value means "no validation gate". */
	validationCommand: repositoryValidationCommandSchema.optional(),
	validationTimeoutMs: repositoryValidationTimeoutSchema.default(
		DEFAULT_VALIDATION_TIMEOUT_MS,
	),
});
export type RegisterRepositoryInput = z.input<typeof registerRepositorySchema>;
export type ValidatedRepositoryRegistration = z.output<
	typeof registerRepositorySchema
>;

export const listRepositoriesSchema = z.strictObject({
	q: z.string().trim().max(MAX_REPOSITORY_SEARCH_LENGTH).default(""),
	provider: repositoryProviderSchema.optional(),
});
export type RepositoriesQuery = z.output<typeof listRepositoriesSchema>;

export type RepositoriesSearch = {
	q: string;
	provider?: RepositoryProvider;
};

/** Pure URL-search parser: an unknown provider means "all providers". */
export function parseRepositoriesSearch(
	search: Record<string, unknown>,
): RepositoriesSearch {
	const query =
		typeof search.q === "string"
			? search.q.trim().slice(0, MAX_REPOSITORY_SEARCH_LENGTH)
			: "";
	const provider =
		search.provider === "github" ? ("github" as const) : undefined;
	return { q: query, provider };
}

export type RepositorySummary = {
	id: string;
	provider: RepositoryProvider;
	externalFullName: string;
	defaultBranch: string;
	validationCommand: string | null;
	validationTimeoutMs: number;
	createdAt: string;
};

export type RepositoriesReadModel = {
	repositories: RepositorySummary[];
	/** True when more rows exist than the fixed server cap returned. */
	truncated: boolean;
	/** Server-derived from the membership role; controls the write action. */
	canManage: boolean;
};
