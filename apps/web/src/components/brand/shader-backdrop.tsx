import GradientASCII from "@/components/GradientASCII";

/**
 * The supplied landing configuration from project/design.md §8, used exactly:
 * fixed to the viewport, behind every landing element.
 *
 * Auth reuses the same world at lower intensity so the form stays readable.
 */
export function ShaderBackdrop({
	variant = "landing",
}: {
	variant?: "landing" | "auth";
}) {
	const landing = variant === "landing";
	return (
		<div
			aria-hidden="true"
			className={
				landing
					? "pointer-events-none fixed inset-0 -z-10 bg-canvas"
					: "pointer-events-none fixed inset-0 -z-10 bg-canvas opacity-40"
			}
		>
			{/* Static fallback if WebGL2 is unavailable; the canvas covers it. */}
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_72%,rgba(2,151,222,0.22),transparent_70%)]" />
			<div className="absolute inset-0 bg-[radial-gradient(ellipse_38%_28%_at_66%_78%,rgba(252,115,77,0.14),transparent_72%)]" />
			{landing ? (
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
			) : (
				<GradientASCII
					colors={["#02070a", "#0297de", "#071016"]}
					shape="horizon"
					characters=" .·•●"
					cellSize={20}
					density={0.24}
					glyphOpacity={0.33}
					gradientOpacity={0.52}
					glow={0.12}
					flicker={0.08}
					softness={0.62}
					flow={0.2}
					mouseInteraction={false}
					clickEffect="none"
					intro={false}
				/>
			)}
		</div>
	);
}
