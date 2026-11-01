import { cn } from "@/lib/utils";
import { lifecycle } from "../content";
import {
	pageContainer,
	sectionLede,
	sectionPadding,
	sectionTitle,
} from "../styles";
import { FeatureVisual } from "./feature-visual";
import { FrameDots } from "./frame";
import { Reveal } from "./reveal";

export function LifecycleSection() {
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

				<Reveal className="mt-12 lg:mt-16">
					<FeatureVisual feature="lifecycle" />
				</Reveal>

				<ol className="mt-12 grid gap-10 border-t border-line-subtle pt-10 md:grid-cols-4 md:gap-8">
					{lifecycle.map((stage, index) => (
						<li key={stage.title}>
							<div className="flex items-baseline gap-3">
								<span className="font-mono text-[10px] leading-4 text-ink-muted">
									{String(index + 1).padStart(2, "0")}
								</span>
								<h3 className="text-[16px] font-medium leading-6 text-ink">
									{stage.title}
								</h3>
							</div>
							<p className="mt-1 font-mono text-[10px] leading-4 text-ink-muted">
								{stage.event}
							</p>
							<p className="mt-3 max-w-[30ch] text-[14px] leading-6 text-ink-secondary">
								{stage.copy}
							</p>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}
