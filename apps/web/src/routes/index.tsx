import { createFileRoute, redirect } from "@tanstack/react-router";
import { authStateOptions } from "@/features/auth/queries";
import { LandingPage } from "@/features/landing/landing-page";

export const Route = createFileRoute("/")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		if (state.mode === "authenticated" || state.mode === "demo") {
			throw redirect({ to: "/overview" });
		}
		return state;
	},
	component: LandingPage,
	head: () => ({
		meta: [
			{ title: "Isolate — autonomy with an approval boundary" },
			{
				name: "description",
				content:
					"An autonomous DevSecOps control plane: isolated sandboxes, validated changes, and human approval at the exact push or pull request.",
			},
		],
	}),
});
