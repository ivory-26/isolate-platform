import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/auth/AuthForm";
import { authStateOptions } from "../features/auth/queries";

export const Route = createFileRoute("/login")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		if (state.mode === "authenticated") throw redirect({ to: "/" });
		return state;
	},
	component: LoginPage,
});

function LoginPage() {
	const state = Route.useLoaderData();
	return (
		<main>
			<p className="eyebrow">Sign in</p>
			<h1>Access your organization</h1>
			{state.mode === "unavailable" && (
				<p role="alert">
					Authentication is not configured for this deployment. Ask an
					administrator to set the Neon Auth connection before signing in.
				</p>
			)}
			{state.mode === "demo" && (
				<p>
					This deployment runs in local demo mode, which uses a fixed
					development identity. <Link to="/">Open the control plane</Link>.
				</p>
			)}
			<AuthForm mode="sign-in" />
			<p>
				No account yet? <Link to="/signup">Create one</Link>.
			</p>
		</main>
	);
}
