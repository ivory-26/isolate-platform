import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useSession } from "@/components/auth/SessionProvider";
import { LogoutIcon, SettingsIcon, UserCircleIcon } from "@/components/icons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/features/auth/auth.functions";

function initials(name: string) {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join("");
}

export function UserMenu() {
	const state = useSession();
	const queryClient = useQueryClient();
	const router = useRouter();
	const navigate = useNavigate();
	const mutation = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			await router.invalidate();
			void navigate({ to: "/login" });
		},
	});

	if (state.mode === "demo") {
		return (
			<div className="flex items-center gap-2">
				<Avatar className="size-7">
					<AvatarFallback className="bg-elevated font-mono text-[10px] text-ink-secondary">
						DM
					</AvatarFallback>
				</Avatar>
				<span className="hidden text-xs text-ink-muted sm:block">
					Local demo
				</span>
			</div>
		);
	}

	if (state.mode !== "authenticated" || !state.session.user) return null;
	const user = state.session.user;
	const activeId = state.session.activeOrganizationId;
	const role = state.session.organizations.find(
		(organization) => organization.id === activeId,
	)?.role;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-2 rounded-md border border-transparent px-1.5 py-1 transition-colors hover:border-line-subtle hover:bg-hover focus-visible:border-line focus-visible:outline-none"
					aria-label="Account menu"
				>
					<Avatar className="size-7">
						<AvatarFallback className="bg-brand/15 font-mono text-[10px] text-brand">
							{initials(user.name)}
						</AvatarFallback>
					</Avatar>
					<span className="hidden min-w-0 text-left sm:block">
						<span className="block max-w-32 truncate text-xs font-medium text-ink">
							{user.name}
						</span>
						{role ? (
							<span className="block font-mono text-[10px] text-ink-muted">
								{role}
							</span>
						) : null}
					</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				<DropdownMenuLabel className="space-y-1">
					<span className="block truncate text-sm font-medium text-ink">
						{user.name}
					</span>
					<span className="block truncate text-xs font-normal text-ink-muted">
						{user.email}
					</span>
				</DropdownMenuLabel>
				{role ? (
					<div className="px-2 pb-2">
						<Badge variant="outline" className="text-[10px]">
							{role} in active organization
						</Badge>
					</div>
				) : null}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<a href="/organizations" className="flex items-center gap-2">
						<UserCircleIcon size={16} />
						Organizations
					</a>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<a href="/settings" className="flex items-center gap-2">
						<SettingsIcon size={16} />
						Settings
					</a>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					disabled={mutation.isPending}
					onSelect={() => mutation.mutate()}
					className="flex items-center gap-2 text-danger focus:text-danger"
				>
					<LogoutIcon size={16} />
					{mutation.isPending ? "Signing out…" : "Sign out"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
