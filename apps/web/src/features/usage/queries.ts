import { queryOptions } from "@tanstack/react-query";
import type { UsagePeriod } from "./contracts";
import { getUsage } from "./usage.functions";

export const usageKeys = { all: ["usage"] as const };

export const usageOptions = (period: UsagePeriod) =>
	queryOptions({
		queryKey: [...usageKeys.all, period],
		queryFn: () => getUsage({ data: { period } }),
		staleTime: 20_000,
		retry: false,
	});
