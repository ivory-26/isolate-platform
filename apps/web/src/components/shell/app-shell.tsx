import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
	WORKSPACE_MAIN_ID,
	WORKSPACE_SCROLL_ATTRIBUTE,
	WORKSPACE_SCROLL_ID,
} from "@/lib/workspace-scroll";
import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { CommandMenu } from "./command-menu";
import { useWorkspaceScrollRestoration } from "./use-workspace-scroll";
import { WorkspaceFrame } from "./workspace-frame";
import { WorkspaceHashLink } from "./workspace-hash-link";

const SIDEBAR_STORAGE_KEY = "isolate.sidebar.collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
	const [collapsed, setCollapsed] = useState(false);
	const [mobileOpen, setMobileOpen] = useState(false);
	const [commandOpen, setCommandOpen] = useState(false);
	const paneRef = useWorkspaceScrollRestoration();

	useEffect(() => {
		try {
			setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true");
		} catch {
			/* storage unavailable; keep the expanded default */
		}
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setCommandOpen((current) => !current);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const toggleCollapsed = () => {
		setCollapsed((current) => {
			const next = !current;
			try {
				window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
			} catch {
				/* storage unavailable; the in-memory state still applies */
			}
			return next;
		});
	};

	return (
		<WorkspaceFrame>
			<WorkspaceHashLink
				hash={WORKSPACE_MAIN_ID}
				className="sr-only z-50 rounded-md bg-brand px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
			>
				Skip to content
			</WorkspaceHashLink>
			<div className="flex h-full">
				<aside
					className={cn(
						"hidden h-full shrink-0 transition-[width] duration-150 lg:block",
						collapsed ? "w-16" : "w-60",
					)}
				>
					<AppSidebar
						collapsed={collapsed}
						onToggleCollapsed={toggleCollapsed}
					/>
				</aside>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<AppTopbar
						onOpenMobileNav={() => setMobileOpen(true)}
						onOpenCommand={() => setCommandOpen(true)}
					/>
					<main
						ref={paneRef}
						id={WORKSPACE_MAIN_ID}
						{...{ [WORKSPACE_SCROLL_ATTRIBUTE]: WORKSPACE_SCROLL_ID }}
						tabIndex={-1}
						className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
					>
						{children}
					</main>
				</div>
			</div>

			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					showCloseButton={false}
					className="w-64 gap-0 border-r border-line-subtle bg-elevated p-0 pb-[env(safe-area-inset-bottom)]"
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					<AppSidebar onNavigate={() => setMobileOpen(false)} />
				</SheetContent>
			</Sheet>

			<CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
		</WorkspaceFrame>
	);
}
