import { cn } from "@/lib/utils";

const ALT = {
	hero: "Isometric workflow machine: a task block travels from the input carriage through a sandbox chamber, validation arch, approval turnstile and onto the branch tray.",
	sandbox:
		"Close-up of the sandbox chamber, where the agent arm works on the task inside a glass enclosure.",
	approval:
		"Close-up of the approval turnstile, the orange gate that pauses the task before the branch tray.",
	ledger:
		"Close-up of the ledger strip and print head that record every run event.",
} as const;

const POSITION = {
	hero: "",
	sandbox: "wf-focus-sandbox",
	approval: "wf-focus-approval",
	ledger: "wf-focus-ledger",
} as const;

export type WorkflowFocus = keyof typeof ALT;

/**
 * The isometric workflow machine, shipped as a standalone animated SVG so it
 * carries its own brand palette and motion without any inline HTML injection.
 * The feature rows use the same drawing with a fixed-ratio crop per station.
 */
export function WorkflowVisual({
	focus = "hero",
	className,
}: {
	focus?: WorkflowFocus;
	className?: string;
}) {
	const crop = focus !== "hero";
	return (
		<div
			className={cn("wf-frame", crop && "wf-frame-crop", className)}
			data-focus={focus}
		>
			<img
				src="/iso/workflow-machine.svg"
				alt={ALT[focus]}
				width={1080}
				height={660}
				loading={focus === "hero" ? "eager" : "lazy"}
				decoding="async"
				className={cn(crop && POSITION[focus])}
			/>
		</div>
	);
}
