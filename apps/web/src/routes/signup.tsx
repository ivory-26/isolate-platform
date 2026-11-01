import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/auth/AuthForm";
import { AuthLayout } from "../components/auth/AuthLayout";
import { GoogleSignInButton } from "../components/auth/GoogleSignInButton";
import { authStateOptions } from "../features/auth/queries";

export const Route = createFileRoute("/signup")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		if (state.mode === "authenticated") throw redirect({ to: "/overview" });
		return state;
	},
	component: SignupPage,
});

function SignupPage() {
	const state = Route.useLoaderData();
	return (
		<AuthLayout
			title="Join the platform"
			description="Create a credential, then an organization. You become its owner; organization and role are resolved on the server."
			footer={
				<p>
					Already registered?{" "}
					<Link
						to="/login"
						className="font-medium text-brand underline-offset-4 hover:underline"
					>
						Sign in
					</Link>
				</p>
			}
		>
			<div className="space-y-4">
				{state.mode === "unavailable" && (
					<p
						role="alert"
						className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning"
					>
						Authentication is not configured for this deployment, so accounts
						cannot be created.
					</p>
				)}
				<AuthForm mode="sign-up" />
				{state.mode === "anonymous" && (
					<>
						<div className="flex items-center gap-3" aria-hidden="true">
							<span className="h-px flex-1 bg-line-subtle" />
							<span className="font-mono text-[10px] tracking-[0.12em] text-ink-muted">
								OR
							</span>
							<span className="h-px flex-1 bg-line-subtle" />
						</div>
						<GoogleSignInButton />
					</>
				)}
			</div>
		</AuthLayout>
	);
}
