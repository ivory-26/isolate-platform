import { Link, useRouterState } from "@tanstack/react-router";
import { ModShortcut } from "@/components/common/mod-shortcut";
import { ChevronRightIcon, MenuIcon, SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, NAV_ITEMS } from "./nav";
import { UserMenu } from "./user-menu";

function contextFor(pathname: string) {
	const item = NAV_ITEMS.find(
		(entry) => pathname === entry.to || pathname.startsWith(`${entry.to}/`),
	);
	const group = NAV_GROUPS.find((entry) =>
		entry.items.some((candidate) => candidate.to === item?.to),
	);
	if (pathname.startsWith("/runs/")) {
		return { group: "Operate", label: "Run detail" };
	}
	if (pathname.startsWith("/submit")) {
		return { group: "Operate", label: "Submit task" };
	}
	return { group: group?.label ?? "Operate", label: item?.label ?? "Overview" };
}

export function AppTopbar({
	onOpenMobileNav,
	onOpenCommand,
	className,
}: {
	onOpenMobileNav: () => void;
	onOpenCommand: () => void;
	className?: string;
}) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const context = contextFor(pathname);

	return (
		<header
			className={cn(
				"sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line-subtle bg-canvas px-4 lg:px-6",
				className,
			)}
		>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="lg:hidden"
				onClick={onOpenMobileNav}
				aria-label="Open navigation"
			>
				<MenuIcon />
			</Button>

			<nav aria-label="Breadcrumb" className="min-w-0 flex-1">
				<ol className="flex min-w-0 items-center gap-1.5 text-xs">
					<li className="hidden shrink-0 sm:block">
						<Link
							to="/overview"
							className="text-ink-muted transition-colors hover:text-ink"
						>
							Isolate
						</Link>
					</li>
					<li className="hidden shrink-0 sm:block" aria-hidden="true">
						<ChevronRightIcon className="text-ink-muted/60" />
					</li>
					<li className="hidden shrink-0 text-ink-muted md:block">
						{context.group}
					</li>
					<li className="hidden shrink-0 md:block" aria-hidden="true">
						<ChevronRightIcon className="text-ink-muted/60" />
					</li>
					<li className="truncate font-medium text-ink">{context.label}</li>
				</ol>
			</nav>

			<Button
				type="button"
				variant="outline"
				size="sm"
				className="hidden w-56 justify-start gap-2 text-ink-muted md:flex"
				onClick={onOpenCommand}
			>
				<SearchIcon />
				<span className="flex-1 text-left text-xs">Search or jump to…</span>
				<ModShortcut />
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="md:hidden"
				onClick={onOpenCommand}
				aria-label="Search or jump to"
			>
				<SearchIcon />
			</Button>

			<div className="flex items-center gap-2 border-l border-line-subtle pl-2">
				<UserMenu />
			</div>
		</header>
	);
}
