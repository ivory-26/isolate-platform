import { type CSSProperties, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CornerTicks } from "./illustrations/schematic";
import { useInView } from "./reveal";

const STATIONS = [
	{ x: 90, lead: "task.", tail: "submitted", stage: "QUEUE" },
	{ x: 250, lead: "sandbox.", tail: "provisioned", stage: "EXECUTE" },
	{ x: 410, lead: "validation.", tail: "finished", stage: "VALIDATE" },
	{ x: 570, lead: "approval.", tail: "requested", stage: "APPROVE" },
	{ x: 730, lead: "approval.", tail: "decided", stage: "APPROVE" },
	{ x: 890, lead: "pull", tail: "request", stage: "OUTCOME" },
] as const;

type Segment = {
	x1: number;
	x2: number;
	blue: boolean;
	delay: number;
	gap?: boolean;
};

const SEGMENTS: readonly Segment[] = [
	{ x1: 90, x2: 250, blue: true, delay: 660 },
	{ x1: 250, x2: 410, blue: true, delay: 720 },
	{ x1: 410, x2: 570, blue: true, delay: 780 },
	{ x1: 570, x2: 706, blue: true, delay: 840 },
	{ x1: 706, x2: 714, blue: false, delay: 900, gap: true },
	{ x1: 746, x2: 754, blue: false, delay: 900, gap: true },
	{ x1: 754, x2: 890, blue: false, delay: 960 },
] as const;

function StationNode({ index, x }: { index: number; x: number }) {
	const delay = { "--station-delay": `${index * 110}ms` } as CSSProperties;
	const className = "rail-station";

	if (index === 3) {
		return (
			<g style={delay}>
				<rect
					x={x - 8}
					y={272}
					width={16}
					height={16}
					className={cn(className, "ill-structure")}
					strokeWidth={2}
				/>
				<circle
					cx={x}
					cy={280}
					r={14}
					className={cn(className, "ill-orange")}
					strokeWidth={1.5}
				/>
			</g>
		);
	}

	if (index === 4) {
		return (
			<circle
				cx={x}
				cy={280}
				r={14}
				className={cn(className, "ill-orange")}
				strokeWidth={2}
				style={delay}
			/>
		);
	}

	if (index === 5) {
		return (
			<g style={delay}>
				<rect
					x={x - 16}
					y={264}
					width={32}
					height={32}
					className={cn(className, "ill-structure")}
					strokeWidth={2}
				/>
				<rect
					x={x - 12}
					y={268}
					width={24}
					height={24}
					className={cn(className, "ill-structure")}
					strokeWidth={1.5}
				/>
			</g>
		);
	}

	return (
		<rect
			x={x - 8}
			y={272}
			width={16}
			height={16}
			className={cn(className, "ill-structure")}
			strokeWidth={2}
			style={delay}
		/>
	);
}

/**
 * A6 - the whole lifecycle on one rail. The static markup is the final frame;
 * the one-shot reveal is armed only after hydration, on first intersection and
 * only when the reader allows motion.
 */
export function LifecycleRail() {
	const { ref, inView } = useInView<HTMLDivElement>();
	const [motionAllowed, setMotionAllowed] = useState(false);

	useEffect(() => {
		setMotionAllowed(
			window.matchMedia("(prefers-reduced-motion: no-preference)").matches,
		);
	}, []);

	const armed = inView && motionAllowed;

	return (
		<figure className="wf-figure wf-figure-wide">
			<figcaption className="sr-only">
				A task is submitted, a sandbox is provisioned, validation finishes, a
				person approves the exact payload, and a pull request is opened. The
				rail pauses between the approval request and the decision.
			</figcaption>
			<div ref={ref} className={cn("lifecycle-rail", armed && "is-armed")}>
				<svg
					viewBox="0 0 1000 560"
					width={1000}
					height={560}
					className="schematic"
					role="img"
					aria-labelledby="lifecycle-rail-title lifecycle-rail-desc"
					fill="none"
					strokeLinecap="square"
					strokeLinejoin="miter"
				>
					<title id="lifecycle-rail-title">Lifecycle of one task</title>
					<desc id="lifecycle-rail-desc">
						A task is submitted, a sandbox is provisioned, validation finishes,
						a person approves the exact payload, and a pull request is opened.
						The rail pauses between the approval request and the decision.
					</desc>

					{/* time ruler and human-decision bracket */}
					<line
						x1={90}
						y1={160}
						x2={890}
						y2={160}
						className="ill-line"
						strokeWidth={1}
					/>
					{Array.from({ length: 21 }, (_, index) => 90 + index * 40).map(
						(x) => (
							<line
								key={x}
								x1={x}
								y1={154}
								x2={x}
								y2={166}
								className="ill-line"
								strokeWidth={1}
								strokeDasharray="1 4"
							/>
						),
					)}
					<path
						d="M546 196 V176 H754 V196"
						className="ill-orange"
						strokeWidth={2}
					/>
					<text x={560} y={152} className="ill-label ill-label-orange">
						HUMAN DECISION
					</text>

					{/* rail segments */}
					{SEGMENTS.map((segment) => {
						const length = segment.x2 - segment.x1;
						return (
							<line
								key={segment.x1}
								x1={segment.x1}
								y1={280}
								x2={segment.x2}
								y2={280}
								className={cn(
									"rail-segment",
									segment.gap && "rail-gap",
									segment.blue
										? "ill-brand"
										: segment.gap
											? "ill-muted"
											: "ill-structure",
								)}
								strokeWidth={segment.blue ? 2 : segment.gap ? 2 : 1.5}
								strokeDasharray={segment.gap ? "4 4" : undefined}
								style={
									{
										"--seg-len": length,
										"--seg-delay": `${segment.delay}ms`,
									} as CSSProperties
								}
							/>
						);
					})}

					{/* pause annotation */}
					<text
						x={702}
						y={246}
						className="ill-label ill-label-orange ill-label-small"
					>
						PAUSE
					</text>

					{/*
					 * Stations: event names break over two lines at the dot so the
					 * specified 20px type clears the 160-unit station pitch.
					 */}
					{STATIONS.map((station, index) => (
						<g key={`${station.lead}${station.tail}`}>
							<StationNode index={index} x={station.x} />
							<line
								x1={station.x}
								y1={296}
								x2={station.x}
								y2={318}
								className="ill-line"
								strokeWidth={1}
							/>
							<text
								x={station.x}
								y={332}
								textAnchor="middle"
								className="ill-rail-event"
							>
								{station.lead}
							</text>
							<text
								x={station.x}
								y={356}
								textAnchor="middle"
								className="ill-rail-event"
							>
								{station.tail}
							</text>
							<text
								x={station.x}
								y={386}
								textAnchor="middle"
								className="ill-label ill-label-muted ill-label-small"
							>
								{station.stage}
							</text>
						</g>
					))}

					<CornerTicks width={1000} height={560} />
				</svg>
			</div>
		</figure>
	);
}
