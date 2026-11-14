import { CornerTicks, DecorativeSchematic, Label } from "./schematic";

const HATCH_ID = "sandbox-write-scope-hatch";

/**
 * A1 - the sandbox boundary in plan view: event inlet, task boundary,
 * repository stack, write scope, diff gate and denied egress.
 */
export function SandboxBoundary() {
	return (
		<DecorativeSchematic viewBox="0 0 720 470" width={720} height={470}>
			<defs>
				<pattern
					id={HATCH_ID}
					width={10}
					height={10}
					patternUnits="userSpaceOnUse"
				>
					<line
						x1={0}
						y1={10}
						x2={10}
						y2={0}
						className="ill-muted"
						strokeWidth={1}
						strokeDasharray="1 4"
					/>
				</pattern>
			</defs>

			{/* event inlet */}
			<line
				x1={36}
				y1={260}
				x2={72}
				y2={260}
				className="ill-brand"
				strokeWidth={2}
			/>
			<rect
				x={72}
				y={248}
				width={24}
				height={24}
				className="ill-structure"
				strokeWidth={2}
			/>
			<Label x={48} y={220}>
				EVENT
			</Label>

			{/* ownership boundary */}
			<rect
				x={156}
				y={148}
				width={300}
				height={224}
				className="ill-structure"
				strokeWidth={1.5}
				strokeDasharray="4 4"
			/>
			<Label x={164} y={132}>
				TASK BOUNDARY
			</Label>

			{/* repository stack, checked-out branch on top */}
			{[
				{ y: 188, brand: true },
				{ y: 208, brand: false },
				{ y: 228, brand: false },
				{ y: 248, brand: false },
			].map((bar) => (
				<rect
					key={bar.y}
					x={180}
					y={bar.y}
					width={120}
					height={10}
					className={bar.brand ? "ill-brand" : "ill-muted"}
					strokeWidth={bar.brand ? 2 : 1}
				/>
			))}

			{/* task plate */}
			<rect
				x={180}
				y={296}
				width={120}
				height={64}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			{[312, 328, 344].map((y) => (
				<line
					key={y}
					x1={192}
					y1={y}
					x2={288}
					y2={y}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}
			<Label x={184} y={384}>
				TASK
			</Label>

			{/* write scope */}
			<rect x={330} y={276} width={96} height={96} fill={`url(#${HATCH_ID})`} />
			<rect
				x={330}
				y={276}
				width={96}
				height={96}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<Label x={330} y={258}>
				WRITE SCOPE
			</Label>

			{/* validation gate on the boundary edge */}
			<rect
				x={408}
				y={212}
				width={8}
				height={96}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<rect
				x={464}
				y={212}
				width={8}
				height={96}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<line
				x1={408}
				y1={212}
				x2={464}
				y2={212}
				className="ill-structure"
				strokeWidth={2.5}
			/>

			{/* denied egress */}
			<line
				x1={456}
				y1={190}
				x2={526}
				y2={190}
				className="ill-brand"
				strokeWidth={2}
			/>
			<rect
				x={530}
				y={172}
				width={10}
				height={36}
				className="ill-danger"
				strokeWidth={2}
			/>
			<line
				x1={540}
				y1={190}
				x2={568}
				y2={190}
				className="ill-muted"
				strokeWidth={1}
				strokeDasharray="2 3"
			/>
			<rect
				x={568}
				y={170}
				width={40}
				height={40}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<line
				x1={516}
				y1={148}
				x2={530}
				y2={172}
				className="ill-muted"
				strokeWidth={1}
			/>
			<circle cx={530} cy={172} r={1.5} className="ill-fill-muted" />
			<Label x={516} y={148} tone="danger">
				EGRESS DENIED
			</Label>

			{/* execution budget ruler */}
			<line
				x1={156}
				y1={404}
				x2={456}
				y2={404}
				className="ill-muted"
				strokeWidth={1}
			/>
			{Array.from({ length: 11 }, (_, index) => 156 + index * 30).map((x) => (
				<line
					key={x}
					x1={x}
					y1={398}
					x2={x}
					y2={410}
					className="ill-muted"
					strokeWidth={1}
					strokeDasharray="1 4"
				/>
			))}

			<CornerTicks width={720} height={470} />
		</DecorativeSchematic>
	);
}

/** A2 inset - the diff gate, the in-scope path and the outside-scope diversion. */
export function ValidationGate() {
	return (
		<DecorativeSchematic viewBox="0 0 360 240" width={360} height={240}>
			{/* diff sheet */}
			<rect
				x={40}
				y={56}
				width={96}
				height={120}
				className="ill-structure"
				strokeWidth={1.5}
			/>
			{[64, 48, 72, 40, 56, 68, 44].map((length, index) => (
				<line
					key={length}
					x1={52}
					y1={76 + index * 14}
					x2={52 + length}
					y2={76 + index * 14}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}

			{/* gate */}
			<line
				x1={188}
				y1={64}
				x2={188}
				y2={176}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<line
				x1={236}
				y1={64}
				x2={236}
				y2={176}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<line
				x1={188}
				y1={64}
				x2={236}
				y2={64}
				className="ill-structure"
				strokeWidth={2.5}
			/>

			{/* in-scope path */}
			<line
				x1={136}
				y1={116}
				x2={280}
				y2={116}
				className="ill-brand"
				strokeWidth={2}
			/>
			<rect
				x={280}
				y={106}
				width={20}
				height={20}
				className="ill-structure"
				strokeWidth={1.5}
			/>
			<path
				d="M284 116 L290 122 L298 110"
				className="ill-success"
				strokeWidth={2}
			/>
			<Label x={272} y={148} size="small">
				EXIT 0
			</Label>

			{/* outside-scope diversion */}
			<line
				x1={188}
				y1={128}
				x2={212}
				y2={52}
				className="ill-danger"
				strokeWidth={2}
			/>
			<rect
				x={205}
				y={38}
				width={14}
				height={14}
				className="ill-danger"
				strokeWidth={2}
			/>
			<path
				d="M208 41 L216 49 M216 41 L208 49"
				className="ill-danger"
				strokeWidth={1.5}
			/>
			<Label x={150} y={24} tone="danger" size="small">
				OUTSIDE SCOPE
			</Label>
		</DecorativeSchematic>
	);
}
