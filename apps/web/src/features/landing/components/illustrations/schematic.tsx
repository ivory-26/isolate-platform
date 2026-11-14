import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type LabelTone =
	| "structure"
	| "muted"
	| "brand"
	| "orange"
	| "danger"
	| "success";

type LabelSize = "base" | "small" | "tiny";

const TONE_CLASS: Record<LabelTone, string> = {
	structure: "ill-label-structure",
	muted: "ill-label-muted",
	brand: "ill-label-brand",
	orange: "ill-label-orange",
	danger: "ill-label-danger",
	success: "ill-label-success",
};

const SIZE_CLASS: Record<LabelSize, string> = {
	base: "",
	small: "ill-label-small",
	tiny: "ill-label-tiny",
};

/** Shared shell for the decorative landing schematics (A1-A5, A7, A8). */
export function DecorativeSchematic({
	viewBox,
	width,
	height,
	className,
	children,
}: {
	viewBox: string;
	width: number;
	height: number;
	className?: string;
	children: ReactNode;
}) {
	return (
		<svg
			viewBox={viewBox}
			width={width}
			height={height}
			className={cn("schematic", className)}
			aria-hidden="true"
			focusable="false"
			fill="none"
			strokeLinecap="square"
			strokeLinejoin="miter"
		>
			{children}
		</svg>
	);
}

/** Monospace annotation from the schematic label system. */
export function Label({
	x,
	y,
	tone = "structure",
	size = "base",
	anchor = "start",
	children,
}: {
	x: number;
	y: number;
	tone?: LabelTone;
	size?: LabelSize;
	anchor?: "start" | "middle" | "end";
	children: ReactNode;
}) {
	return (
		<text
			x={x}
			y={y}
			textAnchor={anchor}
			className={cn("ill-label", TONE_CLASS[tone], SIZE_CLASS[size])}
		>
			{children}
		</text>
	);
}

/** Four L-shaped registration ticks at the viewBox corners. */
export function CornerTicks({
	width,
	height,
	inset = 8,
	length = 12,
}: {
	width: number;
	height: number;
	inset?: number;
	length?: number;
}) {
	const far = inset + length;
	return (
		<g className="ill-line" strokeWidth={1}>
			<path d={`M${inset} ${far} V${inset} H${far}`} />
			<path d={`M${width - far} ${inset} H${width - inset} V${far}`} />
			<path d={`M${inset} ${height - far} V${height - inset} H${far}`} />
			<path
				d={`M${width - far} ${height - inset} H${width - inset} V${height - far}`}
			/>
		</g>
	);
}
