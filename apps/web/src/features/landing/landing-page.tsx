import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { ShaderBackdrop } from "@/components/brand/shader-backdrop";
import {
	type AppIconProps,
	ApproveIcon,
	ArrowRightIcon,
	DatabaseIcon,
	DevicesIcon,
	KeyIcon,
	PlayIcon,
	PlusIcon,
	ServerIcon,
	ShieldCheckIcon,
	TaskIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";

const facts = [
	["Execution", "Isolated sandbox"],
	["Approval", "Payload-bound"],
	["Credentials", "Device-held"],
	["Connectors", "Ten supported"],
];

const capabilities: {
	icon: ComponentType<AppIconProps>;
	title: string;
	copy: string;
}[] = [
	{
		icon: TaskIcon,
		title: "Bounded tasks",
		copy: "Every task carries a goal, file ownership, acceptance criteria, and hard turn, time, token and cost budgets.",
	},
	{
		icon: ShieldCheckIcon,
		title: "Isolated execution",
		copy: "The agent works in a disposable sandbox with deny-by-default egress. The repository’s validation command runs before any push.",
	},
	{
		icon: ApproveIcon,
		title: "A human boundary",
		copy: "Branches and pull requests are approval-gated against the exact payload and commit. Decisions and denials are audited.",
	},
];

const lifecycle = [
	{
		step: "01",
		icon: PlusIcon,
		title: "Queue",
		copy: "Pin a workflow version and submit one bounded task.",
	},
	{
		step: "02",
		icon: PlayIcon,
		title: "Execute",
		copy: "A worker claims the job and provisions an isolated sandbox.",
	},
	{
		step: "03",
		icon: ShieldCheckIcon,
		title: "Validate",
		copy: "The diff gate and the repository’s validation command decide.",
	},
	{
		step: "04",
		icon: ApproveIcon,
		title: "Approve",
		copy: "A person authorizes the exact push or pull request.",
	},
];

function DashboardFrame() {
	return (
		<div className="relative mx-auto w-full max-w-[1120px]">
			<div
				aria-hidden="true"
				className="absolute -inset-x-12 -top-16 h-64 rounded-full bg-brand/10 blur-3xl"
			/>
			<div className="relative overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_40px_120px_rgba(0,0,0,0.62)]">
				<div className="flex h-8 items-center gap-2 border-b border-line-subtle px-3">
					<span className="size-2 rounded-full border border-line-strong bg-elevated" />
					<span className="size-2 rounded-full border border-line-strong bg-elevated" />
					<span className="size-2 rounded-full border border-line-strong bg-elevated" />
					<span className="ml-2 truncate rounded bg-canvas px-2 py-0.5 font-mono text-[10px] text-ink-muted">
						isolate.local/overview
					</span>
				</div>
				<img
					src="/images/dashboard-overview.png"
					width={1600}
					height={1200}
					alt="Isolate Overview dashboard showing active runs, pending approvals, recent activity and a registered device"
					loading="eager"
					decoding="async"
					className="block w-full"
				/>
			</div>
			<p className="mt-3 text-center font-mono text-[10px] text-ink-muted">
				Illustrative product view. Data is synthetic.
			</p>
		</div>
	);
}

function ScreenshotPanel({
	src,
	alt,
	width,
	height,
	className,
	cropTop = false,
}: {
	src: string;
	alt: string;
	width: number;
	height: number;
	className?: string;
	cropTop?: boolean;
}) {
	return (
		<div
			className={`overflow-hidden rounded-lg border border-line-subtle bg-canvas ${
				cropTop ? "relative aspect-[2.5/1]" : ""
			} ${className ?? ""}`}
		>
			<img
				src={src}
				width={width}
				height={height}
				alt={alt}
				loading="eager"
				decoding="async"
				className={
					cropTop
						? "absolute inset-0 h-full w-full object-cover object-top"
						: "block w-full"
				}
			/>
		</div>
	);
}

function TrustDiagram() {
	return (
		<div className="rounded-lg border border-line-subtle bg-canvas/70 p-4">
			<div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
				<div className="rounded-md border border-line-subtle bg-elevated p-3">
					<KeyIcon size={18} className="text-brand" />
					<p className="mt-2 text-sm font-medium text-ink">Your device</p>
					<p className="mt-1 text-xs leading-5 text-ink-muted">
						Vendor key stays in the local keychain.
					</p>
				</div>
				<ArrowRightIcon className="mx-auto text-ink-muted" />
				<div className="rounded-md border border-line-subtle bg-elevated p-3">
					<DevicesIcon size={18} className="text-ink-secondary" />
					<p className="mt-2 text-sm font-medium text-ink">Device daemon</p>
					<p className="mt-1 text-xs leading-5 text-ink-muted">
						Claims typed calls and runs them locally.
					</p>
				</div>
				<ArrowRightIcon className="mx-auto text-ink-muted" />
				<div className="rounded-md border border-line-subtle bg-elevated p-3">
					<ServerIcon size={18} className="text-ink-secondary" />
					<p className="mt-2 text-sm font-medium text-ink">Isolate server</p>
					<p className="mt-1 text-xs leading-5 text-ink-muted">
						Stores a token hash and connector metadata only.
					</p>
				</div>
			</div>
			<div className="mt-4 flex items-center gap-2 border-t border-line-subtle pt-3 text-xs text-ink-muted">
				<DatabaseIcon size={16} />
				No vendor secret is stored server-side, in logs, or in the sandbox.
			</div>
		</div>
	);
}

export function LandingPage() {
	return (
		<div className="min-h-dvh bg-canvas">
			<header className="sticky top-0 z-40 border-b border-line-subtle bg-canvas">
				<div className="mx-auto flex h-16 w-full max-w-[1296px] items-center justify-between gap-4 px-4 lg:px-6">
					<Link
						to="/"
						className="flex items-center gap-2.5"
						aria-label="Isolate home"
					>
						<BrandMark className="size-8" />
						<span className="text-[15px] font-semibold tracking-tight text-ink">
							Isolate
						</span>
					</Link>
					<nav
						className="hidden items-center gap-7 text-sm text-ink-secondary md:flex"
						aria-label="Landing navigation"
					>
						<a
							href="#capabilities"
							className="transition-colors hover:text-ink"
						>
							Capabilities
						</a>
						<a href="#lifecycle" className="transition-colors hover:text-ink">
							Lifecycle
						</a>
						<a href="#trust" className="transition-colors hover:text-ink">
							Trust boundary
						</a>
					</nav>
					<div className="flex items-center gap-2">
						<Button asChild variant="ghost" size="sm">
							<Link to="/login">Log in</Link>
						</Button>
						<Button asChild size="sm">
							<Link to="/signup">Create account</Link>
						</Button>
					</div>
				</div>
			</header>

			<main>
				<section className="relative bg-canvas">
					<div className="relative z-10 mx-auto w-full max-w-[1296px] px-4 pt-20 lg:px-6 lg:pt-28">
						<div className="mx-auto max-w-4xl text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
							<p className="font-mono text-xs text-brand">
								Autonomous DevSecOps control plane
							</p>
							<h1 className="mx-auto mt-5 max-w-4xl text-[clamp(2.9rem,6.2vw,4.8rem)] font-semibold leading-[0.98] tracking-[-0.035em] text-ink">
								Autonomy with an approval boundary.
							</h1>
							<p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-ink-secondary">
								Isolate runs coding agents in isolated sandboxes, validates the
								change, and pauses at the exact moment a human must approve.
							</p>
							<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
								<Button asChild size="lg">
									<Link to="/login">
										Open the control plane
										<ArrowRightIcon />
									</Link>
								</Button>
								<Button asChild variant="outline" size="lg">
									<a href="#lifecycle">See how a task moves</a>
								</Button>
							</div>
						</div>
					</div>
					<div className="relative mx-auto w-full max-w-[1296px] px-4 pt-10 pb-20 lg:px-6">
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_42%,transparent_88%)]"
						>
							<ShaderBackdrop variant="landing" />
						</div>
						<div className="relative z-10">
							<DashboardFrame />
						</div>
					</div>
				</section>

				<div className="border-y border-line-subtle bg-canvas">
					<div className="mx-auto grid w-full max-w-[1296px] grid-cols-2 gap-px bg-line-subtle px-4 md:grid-cols-4 lg:px-6">
						{facts.map(([label, value]) => (
							<div key={label} className="bg-canvas px-4 py-4 lg:px-6">
								<p className="font-mono text-[10px] text-ink-muted">{label}</p>
								<p className="mt-1 text-sm text-ink">{value}</p>
							</div>
						))}
					</div>
				</div>

				<section id="capabilities" className="bg-canvas">
					<div className="mx-auto w-full max-w-[1296px] px-4 py-24 lg:px-6">
						<div className="max-w-2xl">
							<p className="font-mono text-xs text-brand">Capabilities</p>
							<h2 className="mt-3 text-4xl font-medium tracking-tight text-ink">
								A task boundary you can inspect.
							</h2>
							<p className="mt-4 text-base leading-7 text-ink-secondary">
								Every run has a goal, a file-ownership boundary, an execution
								budget, and a durable record of what happened.
							</p>
						</div>
						<div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line-subtle bg-line-subtle md:grid-cols-3">
							{capabilities.map((capability) => {
								const Glyph = capability.icon;
								return (
									<div key={capability.title} className="bg-canvas p-6">
										<Glyph size={20} className="text-brand" />
										<h3 className="mt-4 text-sm font-medium text-ink">
											{capability.title}
										</h3>
										<p className="mt-2 text-sm leading-6 text-ink-secondary">
											{capability.copy}
										</p>
									</div>
								);
							})}
						</div>

						<div className="mt-20 grid items-center gap-12 lg:grid-cols-2">
							<div>
								<p className="font-mono text-xs text-brand">Execution</p>
								<h2 className="mt-3 text-3xl font-medium tracking-tight text-ink">
									The sandbox is the worker’s whole world.
								</h2>
								<p className="mt-4 text-base leading-7 text-ink-secondary">
									The agent starts from a clean clone, writes only inside the
									declared ownership globs, and loses network egress by default.
									The diff gate rejects anything outside the boundary.
								</p>
								<ul className="mt-6 space-y-2 text-sm text-ink-secondary">
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
										Deny-by-default network and command policy.
									</li>
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
										Validation runs before a branch is pushed.
									</li>
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
										Every tool decision is recorded.
									</li>
								</ul>
							</div>
							<ScreenshotPanel
								src="/images/dashboard-active-runs.png"
								alt="Active runs table from the Isolate Overview dashboard"
								width={1546}
								height={530}
							/>
						</div>

						<div className="mt-20 grid items-center gap-12 lg:grid-cols-2">
							<ScreenshotPanel
								src="/images/dashboard-approvals.png"
								alt="Pending approval panel from the Isolate Overview dashboard"
								width={998}
								height={530}
								cropTop
								className="lg:order-1"
							/>
							<div className="lg:order-2">
								<p className="font-mono text-xs text-brand">Approval</p>
								<h2 className="mt-3 text-3xl font-medium tracking-tight text-ink">
									Approval is bound to the exact payload.
								</h2>
								<p className="mt-4 text-base leading-7 text-ink-secondary">
									A push or pull request pauses the run. The reviewer sees the
									repository, branch, commit and payload hash before deciding.
									The approval cannot be replayed against a different payload.
								</p>
								<ul className="mt-6 space-y-2 text-sm text-ink-secondary">
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-orange" />
										Separate approve and reject decisions.
									</li>
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-orange" />
										High-impact actions require confirmation.
									</li>
									<li className="flex gap-2">
										<span className="mt-2 size-1.5 shrink-0 rounded-full bg-orange" />
										The decision, actor and payload hash are audited.
									</li>
								</ul>
							</div>
						</div>
					</div>
				</section>

				<section
					id="lifecycle"
					className="border-t border-line-subtle bg-elevated/40"
				>
					<div className="mx-auto w-full max-w-[1296px] px-4 py-24 lg:px-6">
						<div className="max-w-2xl">
							<p className="font-mono text-xs text-brand">Lifecycle</p>
							<h2 className="mt-3 text-4xl font-medium tracking-tight text-ink">
								From intent to a reviewed change.
							</h2>
						</div>
						<ol className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line-subtle bg-line-subtle md:grid-cols-4">
							{lifecycle.map((item) => {
								const Glyph = item.icon;
								return (
									<li key={item.step} className="bg-canvas p-6">
										<div className="flex items-center justify-between">
											<span className="font-mono text-xs text-ink-muted">
												{item.step}
											</span>
											<Glyph size={18} className="text-ink-muted" />
										</div>
										<h3 className="mt-6 text-sm font-medium text-ink">
											{item.title}
										</h3>
										<p className="mt-2 text-sm leading-6 text-ink-secondary">
											{item.copy}
										</p>
									</li>
								);
							})}
						</ol>
					</div>
				</section>

				<section
					id="trust"
					className="border-t border-line-subtle bg-canvas/85"
				>
					<div className="mx-auto grid w-full max-w-[1296px] gap-12 px-4 py-24 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:px-6">
						<div>
							<p className="font-mono text-xs text-brand">Trust boundary</p>
							<h2 className="mt-3 text-4xl font-medium tracking-tight text-ink">
								Your credentials stay on your device.
							</h2>
							<p className="mt-4 text-base leading-7 text-ink-secondary">
								Connectors execute where the keys already live. The control
								plane records only a device token hash and connector metadata,
								so a server compromise cannot reach a vendor account.
							</p>
							<ul className="mt-6 space-y-2 text-sm text-ink-secondary">
								<li className="flex gap-2">
									<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
									Ten connectors, one device daemon.
								</li>
								<li className="flex gap-2">
									<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
									Typed calls are claimed, bounded and audited.
								</li>
								<li className="flex gap-2">
									<span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
									No platform-held provider keys.
								</li>
							</ul>
						</div>
						<TrustDiagram />
					</div>
				</section>

				<section className="border-t border-line-subtle bg-elevated/50">
					<div className="mx-auto flex w-full max-w-[1296px] flex-col items-start justify-between gap-6 px-4 py-16 lg:flex-row lg:items-center lg:px-6">
						<div>
							<h2 className="text-3xl font-medium tracking-tight text-ink">
								Run the work. Keep the proof.
							</h2>
							<p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
								Open the control plane to inspect runs, policy decisions and
								approval history.
							</p>
						</div>
						<div className="flex flex-wrap gap-3">
							<Button asChild size="lg">
								<Link to="/login">
									Open the control plane
									<ArrowRightIcon />
								</Link>
							</Button>
							<Button asChild variant="outline" size="lg">
								<Link to="/signup">Create account</Link>
							</Button>
						</div>
					</div>
				</section>
			</main>

			<footer className="border-t border-line-subtle bg-canvas">
				<div className="mx-auto grid w-full max-w-[1296px] gap-10 px-4 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-6">
					<div>
						<Link to="/" className="flex items-center gap-2.5">
							<BrandMark className="size-8" />
							<span className="text-[15px] font-semibold tracking-tight text-ink">
								Isolate
							</span>
						</Link>
						<p className="mt-4 max-w-xs text-xs leading-5 text-ink-muted">
							An autonomous DevSecOps control plane for bounded tasks, isolated
							execution and approval-gated changes.
						</p>
					</div>
					<div>
						<p className="font-mono text-[10px] text-ink-muted">Product</p>
						<ul className="mt-3 space-y-2 text-sm text-ink-secondary">
							<li>
								<Link to="/login" className="transition-colors hover:text-ink">
									Overview
								</Link>
							</li>
							<li>
								<Link to="/login" className="transition-colors hover:text-ink">
									Runs
								</Link>
							</li>
							<li>
								<Link to="/login" className="transition-colors hover:text-ink">
									Approvals
								</Link>
							</li>
							<li>
								<Link to="/login" className="transition-colors hover:text-ink">
									Usage
								</Link>
							</li>
						</ul>
					</div>
					<div>
						<p className="font-mono text-[10px] text-ink-muted">Platform</p>
						<ul className="mt-3 space-y-2 text-sm text-ink-secondary">
							<li>
								<a
									href="#capabilities"
									className="transition-colors hover:text-ink"
								>
									Isolated execution
								</a>
							</li>
							<li>
								<a href="#trust" className="transition-colors hover:text-ink">
									Device-held credentials
								</a>
							</li>
							<li>
								<a
									href="#lifecycle"
									className="transition-colors hover:text-ink"
								>
									Approval gates
								</a>
							</li>
						</ul>
					</div>
					<div>
						<p className="font-mono text-[10px] text-ink-muted">Account</p>
						<ul className="mt-3 space-y-2 text-sm text-ink-secondary">
							<li>
								<Link to="/login" className="transition-colors hover:text-ink">
									Log in
								</Link>
							</li>
							<li>
								<Link to="/signup" className="transition-colors hover:text-ink">
									Create account
								</Link>
							</li>
						</ul>
					</div>
				</div>
				<div className="border-t border-line-subtle">
					<div className="mx-auto flex w-full max-w-[1296px] flex-col gap-2 px-4 py-5 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between lg:px-6">
						<p>© 2026 Isolate</p>
						<p className="font-mono">
							Local-first DevSecOps · device-held credentials
						</p>
					</div>
				</div>
			</footer>
		</div>
	);
}
