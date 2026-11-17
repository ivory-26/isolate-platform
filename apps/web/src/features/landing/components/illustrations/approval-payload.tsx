import { DecorativeSchematic, Label } from "./schematic";

/**
 * A3 - payload-bound approval in elevation view: the payload envelope, its
 * hash, the human latch, the reviewer and the decision fork.
 */
export function ApprovalPayload() {
	return (
		<DecorativeSchematic viewBox="0 0 720 470" width={720} height={470}>
			{/* payload envelope */}
			<rect
				x={56}
				y={148}
				width={240}
				height={168}
				className="ill-structure"
				strokeWidth={1.5}
			/>
			<path
				d="M56 148 L176 232 L296 148"
				className="ill-structure"
				strokeWidth={1.5}
			/>

			{/* payload hash strip */}
			{Array.from({ length: 8 }, (_, index) => 72 + index * 20).map((x) => (
				<rect
					key={x}
					x={x}
					y={292}
					width={12}
					height={12}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}
			<Label x={72} y={332}>
				PAYLOAD 9f3c…
			</Label>

			{/* orange latch and bracket */}
			<rect
				x={296}
				y={232}
				width={28}
				height={12}
				className="ill-orange"
				strokeWidth={2}
			/>
			<path
				d="M296 208 H304 V264 H296"
				className="ill-orange"
				strokeWidth={2}
			/>

			{/* reviewer */}
			<circle cx={452} cy={128} r={24} className="ill-orange" strokeWidth={2} />
			<circle cx={452} cy={128} r={3} className="ill-fill-orange" />
			<Label x={428} y={88} tone="orange">
				REVIEWER
			</Label>

			{/* decision fork */}
			<line
				x1={536}
				y1={216}
				x2={620}
				y2={168}
				className="ill-brand"
				strokeWidth={2}
			/>
			<rect
				x={612}
				y={160}
				width={16}
				height={16}
				className="ill-brand"
				strokeWidth={2}
			/>
			<Label x={596} y={148} tone="brand">
				APPROVED
			</Label>

			<line
				x1={536}
				y1={240}
				x2={620}
				y2={320}
				className="ill-danger"
				strokeWidth={2}
			/>
			<rect
				x={612}
				y={312}
				width={16}
				height={16}
				className="ill-danger"
				strokeWidth={2}
			/>
			<path
				d="M615 315 L625 325 M625 315 L615 325"
				className="ill-danger"
				strokeWidth={1.5}
			/>

			{/* no-replay cut */}
			<path
				d="M296 316 Q348 300 296 284"
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<line
				x1={314}
				y1={318}
				x2={330}
				y2={298}
				className="ill-danger"
				strokeWidth={2}
			/>
			<Label x={300} y={356} tone="danger">
				NO REPLAY
			</Label>
		</DecorativeSchematic>
	);
}

/** A4 inset - the approved branch becomes a pull request. */
export function PrHandoff() {
	return (
		<DecorativeSchematic viewBox="0 0 360 240" width={360} height={240}>
			{/* trunk */}
			<line
				x1={56}
				y1={24}
				x2={56}
				y2={216}
				className="ill-muted"
				strokeWidth={2}
			/>

			{/* merge line, drawn behind the PR body */}
			<line
				x1={248}
				y1={104}
				x2={56}
				y2={104}
				className="ill-muted"
				strokeWidth={1.5}
				strokeDasharray="4 4"
			/>

			{/* approved branch */}
			<path
				d="M56 152 C84 152 104 104 128 104 L136 104"
				className="ill-brand"
				strokeWidth={2}
			/>

			{/* pull request body */}
			<rect
				x={136}
				y={68}
				width={112}
				height={72}
				className="ill-structure"
				strokeWidth={1.5}
			/>
			{[
				{ y: 92, width: 80 },
				{ y: 108, width: 64 },
				{ y: 124, width: 72 },
			].map((rule) => (
				<line
					key={rule.y}
					x1={148}
					y1={rule.y}
					x2={148 + rule.width}
					y2={rule.y}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}

			{/* approval stamp */}
			<rect
				x={272}
				y={40}
				width={22}
				height={22}
				className="ill-orange"
				strokeWidth={2}
			/>
			<line
				x1={276}
				y1={44}
				x2={290}
				y2={58}
				className="ill-orange"
				strokeWidth={1}
			/>
			<Label x={258} y={20} tone="orange" size="small">
				APPROVED
			</Label>

			{/* payload hash */}
			<rect
				x={136}
				y={168}
				width={16}
				height={16}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<rect
				x={141}
				y={173}
				width={6}
				height={6}
				className="ill-muted"
				strokeWidth={1}
			/>
			<Label x={160} y={182} tone="muted" size="small">
				9f3c
			</Label>
		</DecorativeSchematic>
	);
}
