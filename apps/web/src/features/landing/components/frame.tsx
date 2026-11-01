import { cn } from "@/lib/utils";

/**
 * The page frame from the reference: two vertical hairlines at the content
 * edges, with filled square markers where they cross a section rule. Hidden on
 * mobile so the content keeps its full width.
 */
export function FrameDots({ bottom = false }: { bottom?: boolean }) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-x-0 z-20 mx-auto hidden w-full max-w-[1200px] md:block",
				bottom ? "bottom-0" : "top-0",
			)}
		>
			<span
				className={cn(
					"absolute left-0 size-1.5 -translate-x-1/2 bg-brand",
					bottom ? "translate-y-1/2" : "-translate-y-1/2",
				)}
			/>
			<span
				className={cn(
					"absolute right-0 size-1.5 translate-x-1/2 bg-brand",
					bottom ? "translate-y-1/2" : "-translate-y-1/2",
				)}
			/>
		</div>
	);
}

export function FrameLines() {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 left-1/2 z-10 hidden w-full max-w-[1200px] -translate-x-1/2 border-x border-line-subtle/60 md:block"
		/>
	);
}
