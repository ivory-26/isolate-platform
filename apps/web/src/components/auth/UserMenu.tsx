import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogoutIcon } from "@/components/icons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOut } from "../../features/auth/auth.functions";
import { authStateKeys } from "../../features/auth/queries";
import { useSession } from "./SessionProvider";

function initials(name: string) {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join("");
}

/**
 * The signed-in caller and the way out. The menu renders nothing until a
 * trusted session exists, so an anonymous visitor never sees a tenant's name.
 */
export function UserMenu() {
	const state = useSession();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: authStateKeys.all });
		},
	});
	if (state.mode !== "authenticated" || !state.session.user) return null;
	const user = state.session.user;
	return (
		<div className="flex items-center gap-3">
			<Avatar className="size-8">
				<AvatarFallback className="bg-brand/15 font-mono text-[10px] text-brand">
					{initials(user.name)}
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0">
				<p className="truncate text-xs font-medium text-ink">{user.name}</p>
				<p className="truncate font-mono text-[10px] text-ink-muted">
					{user.email}
				</p>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={mutation.isPending}
				onClick={() => mutation.mutate()}
			>
				<LogoutIcon />
				{mutation.isPending ? "Signing out…" : "Sign out"}
			</Button>
		</div>
	);
}
