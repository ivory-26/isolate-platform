import { hasCapability, PostgresRepositoryRepository } from "@isolate/db";
import { createServerFn } from "@tanstack/react-start";
import {
	readRepositories,
	summarizeRepositoryRow,
} from "../../server/catalog-read.server";
import { runGitHubSetupAction } from "../../server/github-install.server";
import { uiRead } from "../../server/ui-runtime.server";
import {
	UiInvalidInputError,
	UiNotFoundError,
	type UiResult,
} from "../ui/contracts";
import {
	type GitHubSetupResult,
	type ImportRepositoriesInput,
	type InstallationRepositoriesReadModel,
	type RepositoriesImportResult,
	type StartGitHubInstallResult,
	importRepositoriesSchema,
	listRepositoriesSchema,
	type RegisterRepositoryInput,
	type RepositoriesQuery,
	type RepositoriesReadModel,
	type RepositorySummary,
	registerRepositorySchema,
} from "./contracts";
import {
	prepareRepositoryCreate,
	prepareRepositoryPolicy,
} from "./registration";

/**
 * Tenant-scoped repository surfaces.
 *
 * Reads use `organization:read` (every role has it) and return a server-derived
 * `canManage` flag. Creation uses `member:manage`, so a member or viewer sees
 * no write action and receives one fixed refusal even if they forge a request.
 * Driver errors never reach the caller: `uiRead` collapses them.
 */
export const listRepositories = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = listRepositoriesSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid repository list request.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<RepositoriesReadModel>> =>
			uiRead("organization:read", async (scope, sql) => {
				const result = await readRepositories(
					sql,
					scope.organizationId,
					data satisfies RepositoriesQuery,
				);
				return {
					...result,
					canManage: hasCapability(scope.role, "member:manage"),
				};
			}),
	);

export const registerRepository = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = registerRepositorySchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid repository registration.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<{ repository: RepositorySummary }>> =>
			uiRead("member:manage", async (scope, sql) => {
				const repositories = new PostgresRepositoryRepository(sql);
				const created = await repositories.create({
					organizationId: scope.organizationId,
					...prepareRepositoryCreate(data),
				});
				if (!created.ok) {
					// A duplicate full name inside the tenant is a typed CONFLICT;
					// collapse it to the fixed invalid-input result.
					throw new UiInvalidInputError();
				}
				if (created.repository.organization_id !== scope.organizationId) {
					throw new UiNotFoundError();
				}
				const policy = prepareRepositoryPolicy(data);
				if (policy === null) {
					return { repository: summarizeRepositoryRow(created.repository) };
				}
				const updated = await repositories.setValidationPolicy({
					organizationId: scope.organizationId,
					repositoryId: created.repository.id,
					...policy,
				});
				if (updated === null) throw new UiNotFoundError();
				return { repository: summarizeRepositoryRow(updated) };
			}),
	);

export type { RegisterRepositoryInput };

/**
 * GitHub App onboarding (wave 23). All three use `member:manage` (owner/admin)
 * and return the fixed `GitHubSetupResult` union, so the client never sees a
 * token, key, state or provider body.
 */
export const startGitHubInstall = createServerFn({ method: "GET" }).handler(
	async (): Promise<GitHubSetupResult<StartGitHubInstallResult>> =>
		runGitHubSetupAction((scope, service) => service.startInstall(scope)),
);

export const listInstallationRepositories = createServerFn({
	method: "GET",
}).handler(
	async (): Promise<GitHubSetupResult<InstallationRepositoriesReadModel>> =>
		runGitHubSetupAction((scope, service) => service.listRepositories(scope)),
);

export const importRepositories = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = importRepositoriesSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid repository import request.");
		return parsed.data;
	})
	.handler(
		async ({
			data,
		}): Promise<GitHubSetupResult<RepositoriesImportResult>> =>
			runGitHubSetupAction((scope, service) =>
				service.importRepositories(scope, data),
			),
	);

export type { ImportRepositoriesInput };
