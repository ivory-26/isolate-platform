import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { Section } from "@/components/common/section";
import { ChevronLeftIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
		<PageContainer>
			<PageHeader
				eyebrow="Manage"
				title="Create an organization"
				description="You become the owner. Owners can manage members through the API and configure repositories and workflows."
			/>
			<Section
				title="Organization details"
				description="The address is unique and cannot be changed later."
				className="max-w-2xl"
			>
				<form onSubmit={handleSubmit} className="space-y-5">
					<div className="space-y-1.5">
						<Label htmlFor="name">Organization name</Label>
						<Input
							id="name"
							name="name"
							required
							maxLength={120}
							autoComplete="organization"
							placeholder="Acme Labs"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="slug">Organization address</Label>
						<Input
							id="slug"
							name="slug"
							required
							maxLength={64}
							pattern="[a-z0-9]+(-[a-z0-9]+)*"
							placeholder="acme-labs"
							autoComplete="off"
							spellCheck={false}
							aria-describedby="organization-slug-hint"
						/>
						<p
							id="organization-slug-hint"
							className="text-xs leading-5 text-ink-muted"
						>
							Lowercase words separated by single hyphens.
						</p>
					</div>
					{error ? (
						<p
							role="alert"
							className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
						>
							{error}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button type="submit" disabled={mutation.isPending}>
							<PlusIcon />
							{mutation.isPending ? "Creating…" : "Create organization"}
						</Button>
						<Button asChild variant="outline">
							<Link to="/organizations">
								<ChevronLeftIcon />
								Back to organizations
							</Link>
						</Button>
					</div>
				</form>
			</Section>
		</PageContainer>
	);
}
