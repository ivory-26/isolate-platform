import { useMutation, useQueryClient } from "@tanstack/react-query";
import { signOut } from "../../features/auth/auth.functions";
import { authStateKeys } from "../../features/auth/queries";
import { useSession } from "./SessionProvider";

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
		<div className="user-menu">
			<span className="user-menu__name">{user.name}</span>
			<span className="user-menu__email">{user.email}</span>
			<button
				type="button"
				disabled={mutation.isPending}
				onClick={() => mutation.mutate()}
			>
				{mutation.isPending ? "Signing out..." : "Sign out"}
			</button>
		</div>
	);
}
