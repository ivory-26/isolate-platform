import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { lifecycle } from "../content";
import {
	pageContainer,
	sectionLede,
	sectionPadding,
	sectionTitle,
} from "../styles";
import { FrameDots } from "./frame";
import { Reveal, useInView } from "./reveal";

export function LifecycleSection() {
	const { ref, inView } = useInView<HTMLDivElement>();

	return (
		<section
			id="lifecycle"
			className="relative scroll-mt-20 border-y border-line-subtle bg-elevated"
		>
			<FrameDots />
			<div className={cn(pageContainer, sectionPadding)}>
				<Reveal className="max-w-[64ch]">
					<h2 className={sectionTitle}>From intent to a reviewed change.</h2>
					<p className={sectionLede}>
						Queue, execute, validate, then pause for a person. Each transition
						is a named event in the run record.
					</p>
				</Reveal>

				<div
					ref={ref}
					className={cn(
						"landing-trace relative mt-16 lg:mt-20",
						inView && "is-in",
					)}
				>
					<ol className="grid gap-10 md:grid-cols-4 md:gap-8">
						{lifecycle.map((stage, index) => {
							const isApproval = index === lifecycle.length - 1;
							const delay = `${120 + index * 180}ms`;

							return (
								<li key={stage.title} className="relative pl-12 md:pl-0">
									{!isApproval && (
										<>
											{/*
											 * Segment runs from this node centre to the next:
											 * 14px dot radius + the 32px md:gap-8 column gap.
											 */}
											<span
												aria-hidden="true"
												className={cn(
													"landing-trace-segment absolute top-[13px] left-7 hidden h-px md:block",
													index === 2
														? "bg-gradient-to-r from-brand/60 to-orange/70"
														: "bg-brand/60",
												)}
												style={
													{
														right: "-46px",
														"--segment-delay": delay,
													} as CSSProperties
												}
											/>
											<span
												aria-hidden="true"
												className={cn(
													"landing-trace-segment-v absolute top-7 -bottom-[54px] left-[13px] w-px md:hidden",
													index === 2
														? "bg-gradient-to-b from-brand/60 to-orange/70"
														: "bg-brand/60",
												)}
												style={
													{
														"--segment-delay": delay,
													} as CSSProperties
												}
											/>
										</>
									)}

									<span
										aria-hidden="true"
										className={cn(
											"absolute top-0 left-0 z-10 flex size-7 items-center justify-center rounded-full border bg-elevated md:static",
											isApproval ? "border-orange/60" : "border-line-strong",
										)}
									>
										<span
											className={cn(
												"size-2 rounded-full",
												isApproval ? "bg-orange" : "bg-brand",
											)}
										/>
									</span>

									<div className="pt-0.5 md:pt-7">
										<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
											<h3 className="text-[16px] font-medium leading-6 text-ink">
												{stage.title}
											</h3>
											<span className="font-mono text-[10px] leading-4 text-ink-muted">
												{stage.event}
											</span>
										</div>
										<p className="mt-2 max-w-[30ch] text-[14px] leading-6 text-ink-muted">
											{stage.copy}
										</p>
									</div>
								</li>
							);
						})}
					</ol>
				</div>
			</div>
		</section>
	);
}
