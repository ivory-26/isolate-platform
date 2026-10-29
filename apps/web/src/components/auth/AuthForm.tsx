import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { signIn, signUp } from "../../features/auth/auth.functions";
import { signInSchema, signUpSchema } from "../../features/auth/contracts";
import { authStateKeys } from "../../features/auth/queries";

/**
 * The shared credential form for sign-in and sign-up.
 *
 * The browser only checks shape; the server decides whether the credential is
 * valid and which tenant the caller may act in.
 */
export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (form: FormData) => {
			const email = String(form.get("email") ?? "");
			const password = String(form.get("password") ?? "");
			if (mode === "sign-up") {
				const parsed = signUpSchema.safeParse({
					name: String(form.get("name") ?? ""),
					email,
					password,
				});
				if (!parsed.success) {
					return Promise.reject(new Error("invalid-input"));
				}
				return signUp({ data: parsed.data });
			}
			const parsed = signInSchema.safeParse({ email, password });
			if (!parsed.success) {
				return Promise.reject(new Error("invalid-input"));
			}
			return signIn({ data: parsed.data });
		},
		onSuccess: async (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setError(null);
			await queryClient.invalidateQueries({ queryKey: authStateKeys.all });
			await navigate({ to: "/" });
		},
		onError: () => {
			setError("Check the submitted fields and try again.");
		},
	});
	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mutation.isPending) return;
		setError(null);
		mutation.mutate(new FormData(event.currentTarget));
	}
	return (
		<form onSubmit={handleSubmit}>
			{mode === "sign-up" && (
				<>
					<label htmlFor="name">Name</label>
					<input
						id="name"
						name="name"
						required
						maxLength={120}
						autoComplete="name"
					/>
				</>
			)}
			<label htmlFor="email">Email address</label>
			<input
				id="email"
				name="email"
				type="email"
				required
				maxLength={320}
				autoComplete="email"
			/>
			<label htmlFor="password">Password</label>
			<input
				id="password"
				name="password"
				type="password"
				required
				minLength={8}
				maxLength={200}
				autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
			/>
			<button type="submit" disabled={mutation.isPending}>
				{mutation.isPending
					? "Working..."
					: mode === "sign-up"
						? "Create account"
						: "Sign in"}
			</button>
			{error && (
				<p role="alert" className="form-error">
					{error}
				</p>
			)}
		</form>
	);
}
