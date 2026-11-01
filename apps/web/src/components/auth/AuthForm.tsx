import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
		<form onSubmit={handleSubmit} className="space-y-4">
			{mode === "sign-up" && (
				<div className="space-y-1.5">
					<Label htmlFor="name">Name</Label>
					<Input
						id="name"
						name="name"
						required
						maxLength={120}
						autoComplete="name"
					/>
				</div>
			)}
			<div className="space-y-1.5">
				<Label htmlFor="email">Email address</Label>
				<Input
					id="email"
					name="email"
					type="email"
					required
					maxLength={320}
					autoComplete="email"
					spellCheck={false}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					required
					minLength={8}
					maxLength={200}
					autoComplete={
						mode === "sign-up" ? "new-password" : "current-password"
					}
				/>
				{mode === "sign-up" ? (
					<p className="text-xs leading-5 text-ink-muted">
						At least 8 characters. Never reuse a vendor credential here.
					</p>
				) : null}
			</div>
			<Button type="submit" className="w-full" disabled={mutation.isPending}>
				{mutation.isPending
					? "Working…"
					: mode === "sign-up"
						? "Create account"
						: "Sign in"}
			</Button>
			{error && (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			)}
		</form>
	);
}
