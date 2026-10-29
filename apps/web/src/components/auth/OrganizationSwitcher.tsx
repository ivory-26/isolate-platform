import { useMutation, useQueryClient } from "@tanstack/react-query";
import { selectOrganization } from "../../features/auth/auth.functions";
import { authStateKeys } from "../../features/auth/queries";
import { taskKeys } from "../../features/tasks/queries";
import { RoleBadge } from "./RoleBadge";
import { useSession } from "./SessionProvider";

/**
 * Switches between the organizations the caller is a member of.
 *
 * The list comes from the membership table on the server. Selecting an
 * organization the caller does not hold a membership for is refused by the
 * server, so the switcher can never widen access.
 */
export function OrganizationSwitcher() {
	const state = useSession();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (organizationId: string) =>
			selectOrganization({ data: { organizationId } }),
		onSuccess: async (result) => {
			if (!result.ok) return;
			await queryClient.invalidateQueries({ queryKey: authStateKeys.all });
			await queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
	if (state.mode !== "authenticated") return null;
	const organizations = state.session.organizations;
	if (organizations.length === 0) return null;
	const activeId = state.session.activeOrganizationId;
	const active = organizations.find((entry) => entry.id === activeId);
	return (
		<div className="organization-switcher">
			<label htmlFor="active-organization">Organization</label>
			<select
				id="active-organization"
				value={activeId ?? ""}
				disabled={mutation.isPending}
				onChange={(event) => mutation.mutate(event.target.value)}
			>
				{organizations.map((organization) => (
					<option key={organization.id} value={organization.id}>
						{organization.name}
					</option>
				))}
			</select>
			{active && <RoleBadge role={active.role} />}
		</div>
	);
}
