type Feature = {
	src: string;
	alt: string;
	width: number;
	height: number;
	wide?: boolean;
};

const FEATURES: Record<
	"sandbox" | "approval" | "record" | "lifecycle",
	Feature
> = {
	sandbox: {
		src: "/iso/sandbox.svg",
		alt: "A cloned repository stack and a sealed task block inside a dashed write boundary. A network wire is cut at the plate edge.",
		width: 720,
		height: 470,
	},
	approval: {
		src: "/iso/approval.svg",
		alt: "A payload sheet marked with three commit hash dots, with a stamp held above it and approve and reject buttons set into the plate.",
		width: 720,
		height: 470,
	},
	record: {
		src: "/iso/record.svg",
		alt: "Five event tiles on a plinth, one lifted above the row, with a time ruler and an archive drawer holding the durable copy.",
		width: 720,
		height: 470,
	},
	lifecycle: {
		src: "/iso/lifecycle.svg",
		alt: "Four stations on one rail: a stack of queued tasks, a task sealed in a sandbox, a validation gate, and a stamp that approves the change.",
		width: 1000,
		height: 560,
		wide: true,
	},
};

export type FeatureKey = keyof typeof FEATURES;

export function FeatureVisual({ feature }: { feature: FeatureKey }) {
	const config = FEATURES[feature];
	return (
		<figure className={config.wide ? "wf-figure wf-figure-wide" : "wf-figure"}>
			<img
				src={config.src}
				alt={config.alt}
				width={config.width}
				height={config.height}
				loading="lazy"
				decoding="async"
			/>
		</figure>
	);
}
