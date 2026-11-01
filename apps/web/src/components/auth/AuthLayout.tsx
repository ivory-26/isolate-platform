import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { ShaderBackdrop } from "@/components/brand/shader-backdrop";

/**
 * Focused layout for sign-in and sign-up. No sidebar and no product
 * navigation: the only job here is the credential form. The background is a
 * deliberately quiet version of the landing dot field.
 */
export function AuthLayout({
	eyebrow,
	title,
	description,
	children,
	footer,
}: {
	eyebrow: string;
	title: string;
	description?: ReactNode;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-canvas px-5 py-10 text-ink">
			<ShaderBackdrop variant="auth" />
			<div className="relative z-10 w-full max-w-md space-y-6">
				<header className="flex flex-col items-center gap-3 text-center">
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
						<p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted">
							{eyebrow}
						</p>
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
		</main>
	);
}
