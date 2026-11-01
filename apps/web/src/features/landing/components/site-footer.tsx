import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand/brand-mark";

function FooterColumn({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div>
			<h2 className="font-mono text-[10px] leading-4 font-normal text-ink-muted">
				{title}
			</h2>
			<ul className="mt-4 space-y-2.5 text-[13px] text-ink-secondary">
				{children}
			</ul>
		</div>
	);
}

const linkClass =
	"transition-colors duration-150 hover:text-ink focus-visible:text-ink";

export function SiteFooter() {
	return (
		<footer className="border-t border-line-subtle bg-canvas">
			<div className="mx-auto grid w-full max-w-[1200px] gap-10 px-5 py-16 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr] lg:px-8">
				<div>
					<Link
						to="/"
						aria-label="Isolate home"
						className="flex items-center gap-2.5"
					>
						<BrandMark className="size-7" />
						<span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
							Isolate
						</span>
					</Link>
					<p className="mt-4 max-w-[30ch] text-[13px] leading-6 text-ink-muted">
						An autonomous DevSecOps control plane for bounded tasks, isolated
						execution and approval-gated changes.
					</p>
				</div>

				<FooterColumn title="Product">
					<li>
						<Link to="/login" className={linkClass}>
							Overview
						</Link>
					</li>
					<li>
						<Link to="/login" className={linkClass}>
							Runs
						</Link>
					</li>
					<li>
						<Link to="/login" className={linkClass}>
							Approvals
						</Link>
					</li>
					<li>
						<Link to="/login" className={linkClass}>
							Usage
						</Link>
					</li>
				</FooterColumn>

				<FooterColumn title="Platform">
					<li>
						<a href="#capabilities" className={linkClass}>
							Isolated execution
						</a>
					</li>
					<li>
						<a href="#trust" className={linkClass}>
							Device-held credentials
						</a>
					</li>
					<li>
						<a href="#lifecycle" className={linkClass}>
							Approval gates
						</a>
					</li>
				</FooterColumn>

				<FooterColumn title="Account">
					<li>
						<Link to="/login" className={linkClass}>
							Log in
						</Link>
					</li>
					<li>
						<Link to="/signup" className={linkClass}>
							Create account
						</Link>
					</li>
				</FooterColumn>
			</div>

			<div className="border-t border-line-subtle">
				<div className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 px-5 py-5 text-[12px] text-ink-muted sm:flex-row sm:items-center sm:justify-between lg:px-8">
					<p>© 2026 Isolate</p>
					<p className="font-mono">
						Local-first DevSecOps · device-held credentials
					</p>
				</div>
			</div>
		</footer>
	);
}
