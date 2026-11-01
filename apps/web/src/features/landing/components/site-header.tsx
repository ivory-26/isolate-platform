import { Link } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import { navLinks } from "../content";

export function SiteHeader() {
	return (
		<header className="sticky top-0 z-40 border-b border-line-subtle bg-canvas/85 backdrop-blur-md">
			<div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-5 md:grid md:grid-cols-[1fr_auto_1fr] lg:px-8">
				<Link
					to="/"
					aria-label="Isolate home"
					className="flex items-center gap-2.5 justify-self-start rounded-md"
				>
					<BrandMark className="size-7" />
					<span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
						Isolate
					</span>
				</Link>

				<nav
					aria-label="Landing sections"
					className="hidden items-center gap-8 md:flex"
				>
					{navLinks.map((link) => (
						<a
							key={link.href}
							href={link.href}
							className="text-[13px] text-ink-secondary transition-colors duration-150 hover:text-ink"
						>
							{link.label}
						</a>
					))}
				</nav>

				<div className="flex shrink-0 items-center gap-4 justify-self-end sm:gap-5">
					<Link
						to="/login"
						className="shrink-0 whitespace-nowrap text-[13px] text-ink-secondary transition-colors duration-150 hover:text-ink"
					>
						Log in
					</Link>
					<Button asChild className="h-9 rounded-full px-4 text-[13px]">
						<Link to="/signup">Create account</Link>
					</Button>
				</div>
			</div>
		</header>
	);
}
