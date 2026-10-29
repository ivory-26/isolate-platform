import type { AuthRole } from "../../features/auth/contracts";

const ROLE_LABELS: Record<AuthRole, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	viewer: "Viewer",
};

/** The caller's role in one organization. */
export function RoleBadge({ role }: { role: AuthRole }) {
	return (
		<span className="role-badge" data-role={role}>
			{ROLE_LABELS[role]}
		</span>
	);
}
