import { Link } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand/brand-mark";
import { ShaderBackdrop } from "@/components/brand/shader-backdrop";
import {
	ApproveIcon,
	ArrowRightIcon,
	DatabaseIcon,
	DevicesIcon,
	KeyIcon,
	PlayIcon,
	ShieldCheckIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";

const facts = [
	["Execution", "Isolated sandbox"],
	["Approval", "Payload-bound"],
	["Credentials", "Device-held"],
	["Connectors", "Ten supported"],
];

const lifecycle = [
	{
		icon: PlayIcon,
		title: "Queue",
		copy: "Pin a workflow version and submit one bounded task.",
	},
	{
		icon: ShieldCheckIcon,
		title: "Execute",
		copy: "A worker claims the job and provisions an isolated sandbox.",
	},
	{
		icon: DatabaseIcon,
		title: "Validate",
		copy: "The diff gate and the repository’s validation command decide.",
	},
	{
		icon: ApproveIcon,
		title: "Approve",
		copy: "A person authorizes the exact push or pull request.",
	},
];

const auditRows = [
	["task.submitted", "worker", "review_ready · +2 files"],
	["sandbox.provisioned", "worker", "1.2 s · egress denied"],
	["validation.finished", "worker", "exit 0 · 214 checks"],
	["approval.requested", "worker", "push · payload 9f3c…"],
	["approval.decided", "sahil", "approved · audited"],
];

function Screenshot({
	src,
	alt,
	width,
	height,
	className,
}: {
	src: string;
	alt: string;
	width: number;
	height: number;
	className?: string;
}) {
	return (
		<figure
			className={`overflow-hidden rounded-xl border border-line-subtle bg-surface p-1 ${className ?? ""}`}
		>
			<img
				src={src}
				width={width}
				height={height}
				alt={alt}
				loading="lazy"
				decoding="async"
				className="block w-full rounded-[10px] border border-line-subtle/60"
			/>
		</figure>
	);
}

function TrustDiagram() {
	return (
		<div className="rounded-xl border border-line-subtle bg-elevated/40">
			<div className="grid divide-y divide-line-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
				<div className="p-5">
					<KeyIcon size={18} className="text-brand" />
					<p className="mt-3 text-sm font-medium text-ink">Your device</p>
					<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
						The vendor key stays in the local keychain.
					</p>
				</div>
				<div className="p-5">
					<DevicesIcon size={18} className="text-ink-secondary" />
					<p className="mt-3 text-sm font-medium text-ink">Device daemon</p>
					<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
						Claims typed calls and runs them locally.
					</p>
				</div>
				<div className="p-5">
					<DatabaseIcon size={18} className="text-ink-secondary" />
					<p className="mt-3 text-sm font-medium text-ink">Control plane</p>
					<p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
						Stores a token hash and connector metadata only.
					</p>
				</div>
			</div>
			<div className="flex items-center gap-2 border-t border-line-subtle px-5 py-3 font-mono text-[11px] text-ink-muted">
				<ShieldCheckIcon size={14} />
				No vendor secret is stored server-side, in logs, or in the sandbox.
			</div>
		</div>
	);
}

export function LandingPage() {
	return (
		<div className="relative min-h-dvh">
			<ShaderBackdrop />
			<header className="sticky top-0 z-40 border-b border-line-subtle/80 bg-canvas/80 backdrop-blur-sm">
				<div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-5 lg:px-8">
					<Link
						to="/"
						className="flex items-center gap-2.5"
						aria-label="Isolate home"
					>
						<BrandMark className="size-7" />
						<span className="text-[15px] font-semibold tracking-tight text-ink">
							Isolate
						</span>
					</Link>
					<nav
						className="hidden items-center gap-8 text-[13px] text-ink-secondary md:flex"
						aria-label="Landing navigation"
					>
						<a href="#product" className="transition-colors hover:text-ink">
							Product
						</a>
						<a href="#lifecycle" className="transition-colors hover:text-ink">
							Lifecycle
						</a>
						<a href="#trust" className="transition-colors hover:text-ink">
							Trust
						</a>
					</nav>
					<div className="flex items-center gap-4">
						<Link
							to="/login"
							className="hidden text-[13px] text-ink-secondary transition-colors hover:text-ink sm:block"
						>
							Log in
						</Link>
						<Button asChild className="rounded-full px-4">
							<Link to="/signup">Create account</Link>
						</Button>
					</div>
				</div>
			</header>

			<main className="relative">
				<section className="relative flex min-h-[calc(100svh-4rem)] flex-col justify-center overflow-hidden px-5 pb-16 pt-20 lg:px-8">
					<div
						aria-hidden="true"
						className="pointer-events-none absolute left-1/2 top-1/3 h-[520px] w-[900px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(2,7,10,0.78)_0%,rgba(2,7,10,0.35)_55%,transparent_100%)]"
					/>
					<div className="relative z-10 mx-auto w-full max-w-[1200px] text-center">
						<h1 className="mx-auto max-w-[19ch] text-[clamp(2.6rem,6vw,4.4rem)] font-medium leading-[1.02] tracking-[-0.035em] text-balance text-ink">
							Autonomy with an{" "}
							<span className="text-brand">approval boundary</span>.
						</h1>
						<p className="mx-auto mt-6 max-w-[62ch] text-[17px] leading-8 text-ink-secondary">
							Isolate runs coding agents in isolated sandboxes, validates the
							change, and pauses at the exact moment a human must approve.
						</p>
						<div className="mt-9 flex flex-wrap items-center justify-center gap-3">
							<Button asChild size="lg" className="rounded-full px-6">
								<Link to="/login">
									Open the control plane
									<ArrowRightIcon />
								</Link>
							</Button>
							<Button
								asChild
								variant="outline"
								size="lg"
								className="rounded-full border-line bg-canvas/40 px-6 text-ink backdrop-blur-sm"
							>
								<a href="#product">See how a task moves</a>
							</Button>
						</div>
					</div>
					<div className="relative z-10 mx-auto mt-auto flex w-full max-w-[1200px] items-center justify-between gap-4 pt-20 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
						<span className="flex items-center gap-2">
							<span className="size-1.5 rounded-full bg-brand" />
							sandbox boundary
						</span>
						<span className="hidden sm:block">egress denied by default</span>
						<span>validation required before push</span>
					</div>
				</section>

				<section
					id="product"
					className="mx-auto w-full max-w-[1200px] px-5 pb-24 lg:px-8"
				>
					<div className="mx-auto max-w-[1120px]">
						<Screenshot
							src="/images/dashboard-overview.png"
							alt="Isolate Overview showing active runs, pending approvals, recent activity and a registered device"
							width={1600}
							height={1200}
						/>
						<p className="mt-3 text-center font-mono text-[10px] text-ink-muted">
							Illustrative product view · synthetic data
						</p>
					</div>
				</section>

				<div className="relative bg-canvas">
					<div className="border-y border-line-subtle">
						<div className="mx-auto grid w-full max-w-[1200px] grid-cols-2 divide-x divide-line-subtle px-5 md:grid-cols-4 lg:px-8">
							{facts.map(([label, value]) => (
								<div key={label} className="px-4 py-5 first:pl-0 lg:px-6">
									<p className="font-mono text-[10px] text-ink-muted">
										{label}
									</p>
									<p className="mt-1 text-sm text-ink">{value}</p>
								</div>
							))}
						</div>
					</div>

					<section className="mx-auto w-full max-w-[1200px] px-5 py-24 lg:px-8 lg:py-32">
						<div className="max-w-[58ch]">
							<h2 className="text-[clamp(1.9rem,3.4vw,2.7rem)] font-medium leading-[1.1] tracking-[-0.03em] text-ink">
								A task boundary you can inspect.
							</h2>
							<p className="mt-4 text-base leading-7 text-ink-secondary">
								Every run has a goal, a file-ownership boundary, an execution
								budget, and a durable record of what happened.
							</p>
						</div>

						<div className="mt-20 grid items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
							<div>
								<h3 className="text-[clamp(1.5rem,2.4vw,2rem)] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
									The sandbox is the worker’s whole world.
								</h3>
								<p className="mt-4 max-w-[56ch] text-[15px] leading-7 text-ink-secondary">
									The agent starts from a clean clone, writes only inside the
									declared ownership globs, and loses network egress by default.
									The diff gate rejects anything outside the boundary.
								</p>
								<ul className="mt-7 space-y-3 text-[13px] text-ink-secondary">
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="mt-[7px] h-px w-3 shrink-0 bg-brand" />
										Deny-by-default network and command policy.
									</li>
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="mt-[7px] h-px w-3 shrink-0 bg-brand" />
										Validation runs before a branch is pushed.
									</li>
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="mt-[7px] h-px w-3 shrink-0 bg-brand" />
										Every tool decision is recorded.
									</li>
								</ul>
							</div>
							<Screenshot
								src="/images/dashboard-active-runs.png"
								alt="Active runs table from the Isolate Overview dashboard"
								width={1546}
								height={530}
							/>
						</div>

						<div className="mt-20 grid items-center gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
							<Screenshot
								className="lg:order-1"
								src="/images/dashboard-approvals.png"
								alt="Pending approval panel from the Isolate Overview dashboard"
								width={998}
								height={530}
							/>
							<div className="lg:order-2">
								<h3 className="text-[clamp(1.5rem,2.4vw,2rem)] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
									Approval is bound to the exact payload.
								</h3>
								<p className="mt-4 max-w-[56ch] text-[15px] leading-7 text-ink-secondary">
									A push or pull request pauses the run. The reviewer sees the
									repository, branch, commit and payload hash before deciding.
									The approval cannot be replayed against a different payload.
								</p>
								<ul className="mt-7 space-y-3 text-[13px] text-ink-secondary">
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="size-1.5 shrink-0 translate-y-[7px] rounded-full bg-orange" />
										Separate approve and reject decisions.
									</li>
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="size-1.5 shrink-0 translate-y-[7px] rounded-full bg-orange" />
										High-impact actions require confirmation.
									</li>
									<li className="flex gap-3 border-t border-line-subtle pt-3">
										<span className="size-1.5 shrink-0 translate-y-[7px] rounded-full bg-orange" />
										The decision, actor and payload hash are audited.
									</li>
								</ul>
							</div>
						</div>

						<div className="mt-20 grid items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
							<div>
								<h3 className="text-[clamp(1.5rem,2.4vw,2rem)] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
									Every decision leaves a record.
								</h3>
								<p className="mt-4 max-w-[56ch] text-[15px] leading-7 text-ink-secondary">
									Status, stage, actor and timestamp are durable. The run detail
									page reconstructs the sequence from events, not from a log
									file someone has to trust.
								</p>
							</div>
							<div className="overflow-hidden rounded-xl border border-line-subtle bg-surface">
								<div className="flex items-center justify-between border-b border-line-subtle px-4 py-2.5 font-mono text-[10px] text-ink-muted">
									<span>run events</span>
									<span>newest last</span>
								</div>
								<ul className="divide-y divide-line-subtle/70">
									{auditRows.map(([event, actor, detail]) => (
										<li
											key={event}
											className="grid grid-cols-[1fr_auto] gap-2 px-4 py-2.5 font-mono text-[11px]"
										>
											<span className="text-ink-secondary">{event}</span>
											<span className="text-ink-muted">{actor}</span>
											<span className="col-span-2 text-[10px] text-ink-muted">
												{detail}
											</span>
										</li>
									))}
								</ul>
							</div>
						</div>
					</section>

					<section
						id="lifecycle"
						className="border-y border-line-subtle bg-elevated/30"
					>
						<div className="mx-auto w-full max-w-[1200px] px-5 py-24 lg:px-8">
							<div className="max-w-[58ch]">
								<h2 className="text-[clamp(1.9rem,3.4vw,2.7rem)] font-medium leading-[1.1] tracking-[-0.03em] text-ink">
									From intent to a reviewed change.
								</h2>
							</div>
							<div className="relative mt-14">
								<div
									aria-hidden="true"
									className="absolute left-0 right-0 top-4 hidden h-px bg-gradient-to-r from-brand/70 via-line-strong to-orange/60 md:block"
								/>
								<ol className="grid gap-10 md:grid-cols-4 md:gap-8">
									{lifecycle.map((item) => {
										const Glyph = item.icon;
										return (
											<li key={item.title} className="relative">
												<span className="relative z-10 flex size-8 items-center justify-center rounded-full border border-line bg-canvas">
													<Glyph size={16} className="text-brand" />
												</span>
												<h3 className="mt-5 text-sm font-medium text-ink">
													{item.title}
												</h3>
												<p className="mt-2 max-w-[30ch] text-[13px] leading-6 text-ink-muted">
													{item.copy}
												</p>
											</li>
										);
									})}
								</ol>
							</div>
						</div>
					</section>

					<section
						id="trust"
						className="mx-auto w-full max-w-[1200px] px-5 py-24 lg:px-8"
					>
						<div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center">
							<div>
								<h2 className="text-[clamp(1.9rem,3.4vw,2.7rem)] font-medium leading-[1.1] tracking-[-0.03em] text-ink">
									Your credentials stay on your device.
								</h2>
								<p className="mt-4 max-w-[54ch] text-[15px] leading-7 text-ink-secondary">
									Connectors execute where the keys already live. The control
									plane records only a device token hash and connector metadata,
									so a server compromise cannot reach a vendor account.
								</p>
								<ul className="mt-6 space-y-2 text-[13px] text-ink-secondary">
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

					<section className="border-t border-line-subtle bg-elevated/40">
						<div className="mx-auto flex w-full max-w-[1200px] flex-col items-start justify-between gap-6 px-5 py-16 lg:flex-row lg:items-center lg:px-8">
							<div>
								<h2 className="text-[clamp(1.6rem,2.6vw,2.1rem)] font-medium tracking-[-0.02em] text-ink">
									Run the work. Keep the proof.
								</h2>
								<p className="mt-2 max-w-[52ch] text-sm leading-6 text-ink-secondary">
									Open the control plane to inspect runs, policy decisions and
									approval history.
								</p>
							</div>
							<div className="flex flex-wrap gap-3">
								<Button asChild size="lg" className="rounded-full px-6">
									<Link to="/login">
										Open the control plane
										<ArrowRightIcon />
									</Link>
								</Button>
								<Button
									asChild
									variant="outline"
									size="lg"
									className="rounded-full px-6"
								>
									<Link to="/signup">Create account</Link>
								</Button>
							</div>
						</div>
					</section>
				</div>
			</main>

			<footer className="border-t border-line-subtle bg-canvas">
				<div className="mx-auto grid w-full max-w-[1200px] gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-8">
					<div>
						<Link to="/" className="flex items-center gap-2.5">
							<BrandMark className="size-7" />
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
						<p className="text-xs text-ink-muted">Product</p>
						<ul className="mt-3 space-y-2 text-[13px] text-ink-secondary">
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
						<p className="text-xs text-ink-muted">Platform</p>
						<ul className="mt-3 space-y-2 text-[13px] text-ink-secondary">
							<li>
								<a href="#product" className="transition-colors hover:text-ink">
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
						<p className="text-xs text-ink-muted">Account</p>
						<ul className="mt-3 space-y-2 text-[13px] text-ink-secondary">
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
					<div className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 px-5 py-5 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between lg:px-8">
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
