import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { createOrganization } from "../../features/auth/auth.functions";
import { createOrganizationSchema } from "../../features/auth/contracts";
import { authStateKeys } from "../../features/auth/queries";

export const Route = createFileRoute("/organizations/new")({
	component: NewOrganizationPage,
});

function NewOrganizationPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (form: FormData) => {
			const parsed = createOrganizationSchema.safeParse({
				name: String(form.get("name") ?? ""),
				slug: String(form.get("slug") ?? ""),
			});
			if (!parsed.success) return Promise.reject(new Error("invalid-input"));
			return createOrganization({ data: parsed.data });
		},
		onSuccess: async (result) => {
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setError(null);
			await queryClient.invalidateQueries({ queryKey: authStateKeys.all });
			await navigate({ to: "/organizations" });
		},
		onError: () => {
			setError("Use a name and a lowercase address such as acme-labs.");
		},
	});
	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mutation.isPending) return;
		setError(null);
		mutation.mutate(new FormData(event.currentTarget));
	}
	return (
		<main>
			<p className="eyebrow">Tenants</p>
			<h1>Create an organization</h1>
			<p>
				You become the owner. Owners can add members and manage the
				organization&rsquo;s repositories and workflows.
			</p>
			<form onSubmit={handleSubmit}>
				<label htmlFor="name">Organization name</label>
				<input id="name" name="name" required maxLength={120} />
				<label htmlFor="slug">Organization address</label>
				<input
					id="slug"
					name="slug"
					required
					maxLength={64}
					pattern="[a-z0-9]+(-[a-z0-9]+)*"
					placeholder="acme-labs"
				/>
				<button type="submit" disabled={mutation.isPending}>
					{mutation.isPending ? "Creating..." : "Create organization"}
				</button>
				{error && (
					<p role="alert" className="form-error">
						{error}
					</p>
				)}
			</form>
			<p>
				<Link to="/organizations">Back to organizations</Link>
			</p>
		</main>
	);
}
