import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { ShaderBackdrop } from "@/components/brand/shader-backdrop";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EventTrace } from "./components/event-trace";
import { FrameDots, FrameLines } from "./components/frame";
import { LifecycleSection } from "./components/lifecycle-section";
import { ProductShot } from "./components/product-shot";
import { Reveal } from "./components/reveal";
import { SiteFooter } from "./components/site-footer";
import { SiteHeader } from "./components/site-header";
import { TrustSection } from "./components/trust-section";
import { facts } from "./content";
import {
	displayTitle,
	pageContainer,
	rowTitle,
	sectionLede,
	sectionPadding,
	sectionTitle,
} from "./styles";
import "./landing.css";

const enterDelay = (ms: number) =>
	({ "--enter-delay": `${ms}ms` }) as CSSProperties;

function CapabilityRow({
	title,
	copy,
	bullets,
	tone = "brand",
	reverse = false,
	visual,
}: {
	title: string;
	copy: string;
	bullets?: readonly string[];
	tone?: "brand" | "orange";
	reverse?: boolean;
	visual: ReactNode;
}) {
	return (
		<div
			className={cn(
				"grid items-center gap-10 lg:gap-16",
				reverse
					? "lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]"
					: "lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]",
			)}
		>
			<Reveal className={cn(reverse && "lg:order-2")}>
				<h3 className={rowTitle}>{title}</h3>
				<p className="mt-4 max-w-[52ch] text-[15px] leading-[1.75] text-ink-secondary">
					{copy}
				</p>
				{bullets ? (
					<ul className="mt-8 border-t border-line-subtle">
						{bullets.map((bullet) => (
							<li
								key={bullet}
								className="flex gap-3 border-b border-line-subtle py-3.5 text-[14px] leading-6 text-ink-secondary"
							>
								<span
									aria-hidden="true"
									className={cn(
										"mt-[11px] h-px w-3 shrink-0",
										tone === "orange" ? "bg-orange" : "bg-brand",
									)}
								/>
								{bullet}
							</li>
						))}
					</ul>
				) : null}
			</Reveal>

			<Reveal className={cn(reverse && "lg:order-1")} delay={80}>
				{visual}
			</Reveal>
		</div>
	);
}

export function LandingPage() {
	const pageRef = useRef<HTMLDivElement>(null);

	// Arm scroll reveals only after hydration so the page stays readable
	// without JavaScript or if hydration is delayed.
	useEffect(() => {
		pageRef.current?.classList.add("landing-motion-ready");
	}, []);

	return (
		<div ref={pageRef} className="relative isolate min-h-dvh">
			<a
				href="#main"
				className="fixed top-4 left-4 z-50 -translate-y-20 rounded-full bg-canvas px-4 py-2 text-[13px] text-ink transition-transform duration-150 focus:translate-y-0"
			>
				Skip to content
			</a>

			<ShaderBackdrop />

			<SiteHeader />

			<main id="main">
				<section className="relative px-5 pt-20 pb-14 lg:px-8 lg:pt-[120px] lg:pb-14">
					<div className="relative mx-auto w-full max-w-[1200px] text-center">
						<h1
							className={cn(
								displayTitle,
								"landing-enter landing-hero-copy mx-auto max-w-[20ch]",
							)}
							style={enterDelay(0)}
						>
							Autonomy with an{" "}
							<span className="text-brand">approval boundary</span>.
						</h1>

						<p
							className="landing-enter landing-hero-copy mx-auto mt-6 max-w-[58ch] text-[17px] leading-[1.75] text-ink/90"
							style={enterDelay(90)}
						>
							Isolate runs coding agents in isolated sandboxes, validates the
							change, and pauses at the exact moment a human must approve.
						</p>

						<div
							className="landing-enter mt-9 flex flex-wrap items-center justify-center gap-3"
							style={enterDelay(180)}
						>
							<Button
								asChild
								size="lg"
								className="h-11 rounded-full px-6 text-[14px]"
							>
								<Link to="/login">
									Open the control plane
									<ArrowRightIcon />
								</Link>
							</Button>
							<Button
								asChild
								variant="outline"
								size="lg"
								className="h-11 rounded-full border-line-strong bg-canvas/40 px-6 text-[14px] text-ink backdrop-blur-sm hover:bg-canvas/70 hover:text-ink"
							>
								<a href="#lifecycle">See how a task moves</a>
							</Button>
						</div>
					</div>
				</section>

				<section
					aria-labelledby="product-view-title"
					className="relative px-5 pb-24 lg:px-8 lg:pb-28"
				>
					<h2 id="product-view-title" className="sr-only">
						Product view
					</h2>
					<ProductShot
						src="/images/dashboard-overview.png"
						alt="Isolate Overview dashboard showing active runs, pending approvals, recent activity and a registered device"
						width={1600}
						height={1200}
						eager
						fadeBottom
						className="mx-auto w-full max-w-[1200px]"
					/>
				</section>

				<div className="relative">
					<section
						aria-label="Platform facts"
						className="relative border-y border-line-subtle bg-canvas"
					>
						<FrameDots />
						<div className={pageContainer}>
							<dl className="grid grid-cols-2 md:grid-cols-4">
								{facts.map((fact, index) => (
									<div
										key={fact.label}
										className={cn(
											"border-line-subtle py-6 pr-4",
											index % 2 === 1 && "border-l pl-5",
											index >= 2 && "border-t md:border-t-0",
											index > 0 && "md:border-l md:pl-6",
										)}
									>
										<dt className="font-mono text-[11px] leading-4 text-ink-muted">
											{fact.label}
										</dt>
										<dd className="mt-2 text-[15px] leading-5 text-ink">
											{fact.value}
										</dd>
									</div>
								))}
							</dl>
						</div>
					</section>

					<section
						id="capabilities"
						className="relative scroll-mt-20 bg-canvas"
					>
						<FrameDots />
						<div className={cn(pageContainer, sectionPadding)}>
							<Reveal className="max-w-[720px]">
								<h2 className={sectionTitle}>
									A task boundary you can inspect.
								</h2>
								<p className={sectionLede}>
									Every run has a goal, a file-ownership boundary, an execution
									budget, and a durable record of what happened.
								</p>
							</Reveal>

							<div className="mt-20 space-y-24 lg:mt-24 lg:space-y-32">
								<CapabilityRow
									title="The sandbox is the worker’s whole world."
									copy="The agent starts from a clean clone, writes only inside the declared ownership globs, and loses network egress by default. The diff gate rejects anything outside the boundary."
									bullets={[
										"Deny-by-default network and command policy.",
										"Validation runs before a branch is pushed.",
										"Every tool decision is recorded.",
									]}
									visual={
										<ProductShot
											src="/images/dashboard-active-runs.png"
											alt="Active runs table from the Isolate Overview dashboard"
											width={1634}
											height={660}
											fadeBottom
										/>
									}
								/>

								<CapabilityRow
									reverse
									tone="orange"
									title="Approval is bound to the exact payload."
									copy="A push or pull request pauses the run. The reviewer sees the repository, branch, commit and payload hash before deciding. The approval cannot be replayed against a different payload."
									bullets={[
										"Separate approve and reject decisions.",
										"High-impact actions require confirmation.",
										"The decision, actor and payload hash are audited.",
									]}
									visual={
										<ProductShot
											src="/images/dashboard-approvals.png"
											alt="Pending approvals panel from the Isolate Overview dashboard"
											width={1052}
											height={660}
											fadeBottom
										/>
									}
								/>

								<CapabilityRow
									title="Every decision leaves a record."
									copy="Status, stage, actor and timestamp are durable. The run detail page reconstructs the sequence from events, not from a log file someone has to trust."
									visual={<EventTrace />}
								/>
							</div>
						</div>
					</section>

					<LifecycleSection />

					<TrustSection />

					<section className="relative border-t border-line-subtle bg-canvas">
						<FrameDots />
						<FrameDots bottom />
						<div
							className={cn(pageContainer, "py-24 text-center lg:py-[120px]")}
						>
							<Reveal>
								<h2 className={cn(sectionTitle, "mx-auto max-w-[20ch]")}>
									Run the work. Keep the proof.
								</h2>
								<p className="mx-auto mt-5 max-w-[54ch] text-[16px] leading-[1.75] text-ink-secondary">
									Open the control plane to inspect runs, policy decisions and
									approval history.
								</p>
								<div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
									<Button
										asChild
										size="lg"
										className="h-11 rounded-full px-6 text-[14px]"
									>
										<Link to="/login">
											Open the control plane
											<ArrowRightIcon />
										</Link>
									</Button>
									<Link
										to="/signup"
										className="text-[14px] text-ink-secondary underline-offset-4 transition-colors duration-150 hover:text-ink hover:underline"
									>
										Create account
									</Link>
								</div>
							</Reveal>
						</div>
					</section>
					<FrameLines />
				</div>
			</main>

			<SiteFooter />
		</div>
	);
}
