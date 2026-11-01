import { GlobeIcon, UserIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { AuthState } from "@/features/auth/contracts";
import { activeRole } from "@/features/auth/guard";
import { statusLabel } from "@/lib/format";

/**
 * Workspace context for the page header. Uses the trusted session view only;
 * the demo workspace is labeled honestly because no worker executes its data.
 */
export function OrganizationContextLine({ session }: { session: AuthState }) {
	if (session.mode === "demo") {
		return (
			<div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
				<GlobeIcon size={14} />
				<span className="font-medium text-ink-secondary">Demo workspace</span>
				<span className="font-mono text-[11px]">temporary data</span>
			</div>
		);
	}
	if (session.mode !== "authenticated") return null;
	const activeId = session.session.activeOrganizationId;
	const organization = session.session.organizations.find(
		(entry) => entry.id === activeId,
	);
	if (!organization) return null;
	const role = activeRole(session);
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
			<GlobeIcon size={14} />
			<span className="font-medium text-ink-secondary">
				{organization.name}
			</span>
			<span className="font-mono text-[11px]">{organization.slug}</span>
			{role ? (
				<Badge variant="outline" className="gap-1.5">
					<UserIcon size={11} />
					{statusLabel(role)}
				</Badge>
			) : null}
		</div>
	);
}
