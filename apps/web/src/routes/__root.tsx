import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import "../styles.css";
import { OrganizationSwitcher } from "../components/auth/OrganizationSwitcher";
import { SessionProvider } from "../components/auth/SessionProvider";
import { UserMenu } from "../components/auth/UserMenu";
import { authStateOptions } from "../features/auth/queries";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		head: () => ({
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ title: "Isolate | Task control plane" },
			],
		}),
		headers: () => ({ "Cache-Control": "private, no-store" }),
		loader: ({ context }) =>
			context.queryClient.ensureQueryData(authStateOptions()),
		component: RootLayout,
		shellComponent: Document,
		errorComponent: () => (
			<main>
				<h1>Unable to load this page</h1>
				<p>Please retry. No execution occurs in this browser.</p>
				<Link to="/">Return to submission</Link>
			</main>
		),
		notFoundComponent: () => (
			<main>
				<h1>Page not found</h1>
				<Link to="/">Return to submission</Link>
			</main>
		),
	},
);
function RootLayout() {
	return (
		<SessionProvider>
			<header>
				<strong>Isolate</strong>
				<nav aria-label="Main navigation">
					<Link to="/" activeOptions={{ exact: true }}>
						Submit task
					</Link>
					<Link to="/runs">Tasks &amp; runs</Link>
					<Link to="/organizations">Organizations</Link>
				</nav>
				<div className="session-controls">
					<OrganizationSwitcher />
					<UserMenu />
				</div>
			</header>
			<Outlet />
			<footer>
				Control plane only. Workers execute tasks in isolated environments.
			</footer>
		</SessionProvider>
	);
}
function Document({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
