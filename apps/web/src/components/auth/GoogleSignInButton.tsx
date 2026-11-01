import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { GlobeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { startGoogleSignIn } from "../../features/auth/auth.functions";

/**
 * Starts the Neon-hosted Google flow.
 *
 * The server returns a validated https provider URL; the browser navigates to
 * it. No auth SDK or provider credential enters this bundle.
 */
export function GoogleSignInButton() {
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: () => startGoogleSignIn({ data: { provider: "google" } }),
		onSuccess: (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			window.location.assign(result.url);
		},
		onError: () => setError("Google sign-in could not be started. Try again."),
	});
	return (
		<div className="space-y-2">
			<Button
				type="button"
				variant="outline"
				className="w-full"
				disabled={mutation.isPending}
				onClick={() => {
					setError(null);
					mutation.mutate();
				}}
			>
				<GlobeIcon />
				{mutation.isPending ? "Redirecting…" : "Continue with Google"}
			</Button>
			{error && (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			)}
		</div>
	);
}
