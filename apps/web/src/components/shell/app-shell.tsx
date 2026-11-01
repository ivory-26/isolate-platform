import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { CommandMenu } from "./command-menu";

const SIDEBAR_STORAGE_KEY = "isolate.sidebar.collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
	const [collapsed, setCollapsed] = useState(false);
	const [mobileOpen, setMobileOpen] = useState(false);
	const [commandOpen, setCommandOpen] = useState(false);

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
		<div className="min-h-dvh bg-canvas text-ink">
			<a
				href="#main-content"
				className="sr-only z-50 rounded-md bg-brand px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
			>
				Skip to content
			</a>
			<div className="flex min-h-dvh">
				<aside
					className={cn(
						"sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-150 lg:block",
						collapsed ? "w-16" : "w-60",
					)}
				>
					<AppSidebar
						collapsed={collapsed}
						onToggleCollapsed={toggleCollapsed}
					/>
				</aside>
				<div className="flex min-w-0 flex-1 flex-col">
					<AppTopbar
						onOpenMobileNav={() => setMobileOpen(true)}
						onOpenCommand={() => setCommandOpen(true)}
					/>
					<main id="main-content" className="min-w-0 flex-1">
						{children}
					</main>
				</div>
			</div>

			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					showCloseButton={false}
					className="w-64 gap-0 border-r border-line-subtle bg-elevated p-0"
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					<AppSidebar onNavigate={() => setMobileOpen(false)} />
				</SheetContent>
			</Sheet>

			<CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
		</div>
	);
}
