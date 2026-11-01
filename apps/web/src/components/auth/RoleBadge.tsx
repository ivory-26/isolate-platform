import { UserCircleIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AuthRole } from "../../features/auth/contracts";

const ROLE_LABELS: Record<AuthRole, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	viewer: "Viewer",
};

const ROLE_TONES: Record<AuthRole, string> = {
	owner: "border-brand/35 bg-brand/10 text-brand",
	admin: "border-info/35 bg-info/10 text-info",
	member: "border-line bg-elevated text-ink-secondary",
	viewer: "border-line-subtle bg-elevated text-ink-muted",
};

/** The caller's role in one organization; the label always accompanies color. */
export function RoleBadge({ role }: { role: AuthRole }) {
	return (
		<Badge
			variant="outline"
			data-role={role}
			className={cn(
				"h-6 gap-1 rounded-full px-2 text-[11px] font-medium",
				ROLE_TONES[role],
			)}
		>
			<UserCircleIcon size={12} />
			{ROLE_LABELS[role]}
		</Badge>
	);
}
