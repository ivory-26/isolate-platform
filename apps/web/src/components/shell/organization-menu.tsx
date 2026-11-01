import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useSession } from "@/components/auth/SessionProvider";
import {
	CheckIcon,
	ChevronDownIcon,
	GlobeIcon,
	SettingsIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { selectOrganization } from "@/features/auth/auth.functions";
import { cn } from "@/lib/utils";

export function OrganizationMenu({
	collapsed = false,
}: {
	collapsed?: boolean;
}) {
	const state = useSession();
	const queryClient = useQueryClient();
	const router = useRouter();
	const mutation = useMutation({
		mutationFn: (organizationId: string) =>
			selectOrganization({ data: { organizationId } }),
		onSuccess: async (result) => {
			if (!result.ok) return;
			await queryClient.invalidateQueries();
			await router.invalidate();
		},
	});

	if (state.mode === "demo") {
		return (
			<div
				className={cn(
					"flex items-center gap-2 rounded-md border border-line-subtle bg-elevated px-2 py-1.5",
					collapsed && "justify-center px-0",
				)}
				title="Local demo workspace"
			>
				<GlobeIcon size={16} className="text-ink-muted" />
				{!collapsed ? (
					<span className="min-w-0">
						<span className="block truncate text-xs font-medium text-ink">
							Demo workspace
						</span>
						<span className="block font-mono text-[10px] text-ink-muted">
							temporary data
						</span>
					</span>
				) : null}
			</div>
		);
	}

	if (state.mode !== "authenticated") return null;
	const organizations = state.session.organizations;
	const activeId = state.session.activeOrganizationId;
	const active = organizations.find((entry) => entry.id === activeId);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-line-subtle hover:bg-hover focus-visible:border-line focus-visible:outline-none",
						collapsed && "justify-center px-0",
					)}
					aria-label="Switch organization"
				>
					<GlobeIcon size={16} className="text-ink-muted" />
					{!collapsed ? (
						<>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-medium text-ink">
									{active?.name ?? "No organization"}
								</span>
								<span className="block font-mono text-[10px] text-ink-muted">
									{active?.role ?? "no active workspace"}
								</span>
							</span>
							<ChevronDownIcon className="text-ink-muted" />
						</>
					) : null}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="font-mono text-[10px] text-ink-muted">
					Organizations
				</DropdownMenuLabel>
				{organizations.length === 0 ? (
					<DropdownMenuItem disabled>No memberships</DropdownMenuItem>
				) : (
					organizations.map((organization) => (
						<DropdownMenuItem
							key={organization.id}
							disabled={mutation.isPending}
							onSelect={() => {
								if (organization.id !== activeId) {
									mutation.mutate(organization.id);
								}
							}}
							className="flex items-center gap-2"
						>
							{organization.id === activeId ? (
								<CheckIcon className="text-brand" />
							) : (
								<span className="size-4" />
							)}
							<span className="min-w-0 flex-1 truncate">
								{organization.name}
							</span>
							<Badge variant="outline" className="text-[10px]">
								{organization.role}
							</Badge>
						</DropdownMenuItem>
					))
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<a href="/organizations" className="flex items-center gap-2">
						<SettingsIcon size={16} />
						Manage organizations
					</a>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
