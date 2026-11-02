import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import jetBrainsMonoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "../components/auth/SessionProvider";
import { authStateOptions } from "../features/auth/queries";
import "../styles.css";

/**
 * The exact latin-subset woff2 files `@fontsource-variable/*` references from
 * the stylesheet, resolved through Vite's asset pipeline. Preloading them
 * starts the download with the document instead of after the CSS is parsed;
 * both are already `font-display: swap`. `crossOrigin` is required for a font
 * preload to match the CORS request the browser makes for @font-face.
 */
const FONT_PRELOADS = [
	{
		rel: "preload",
		href: interLatin,
		as: "font",
		type: "font/woff2",
		crossOrigin: "anonymous",
	},
	{
		rel: "preload",
		href: jetBrainsMonoLatin,
		as: "font",
		type: "font/woff2",
		crossOrigin: "anonymous",
	},
] as const;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		head: () => ({
			meta: [
				{ charSet: "utf-8" },
				{
					name: "viewport",
					content:
						"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
				},
				{ name: "theme-color", content: "#02070A" },
				{ name: "color-scheme", content: "dark" },
				{ title: "Isolate" },
				{
					name: "description",
					content:
						"Observe, approve and control autonomous engineering work in isolated sandboxes.",
				},
			],
			links: [...FONT_PRELOADS],
		}),
		headers: () => ({ "Cache-Control": "private, no-store" }),
		loader: ({ context }) =>
			context.queryClient.ensureQueryData(authStateOptions()),
		component: RootLayout,
		shellComponent: Document,
		errorComponent: () => (
			<main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
				<p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted">
					CONTROL PLANE
				</p>
				<h1 className="text-2xl font-semibold tracking-tight text-ink">
					Unable to load this page
				</h1>
				<p className="text-sm leading-6 text-ink-secondary">
					Retry the request. No execution happens in this browser.
				</p>
				<Button asChild variant="outline">
					<Link to="/">Return home</Link>
				</Button>
			</main>
		),
		notFoundComponent: () => (
			<main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
				<p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted">
					404
				</p>
				<h1 className="text-2xl font-semibold tracking-tight text-ink">
					Page not found
				</h1>
				<p className="text-sm leading-6 text-ink-secondary">
					This route does not exist in the control plane.
				</p>
				<Button asChild variant="outline">
					<Link to="/">Return home</Link>
				</Button>
			</main>
		),
	},
);

function RootLayout() {
	// The root loader resolved and cached this posture before the first paint.
	const initialState = Route.useLoaderData();
	return (
		<SessionProvider initialState={initialState}>
			<TooltipProvider delayDuration={200}>
				<Outlet />
				<Toaster position="bottom-right" />
			</TooltipProvider>
		</SessionProvider>
	);
}

function Document({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className="dark">
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
