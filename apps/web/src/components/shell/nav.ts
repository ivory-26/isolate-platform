import type { ComponentType } from "react";
import {
	type AppIconProps,
	ApprovalsIcon,
	ConnectorsIcon,
	InboxIcon,
	OverviewIcon,
	RepositoriesIcon,
	RunsIcon,
	SettingsIcon,
	UsageIcon,
} from "@/components/icons";

export type NavPath =
	| "/overview"
	| "/inbox"
	| "/runs"
	| "/approvals"
	| "/integrations"
	| "/repositories"
	| "/usage"
	| "/settings";

export type NavItem = {
	label: string;
	to: NavPath;
	icon: ComponentType<AppIconProps>;
	badge?: "approvals" | "runs";
};

/**
 * Primary navigation. Workflows and Devices stay reachable by URL but are not
 * first-level destinations: workflows are secondary, and devices are now the
 * Relays tab under Integrations.
 */
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
	{
		label: "Operate",
		items: [
			{ label: "Home", to: "/overview", icon: OverviewIcon },
			{ label: "Inbox", to: "/inbox", icon: InboxIcon },
			{ label: "Runs", to: "/runs", icon: RunsIcon, badge: "runs" },
			{
				label: "Approvals",
				to: "/approvals",
				icon: ApprovalsIcon,
				badge: "approvals",
			},
		],
	},
	{
		label: "Connect",
		items: [
			{ label: "Integrations", to: "/integrations", icon: ConnectorsIcon },
			{ label: "Repositories", to: "/repositories", icon: RepositoriesIcon },
		],
	},
	{
		label: "Observe",
		items: [{ label: "Usage", to: "/usage", icon: UsageIcon }],
	},
	{
		label: "Manage",
		items: [{ label: "Settings", to: "/settings", icon: SettingsIcon }],
	},
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
