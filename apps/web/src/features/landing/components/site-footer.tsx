import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { ArrowRightIcon, ChevronUpIcon } from "@/components/icons";

function FooterColumn({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div>
			<div className="flex items-center gap-2 border-b border-line-subtle pb-3">
				<span aria-hidden="true" className="size-1.5 bg-brand" />
				<h2 className="text-[12px] font-medium text-ink">{title}</h2>
			</div>
			<ul className="mt-4 space-y-3 text-[13px] text-ink-secondary">
				{children}
			</ul>
		</div>
	);
}

const linkClass =
	"group inline-flex items-center gap-2 text-ink-secondary transition-colors duration-150 hover:text-ink focus-visible:text-ink";

function FooterLink({
	to,
	href,
	children,
}: {
	to?: "/login" | "/signup";
	href?: string;
	children: ReactNode;
}) {
	const content = (
		<>
			<span
				aria-hidden="true"
				className="h-px w-0 bg-brand transition-[width] duration-200 group-hover:w-3 group-focus-visible:w-3"
			/>
			{children}
			<ArrowRightIcon
				size={12}
				className="-translate-x-1 opacity-0 transition-[transform,opacity] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
			/>
		</>
	);
	return (
		<li>
			{to ? (
				<Link to={to} className={linkClass}>
					{content}
				</Link>
			) : (
				<a href={href} className={linkClass}>
					{content}
				</a>
			)}
		</li>
	);
}

export function SiteFooter() {
	return (
		<footer className="border-t border-line-subtle bg-canvas">
			<div className="mx-auto w-full max-w-[1200px] px-5 pt-16 lg:px-8">
				<div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
					<div>
						<Link
							to="/"
							aria-label="Isolate home"
							className="inline-flex items-center gap-2.5"
						>
							<BrandMark className="size-7" />
							<span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
								Isolate
							</span>
						</Link>
						<p className="mt-5 max-w-[34ch] text-[13px] leading-6 text-ink-muted">
							An autonomous DevSecOps control plane for bounded tasks, isolated
							execution and approval-gated changes.
						</p>
						<p className="mt-7 inline-flex items-center gap-2 border border-line-subtle px-2.5 py-1.5 font-mono text-[10px] text-ink-muted">
							<span aria-hidden="true" className="size-1.5 bg-success" />
							Local-first · no platform-held keys
						</p>
					</div>

					<FooterColumn title="Product">
						<FooterLink to="/login">Overview</FooterLink>
						<FooterLink to="/login">Runs</FooterLink>
						<FooterLink to="/login">Approvals</FooterLink>
						<FooterLink to="/login">Usage</FooterLink>
					</FooterColumn>

					<FooterColumn title="Platform">
						<FooterLink href="#capabilities">Isolated execution</FooterLink>
						<FooterLink href="#lifecycle">Approval gates</FooterLink>
						<FooterLink href="#trust">Device-held credentials</FooterLink>
					</FooterColumn>

					<FooterColumn title="Account">
						<FooterLink to="/login">Log in</FooterLink>
						<FooterLink to="/signup">Create account</FooterLink>
					</FooterColumn>
				</div>

				<div className="mt-16 overflow-hidden border-t border-line-subtle pt-10">
					<p
						aria-hidden="true"
						className="select-none text-[clamp(3rem,12.5vw,9.5rem)] font-semibold leading-[0.78] tracking-[-0.06em] text-ink/[0.055]"
					>
						ISOLATE
					</p>
				</div>

				<div className="mt-10 flex flex-col gap-4 border-t border-line-subtle py-6 text-[11px] text-ink-muted sm:flex-row sm:items-center sm:justify-between">
					<p>© 2026 Isolate</p>
					<div className="flex flex-wrap items-center gap-x-6 gap-y-2">
						<span className="font-mono">
							Local-first DevSecOps · device-held credentials
						</span>
						<a
							href="#main"
							className="group inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-ink"
						>
							Back to top
							<ChevronUpIcon
								size={12}
								className="transition-transform duration-200 group-hover:-translate-y-0.5"
							/>
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
}
