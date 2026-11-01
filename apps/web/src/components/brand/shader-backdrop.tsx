import GradientASCII, {
	type GradientASCIIProps,
} from "@/components/GradientASCII";
import { cn } from "@/lib/utils";

/** The supplied landing configuration from project/design.md. */
const LANDING: Partial<GradientASCIIProps> = {
	colors: ["#02070a", "#0297de", "#fc734d", "#b097f7"],
	shape: "horizon",
	characters: " .·•●",
	cellSize: 12,
	density: 0.4,
	glyphOpacity: 0.63,
	gradientOpacity: 0.91,
	glow: 0.3,
	flicker: 0.17,
	softness: 0.43,
	flow: 0.4,
	fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
};

/** Auth uses the same world at much lower intensity. */
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

export function ShaderBackdrop({
	variant = "landing",
	className,
}: {
	variant?: "landing" | "auth";
	className?: string;
}) {
	const landing = variant === "landing";
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none overflow-hidden bg-canvas",
				landing ? "absolute inset-0" : "fixed inset-0",
				className,
			)}
		>
			<GradientASCII
				{...(landing ? LANDING : AUTH)}
				className="h-full w-full"
				mouseInteraction={false}
				clickEffect="none"
				intro={false}
			/>
			{landing ? (
				<>
					<div className="absolute inset-0 bg-canvas/10" />
					<div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-canvas to-transparent" />
				</>
			) : (
				<>
					<div className="absolute inset-0 bg-canvas/72" />
					<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,7,10,0.55)_65%,#02070A_100%)]" />
				</>
			)}
		</div>
	);
}
