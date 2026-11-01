import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { ShaderField } from "@/components/brand/shader-backdrop";

/**
 * Focused layout for sign-in and sign-up. The shader field carries the brand on
 * desktop; the form sits on a solid canvas beside it. On mobile the field
 * becomes a short band behind the brand header and the card follows.
 */
export function AuthLayout({
	title,
	description,
	children,
	footer,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<main className="grid min-h-dvh lg:grid-cols-2">
			<aside className="relative hidden overflow-hidden border-r border-line-subtle lg:block">
				<div className="absolute inset-0" aria-hidden="true">
					<ShaderField />
				</div>
				<div
					aria-hidden="true"
					className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(2,7,10,0.55)_0%,rgba(2,7,10,0.08)_45%,rgba(2,7,10,0.72)_100%)]"
				/>
				<div className="relative flex h-full flex-col justify-between p-10">
					<Link to="/" className="flex items-center gap-2.5">
						<BrandMark className="size-8" markClassName="size-6" />
						<span className="text-[15px] font-semibold tracking-tight text-ink">
							Isolate
						</span>
					</Link>
					<div className="max-w-sm">
						<p className="text-[clamp(1.8rem,3vw,2.6rem)] font-medium leading-[1.1] tracking-[-0.03em] text-balance text-ink">
							Autonomy with an{" "}
							<span className="text-brand">approval boundary</span>.
						</p>
						<p className="mt-4 text-sm leading-6 text-ink-secondary">
							Tasks run in isolated sandboxes; sensitive writes wait for your
							approval.
						</p>
					</div>
					<p className="font-mono text-[10px] text-ink-muted">
						sandbox boundary · device-held credentials
					</p>
				</div>
			</aside>

			<div className="relative flex items-center justify-center px-5 pt-[calc(2rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))]">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-0 h-56 overflow-hidden lg:hidden"
				>
					<ShaderField />
					<div className="absolute inset-0 bg-gradient-to-b from-canvas/20 via-canvas/45 to-canvas" />
				</div>
				<div className="relative z-10 w-full max-w-md space-y-6">
					<header className="flex flex-col items-center gap-3 text-center lg:hidden">
						<Link
							to="/"
							className="flex items-center gap-2.5 rounded-md focus-visible:outline-none"
						>
							<BrandMark className="size-9" markClassName="size-6" />
							<span className="text-lg font-semibold tracking-tight text-ink">
								Isolate
							</span>
						</Link>
						<p className="max-w-sm text-sm leading-6 text-ink-secondary">
							The autonomous DevSecOps control plane. Tasks run in isolated
							sandboxes; sensitive writes wait for your approval.
						</p>
					</header>

					<section className="rounded-xl border border-line-subtle bg-surface/95 p-6 shadow-[0_24px_72px_rgba(0,0,0,0.48)]">
						<div className="mb-5 space-y-1.5">
							<h1 className="text-xl font-medium tracking-tight text-ink">
								{title}
							</h1>
							{description ? (
								<p className="text-sm leading-6 text-ink-secondary">
									{description}
								</p>
							) : null}
						</div>
						{children}
					</section>

					{footer ? (
						<footer className="text-center text-xs leading-5 text-ink-muted">
							{footer}
						</footer>
					) : null}
					<p className="text-center">
						<Link
							to="/"
							className="font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
						>
							Back to the overview
						</Link>
					</p>
				</div>
			</div>
		</main>
	);
}
