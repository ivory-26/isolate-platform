import GradientASCII, {
	type GradientASCIIProps,
} from "@/components/GradientASCII";

/** Auth keeps the same horizon at much lower intensity. */
const AUTH: Partial<GradientASCIIProps> = {
	colors: ["#02070a", "#0297de", "#071016"],
	shape: "horizon",
	characters: " .·•●",
	cellSize: 20,
	density: 0.24,
	glyphOpacity: 0.33,
	gradientOpacity: 0.52,
	glow: 0.12,
	flicker: 0.08,
	softness: 0.62,
	flow: 0.2,
	fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
};

/**
 * The supplied landing configuration from project/design.md §8.
 *
 * The landing shader is the page background: fixed to the viewport, behind
 * every section, and non-interactive. Content that needs legibility paints its
 * own solid canvas surface above it.
 */
export function ShaderBackdrop({
	variant = "landing",
}: {
	variant?: "landing" | "auth";
}) {
	if (variant === "auth") {
		return (
			<div
				aria-hidden="true"
				className="pointer-events-none fixed inset-0 overflow-hidden bg-canvas"
			>
				<GradientASCII
					{...AUTH}
					className="h-full w-full"
					mouseInteraction={false}
					clickEffect="none"
					intro={false}
				/>
				<div className="absolute inset-0 bg-canvas/72" />
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,7,10,0.55)_65%,#02070A_100%)]" />
			</div>
		);
	}

	return (
		<div
			aria-hidden="true"
			style={{
				position: "fixed",
				inset: 0,
				zIndex: -1,
				pointerEvents: "none",
			}}
		>
			<GradientASCII
				colors={["#02070a", "#0297de", "#fc734d", "#b097f7"]}
				shape="horizon"
				characters=" .·•●"
				cellSize={12}
				density={0.4}
				glyphOpacity={0.63}
				gradientOpacity={0.91}
				glow={0.3}
				flicker={0.17}
				softness={0.43}
				flow={0.4}
				mouseInteraction={false}
				clickEffect="none"
			/>
		</div>
	);
}
