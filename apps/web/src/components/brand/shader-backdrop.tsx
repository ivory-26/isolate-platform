import GradientASCII from "@/components/GradientASCII";

/**
 * The supplied landing configuration from project/design.md §8, used exactly.
 *
 * One field, reused by the landing backdrop and by the auth brand panel.
 * `mouseInteraction` and `clickEffect` are off because the component listens on
 * `window`; they do not change the rendered horizon.
 */
export function ShaderField() {
	return (
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
	);
}

/**
 * The landing background: fixed to the viewport, behind every section, and
 * non-interactive. Sections that need legibility paint their own solid canvas.
 */
export function ShaderBackdrop() {
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
			{/* Static fallback if WebGL2 is unavailable; the canvas covers it. */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_72%,rgba(2,151,222,0.22),transparent_70%)]" />
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_38%_28%_at_66%_78%,rgba(252,115,77,0.14),transparent_72%)]" />
			<ShaderField />
		</div>
	);
}
