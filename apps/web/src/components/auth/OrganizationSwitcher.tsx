import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, GlobeIcon } from "@/components/icons";
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
		<div className="flex items-center gap-2">
			<GlobeIcon size={16} className="text-ink-muted" />
			<label htmlFor="active-organization" className="sr-only">
				Organization
			</label>
			<div className="relative">
				<select
					id="active-organization"
					value={activeId ?? ""}
					disabled={mutation.isPending}
					onChange={(event) => mutation.mutate(event.target.value)}
					className="h-8 appearance-none rounded-md border border-line bg-elevated pr-7 pl-2.5 text-xs text-ink outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
				>
					{organizations.map((organization) => (
						<option key={organization.id} value={organization.id}>
							{organization.name}
						</option>
					))}
				</select>
				<ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-muted" />
			</div>
			{active && <RoleBadge role={active.role} />}
		</div>
	);
}
