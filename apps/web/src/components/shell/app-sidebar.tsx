import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { useSession } from "@/components/auth/SessionProvider";
import { BrandMark } from "@/components/brand/brand-mark";
import {
	type AppIconProps,
	ChevronLeftIcon,
	ChevronRightIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { shellSummaryOptions } from "@/features/shell/queries";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, type NavItem } from "./nav";
import { OrganizationMenu } from "./organization-menu";

function NavLink({
	item,
	collapsed,
	count,
	onNavigate,
}: {
	item: NavItem;
	collapsed: boolean;
	count: number;
	onNavigate?: () => void;
}) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
	const Glyph: ComponentType<AppIconProps> = item.icon;
	const link = (
		<Link
			to={item.to}
			onClick={onNavigate}
			aria-current={active ? "page" : undefined}
			className={cn(
				"relative flex h-9 items-center gap-2.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors",
				active
					? "border-brand/25 bg-brand/10 text-ink"
					: "border-transparent text-ink-secondary hover:bg-hover hover:text-ink",
				collapsed && "justify-center px-0",
			)}
		>
			<Glyph size={18} className={active ? "text-brand" : "text-ink-muted"} />
			{!collapsed ? (
				<>
					<span className="min-w-0 flex-1 truncate">{item.label}</span>
					{count > 0 ? (
						<span className="rounded-full border border-line bg-elevated px-1.5 font-mono text-[10px] text-ink-secondary tabular-nums">
							{count > 99 ? "99+" : count}
						</span>
					) : null}
				</>
			) : count > 0 ? (
				<span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-orange" />
			) : null}
		</Link>
	);
	if (!collapsed) return link;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{link}</TooltipTrigger>
			<TooltipContent side="right">{item.label}</TooltipContent>
		</Tooltip>
	);
}

export function AppSidebar({
	collapsed = false,
	onToggleCollapsed,
	onNavigate,
	className,
}: {
	collapsed?: boolean;
	onToggleCollapsed?: () => void;
	onNavigate?: () => void;
	className?: string;
}) {
	const session = useSession();
	const summary = useQuery(shellSummaryOptions());
	const counts = summary.data?.ok
		? summary.data.value
		: { pendingApprovals: 0, activeTasks: 0 };

	return (
		<div
			className={cn(
				"flex h-full flex-col border-r border-line-subtle bg-elevated",
				collapsed ? "w-16" : "w-60",
				className,
			)}
		>
			<div
				className={cn(
					"flex h-14 items-center px-3",
					collapsed && "justify-center px-0",
				)}
			>
				<Link
					to="/overview"
					onClick={onNavigate}
					className="flex min-w-0 items-center gap-2.5"
					aria-label="Isolate overview"
				>
					<BrandMark />
					{!collapsed ? (
						<span className="min-w-0">
							<span className="block truncate text-sm font-semibold tracking-tight text-ink">
								Isolate
							</span>
							<span className="block font-mono text-[10px] text-ink-muted">
								Control plane
							</span>
						</span>
					) : null}
				</Link>
			</div>

			<div className={cn("px-2 pb-3", collapsed && "px-1.5")}>
				<OrganizationMenu collapsed={collapsed} />
			</div>

			<nav
				className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4"
				aria-label="Primary navigation"
			>
				{NAV_GROUPS.map((group) => (
					<div key={group.label} className="space-y-1">
						{!collapsed ? (
							<p className="px-2 pb-1 font-mono text-[10px] font-medium tracking-[0.14em] text-ink-muted/80 uppercase">
								{group.label}
							</p>
						) : (
							<div className="mx-auto mb-1 h-px w-6 bg-line-subtle" />
						)}
						{group.items.map((item) => (
							<NavLink
								key={item.to}
								item={item}
								collapsed={collapsed}
								count={
									item.badge === "approvals"
										? counts.pendingApprovals
										: item.badge === "runs"
											? counts.activeTasks
											: 0
								}
								onNavigate={onNavigate}
							/>
						))}
					</div>
				))}
			</nav>

			<div
				className={cn(
					"space-y-2 border-t border-line-subtle p-2",
					collapsed && "px-1.5",
				)}
			>
				{!collapsed ? (
					<p className="flex items-center gap-2 px-2.5 font-mono text-[10px] text-ink-muted">
						<span
							className={cn(
								"size-1.5 rounded-full",
								session.mode === "authenticated"
									? "bg-success"
									: session.mode === "demo"
										? "bg-orange"
										: "bg-ink-muted",
							)}
						/>
						{session.mode === "demo"
							? "Local demo"
							: session.mode === "authenticated"
								? "Signed in"
								: "Unavailable"}
					</p>
				) : null}
				{onToggleCollapsed ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size={collapsed ? "icon-sm" : "sm"}
								className={cn(
									"w-full justify-start gap-2 text-ink-muted",
									collapsed && "justify-center",
								)}
								onClick={onToggleCollapsed}
								aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
							>
								{collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
								{!collapsed ? <span>Collapse</span> : null}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{collapsed ? "Expand sidebar" : "Collapse sidebar"}
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>
		</div>
	);
}
