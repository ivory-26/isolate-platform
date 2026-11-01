type Label = { text: string; accent?: boolean };

const FEATURES: Record<
	"sandbox" | "approval" | "record",
	{ src: string; alt: string; labels: readonly Label[] }
> = {
	sandbox: {
		src: "/iso/sandbox.svg",
		alt: "Hairline isometric diagram of a sandbox: a plate holds a stack of cloned repository layers and a task block raised on a column, with a dashed line around the files the run may write. A network wire leaves the task, crosses that line and is cut with a double bar at the plate edge. A budget dial and a tick ruler sit at the front.",
		labels: [
			{ text: "clone" },
			{ text: "ownership" },
			{ text: "network · denied", accent: true },
			{ text: "budget" },
		],
	},
	approval: {
		src: "/iso/approval.svg",
		alt: "Hairline isometric diagram of an approval gate: a plinth carries a payload sheet marked with three commit hash dots. A stamp hangs from a slim column and arm above the sheet, and two round buttons set into the plinth read approve and reject.",
		labels: [
			{ text: "payload" },
			{ text: "commit sha" },
			{ text: "approve" },
			{ text: "reject", accent: true },
		],
	},
	record: {
		src: "/iso/record.svg",
		alt: "Hairline isometric diagram of a run record: five event tiles sit on a plinth, the fourth lifted above the row on a dashed drop line. A tick ruler along the front edge reads elapsed time, and an archive drawer at the left holds the durable copy.",
		labels: [
			{ text: "event" },
			{ text: "stage" },
			{ text: "timestamp" },
			{ text: "durable" },
		],
	},
};

export type FeatureKey = keyof typeof FEATURES;

export function FeatureVisual({ feature }: { feature: FeatureKey }) {
	const config = FEATURES[feature];
	return (
		<figure className="wf-figure">
			<img
				src={config.src}
				alt={config.alt}
				width={720}
				height={470}
				loading="lazy"
				decoding="async"
			/>
			<ul className="wf-labels">
				{config.labels.map((label) => (
					<li key={label.text} data-accent={label.accent ? "" : undefined}>
						{label.text}
					</li>
				))}
			</ul>
		</figure>
	);
}
