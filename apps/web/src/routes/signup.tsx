import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/auth/AuthForm";
import { authStateOptions } from "../features/auth/queries";

export const Route = createFileRoute("/signup")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		if (state.mode === "authenticated") throw redirect({ to: "/" });
		return state;
	},
	component: SignupPage,
});

function SignupPage() {
	const state = Route.useLoaderData();
	return (
		<main>
			<p className="eyebrow">Create account</p>
			<h1>Join the platform</h1>
			{state.mode === "unavailable" && (
				<p role="alert">
					Authentication is not configured for this deployment, so accounts
					cannot be created.
				</p>
			)}
			<AuthForm mode="sign-up" />
			<p>
				Already registered? <Link to="/login">Sign in</Link>.
			</p>
		</main>
	);
}
