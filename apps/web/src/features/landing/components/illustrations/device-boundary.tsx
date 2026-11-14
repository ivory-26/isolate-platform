import { DecorativeSchematic, Label } from "./schematic";

/**
 * A7 - the credential boundary in plan view: the keychain and device daemon
 * stay inside the device; only a device token crosses to the control plane.
 */
export function DeviceBoundary() {
	return (
		<DecorativeSchematic viewBox="0 0 960 540" width={960} height={540}>
			{/* device enclosure */}
			<rect
				x={48}
				y={92}
				width={400}
				height={360}
				className="ill-structure"
				strokeWidth={1.5}
				strokeDasharray="4 4"
			/>
			<Label x={64} y={72}>
				YOUR DEVICE
			</Label>

			{/* vendor keychain */}
			<rect
				x={88}
				y={148}
				width={140}
				height={88}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<circle cx={120} cy={184} r={10} className="ill-orange" strokeWidth={2} />
			<line
				x1={130}
				y1={184}
				x2={168}
				y2={184}
				className="ill-orange"
				strokeWidth={2}
			/>
			<line
				x1={150}
				y1={184}
				x2={150}
				y2={192}
				className="ill-orange"
				strokeWidth={2}
			/>
			<line
				x1={160}
				y1={184}
				x2={160}
				y2={192}
				className="ill-orange"
				strokeWidth={2}
			/>

			{/* device daemon */}
			<rect
				x={88}
				y={300}
				width={168}
				height={96}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			{[324, 348, 372].map((y) => (
				<line
					key={y}
					x1={100}
					y1={y}
					x2={244}
					y2={y}
					className="ill-muted"
					strokeWidth={1}
				/>
			))}

			{/* key path stays inside the device */}
			<path d="M228 192 H196 V300" className="ill-orange" strokeWidth={2} />
			<line
				x1={424}
				y1={180}
				x2={424}
				y2={260}
				className="ill-orange"
				strokeWidth={2}
			/>
			<Label x={220} y={236} tone="orange">
				KEY NEVER LEAVES
			</Label>

			{/* device token crosses the boundary */}
			<line
				x1={256}
				y1={348}
				x2={600}
				y2={348}
				className="ill-brand"
				strokeWidth={2}
			/>
			<rect
				x={442}
				y={342}
				width={12}
				height={12}
				className="ill-brand"
				strokeWidth={1.5}
			/>
			<Label x={470} y={326} tone="brand">
				TOKEN
			</Label>

			{/* control plane */}
			<rect
				x={600}
				y={148}
				width={280}
				height={200}
				className="ill-structure"
				strokeWidth={1.5}
			/>
			<Label x={600} y={128}>
				CONTROL PLANE
			</Label>
			{[
				{ y: 282, text: "token_hash" },
				{ y: 308, text: "connector_id" },
				{ y: 334, text: "scopes" },
			].map((row) => (
				<Label key={row.text} x={624} y={row.y} size="small" tone="muted">
					{row.text}
				</Label>
			))}

			{/* vendor API call, outside the device boundary */}
			<path d="M256 372 H300 V420 H600" className="ill-brand" strokeWidth={2} />
			<rect
				x={600}
				y={420}
				width={160}
				height={64}
				className="ill-muted"
				strokeWidth={1.5}
			/>
		</DecorativeSchematic>
	);
}

/** A8 inset - one typed connector call while the key stays inside. */
export function ConnectorCall() {
	return (
		<DecorativeSchematic viewBox="0 0 360 240" width={360} height={240}>
			{/* device boundary */}
			<rect
				x={24}
				y={40}
				width={176}
				height={168}
				className="ill-structure"
				strokeWidth={1.5}
				strokeDasharray="4 4"
			/>

			{/* daemon */}
			<rect
				x={72}
				y={80}
				width={88}
				height={56}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<Label x={80} y={68} size="tiny" tone="muted">
				DAEMON
			</Label>

			{/* key and its short stub */}
			<circle cx={93} cy={100} r={5} className="ill-orange" strokeWidth={2} />
			<line
				x1={98}
				y1={100}
				x2={130}
				y2={100}
				className="ill-orange"
				strokeWidth={2}
			/>
			<line
				x1={116}
				y1={100}
				x2={116}
				y2={106}
				className="ill-orange"
				strokeWidth={2}
			/>
			<line
				x1={130}
				y1={100}
				x2={192}
				y2={100}
				className="ill-orange"
				strokeWidth={2}
			/>
			<Label x={88} y={124} size="tiny" tone="orange">
				KEY
			</Label>

			{/* typed call */}
			<line
				x1={272}
				y1={124}
				x2={160}
				y2={124}
				className="ill-brand"
				strokeWidth={2}
				strokeDasharray="4 4"
			/>
			<rect
				x={194}
				y={118}
				width={12}
				height={12}
				className="ill-brand"
				strokeWidth={1.5}
			/>

			{/* control plane */}
			<rect
				x={272}
				y={88}
				width={64}
				height={40}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<Label x={344} y={76} size="tiny" tone="muted" anchor="end">
				CONTROL PLANE
			</Label>

			{/* vendor call */}
			<path d="M116 136 V184 H272" className="ill-brand" strokeWidth={2} />
			<rect
				x={272}
				y={166}
				width={60}
				height={36}
				className="ill-muted"
				strokeWidth={1.5}
			/>
			<Label x={284} y={180} size="tiny" tone="muted">
				VENDOR
			</Label>
		</DecorativeSchematic>
	);
}
