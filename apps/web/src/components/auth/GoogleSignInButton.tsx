import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
		<div className="social-sign-in">
			<button
				type="button"
				disabled={mutation.isPending}
				onClick={() => {
					setError(null);
					mutation.mutate();
				}}
			>
				{mutation.isPending ? "Redirecting..." : "Continue with Google"}
			</button>
			{error && (
				<p role="alert" className="form-error">
					{error}
				</p>
			)}
		</div>
	);
}
