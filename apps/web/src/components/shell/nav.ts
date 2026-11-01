import type { ComponentType } from "react";
import {
	type AppIconProps,
	ApprovalsIcon,
	DevicesIcon,
	OverviewIcon,
	RepositoriesIcon,
	RunsIcon,
	SettingsIcon,
	UsageIcon,
	WorkflowsIcon,
} from "@/components/icons";

export type NavPath =
	| "/"
	| "/runs"
	| "/approvals"
	| "/workflows"
	| "/repositories"
	| "/usage"
	| "/settings"
	| "/devices";

export type NavItem = {
	label: string;
	to: NavPath;
	icon: ComponentType<AppIconProps>;
	badge?: "approvals" | "runs";
};

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
	{
		label: "Operate",
		items: [
			{ label: "Overview", to: "/", icon: OverviewIcon },
			{ label: "Runs", to: "/runs", icon: RunsIcon, badge: "runs" },
			{
				label: "Approvals",
				to: "/approvals",
				icon: ApprovalsIcon,
				badge: "approvals",
			},
			{ label: "Workflows", to: "/workflows", icon: WorkflowsIcon },
			{ label: "Repositories", to: "/repositories", icon: RepositoriesIcon },
		],
	},
	{
		label: "Observe",
		items: [{ label: "Usage", to: "/usage", icon: UsageIcon }],
	},
	{
		label: "Manage",
		items: [
			{ label: "Settings", to: "/settings", icon: SettingsIcon },
			{ label: "Devices", to: "/devices", icon: DevicesIcon },
		],
	},
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
