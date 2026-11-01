import { queryOptions } from "@tanstack/react-query";
import type { RepositoriesQuery } from "./contracts";
import { listRepositories } from "./repositories.functions";

export const repositoryKeys = { all: ["repositories"] as const };

export const repositoriesOptions = (input: RepositoriesQuery) =>
	queryOptions({
		queryKey: [...repositoryKeys.all, input.q, input.provider ?? "all"],
		queryFn: () =>
			listRepositories({
				data: {
					q: input.q,
					...(input.provider === undefined ? {} : { provider: input.provider }),
				},
			}),
		staleTime: 15_000,
		retry: false,
	});
