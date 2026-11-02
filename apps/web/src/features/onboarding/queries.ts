import { queryOptions } from "@tanstack/react-query";
import { getSetupState } from "./onboarding.functions";

export const onboardingKeys = {
	setup: ["onboarding", "setup"] as const,
};

export const setupStateOptions = () =>
	queryOptions({
		queryKey: onboardingKeys.setup,
		queryFn: () => getSetupState(),
		staleTime: 10_000,
		retry: false,
	});
