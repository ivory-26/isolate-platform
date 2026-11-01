import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/auth/AuthForm";
import { AuthLayout } from "../components/auth/AuthLayout";
import { GoogleSignInButton } from "../components/auth/GoogleSignInButton";
import { Button } from "../components/ui/button";
import { authStateOptions } from "../features/auth/queries";

export const Route = createFileRoute("/login")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		if (state.mode === "authenticated") throw redirect({ to: "/overview" });
		return state;
	},
	component: LoginPage,
});

function LoginPage() {
	const state = Route.useLoaderData();
	return (
		<AuthLayout
			title="Access your organization"
			description="Your organization and role are resolved on the server from your membership, never from this form."
			footer={
				<p>
					No account yet?{" "}
					<Link
						to="/signup"
						className="font-medium text-brand underline-offset-4 hover:underline"
					>
						Create one
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
						Authentication is not configured for this deployment. Ask an
						administrator to set the Neon Auth connection before signing in.
					</p>
				)}
				{state.mode === "demo" && (
					<div className="space-y-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs leading-5 text-ink-secondary">
						<p>
							This deployment runs in local demo mode, which uses a fixed
							development identity.
						</p>
						<Button asChild variant="outline" size="sm">
							<Link to="/overview">Open the control plane</Link>
						</Button>
					</div>
				)}
				<AuthForm mode="sign-in" />
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
