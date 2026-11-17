import { CornerTicks, DecorativeSchematic, Label } from "./schematic";

const ROWS = [
	{ y: 88, event: "task.submitted", offset: "+0.0s" },
	{ y: 156, event: "sandbox.provisioned", offset: "+1.2s" },
	{ y: 224, event: "validation.finished", offset: "+42.6s" },
	{ y: 292, event: "approval.requested", offset: "+43.1s" },
	{ y: 360, event: "approval.decided", offset: "+2m 14s" },
] as const;

const PAUSED_ROW_Y = 292;
const DECIDED_ROW_Y = 360;

/**
 * A5 - a vertical audit rail: five exact events on a spine, a hash chain and
 * the lifted approval row the reviewer acts on.
 */
export function AuditRecord() {
	return (
		<DecorativeSchematic viewBox="0 0 720 470" width={720} height={470}>
			{/* time ruler */}
			<line
				x1={100}
				y1={44}
				x2={668}
				y2={44}
				className="ill-line"
				strokeWidth={1}
			/>
			{Array.from({ length: 12 }, (_, index) => 100 + index * 48).map((x) => (
				<line
					key={x}
					x1={x}
					y1={38}
					x2={x}
					y2={50}
					className="ill-line"
					strokeWidth={1}
					strokeDasharray="1 4"
				/>
			))}

			{/* lifted approval row */}
			<rect
				x={88}
				y={274}
				width={588}
				height={36}
				className="ill-fill-elevated ill-line"
				strokeWidth={1.5}
			/>

			{/* spine: active until the pause, neutral after */}
			<line
				x1={72}
				y1={48}
				x2={72}
				y2={258}
				className="ill-brand"
				strokeWidth={2}
			/>
			<line
				x1={72}
				y1={258}
				x2={72}
				y2={424}
				className="ill-muted"
				strokeWidth={2}
			/>

			{/* hash chain */}
			{ROWS.map((row) => (
				<g key={row.event}>
					<rect
						x={560}
						y={row.y - 6}
						width={12}
						height={12}
						className="ill-muted"
						strokeWidth={1}
					/>
					<line
						x1={566}
						y1={row.y - 6}
						x2={566}
						y2={row.y + 6}
						className="ill-muted"
						strokeWidth={1}
					/>
					<line
						x1={560}
						y1={row.y}
						x2={572}
						y2={row.y}
						className="ill-muted"
						strokeWidth={1}
					/>
					<line
						x1={430}
						y1={row.y}
						x2={560}
						y2={row.y}
						className="ill-muted"
						strokeWidth={1}
					/>
				</g>
			))}
			{[94, 162, 230, 298].map((y) => (
				<line
					key={y}
					x1={566}
					y1={y}
					x2={566}
					y2={y + 56}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}

			{/* event rows */}
			{ROWS.map((row) => {
				const lifted = row.y === PAUSED_ROW_Y;
				const decided = row.y === DECIDED_ROW_Y;
				return (
					<g key={row.event}>
						{decided ? (
							<circle
								cx={72}
								cy={row.y}
								r={7}
								className="ill-orange"
								strokeWidth={2}
							/>
						) : (
							<>
								<rect
									x={67}
									y={row.y - 5}
									width={10}
									height={10}
									className="ill-muted"
									strokeWidth={2}
								/>
								{lifted ? (
									<circle
										cx={72}
										cy={row.y}
										r={10}
										className="ill-orange"
										strokeWidth={1.5}
									/>
								) : null}
							</>
						)}
						<text
							x={lifted ? 112 : 100}
							y={row.y}
							dominantBaseline="middle"
							className="ill-event"
						>
							{row.event}
						</text>
						<Label x={660} y={row.y} size="small" tone="muted" anchor="end">
							{row.offset}
						</Label>
					</g>
				);
			})}

			<CornerTicks width={720} height={470} />
		</DecorativeSchematic>
	);
}
