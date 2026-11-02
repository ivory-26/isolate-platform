type Feature = {
	src: string;
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
		width: 720,
		height: 470,
	},
	approval: {
		src: "/iso/approval.svg",
		width: 720,
		height: 470,
	},
	record: {
		src: "/iso/record.svg",
		width: 720,
		height: 470,
	},
	lifecycle: {
		src: "/iso/lifecycle.svg",
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
				alt=""
				width={config.width}
				height={config.height}
				loading="lazy"
				decoding="async"
			/>
		</figure>
	);
}
