import GradientASCII from "@/components/GradientASCII";

/**
 * The supplied landing configuration from project/design.md §8, used exactly:
 * fixed to the viewport, behind every page that opts in.
 *
 * The same shader is used on the auth screens; those pages lay their own scrim
 * and solid card over it so the form stays readable.
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
		/>
	);
}

export function ShaderBackdrop() {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none fixed inset-0 -z-10 bg-canvas"
		>
			{/* Static fallback if WebGL2 is unavailable; the canvas covers it. */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_72%,rgba(2,151,222,0.22),transparent_70%)]" />
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_38%_28%_at_66%_78%,rgba(252,115,77,0.14),transparent_72%)]" />
			<ShaderField />
		</div>
	);
}
