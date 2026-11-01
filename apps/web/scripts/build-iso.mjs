import { mkdirSync, writeFileSync } from "node:fs";
import * as k from "./iso/iso-kit.mjs";

/**
 * Build the isometric workflow machine used by the landing.
 *
 * The object is the explanation: one task block travels from the input
 * carriage, through the sandbox chamber, the validation arch and the approval
 * turnstile, and onto the branch tray. A ledger strip records each step.
 * Colours come from the product tokens at render time.
 *
 * Run: bun apps/web/scripts/build-iso.mjs
 */

const WIDTH = 1080;
const HEIGHT = 660;
const TEAL = "#0297de";
const ORANGE = "#fc734d";

const PLATE = { x: -280, y: -170, w: 560, d: 340, r: 18 };
const PLATE_H = 16;
const FOOT_H = 7;
const DECK = { x: -250, y: -132, w: 500, d: 252, r: 12 };
const DECK_H = 8;

const RAIL_Y = [-70, 40];
const RAIL_X = [-230, 230];
const RAIL_Z = DECK_H;
const RAIL_H = 4;

const CONTROL = { x: -70, y: -162, w: 170, d: 38, r: 5 };
const CONTROL_H = 54;

const SANDBOX = { x0: -150, x1: -40, y0: -92, y1: 72 };
const SANDBOX_TOP = 150;

const VALIDATE_X = 40;
const VALIDATE_Y = [-92, 72];
const VALIDATE_TOP = 166;

const GATE = [140, 0];
const GATE_TOP = 152;

const TRAY = { x: 190, y: -58, w: 62, d: 116, r: 6 };
const PR_CARD = { x: 204, y: -34, w: 34, d: 58, r: 2 };

const TASK_X = -196;
const TASK_Y = -14;
const TASK_Z = 20;
const TASK_W = 40;
const TASK_D = 38;
const TASK_H = 26;

const STATIONS = [-95, VALIDATE_X, GATE[0], 218];

const P = k.fitProjection(
	[
		...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
		[-150, -92, SANDBOX_TOP + 4],
		[VALIDATE_X, -92, VALIDATE_TOP + 4],
		[GATE[0], 0, GATE_TOP + 10],
		[TRAY.x + TRAY.w, TRAY.y + TRAY.d, 30],
	],
	WIDTH,
	HEIGHT,
	{ pad: 42, azimuth: 45, elevation: 30 },
);

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const at = (point) => k.iso(point, P);
const screenDelta = (dx) => {
	const a = k.iso([dx, 0, 0], P);
	const b = k.iso([0, 0, 0], P);
	return [a[0] - b[0], a[1] - b[1]];
};
const px = (value) => `${value.toFixed(2)}px`;

function base() {
	const out = [
		`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`,
	];
	for (const [x, y] of k.corners(PLATE, 26)) {
		out.push(S(k.cylinder(x, y, 9, -PLATE_H - FOOT_H, 2, P, 28), { tone: "lo" }));
		out.push(
			S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H + 2, FOOT_H - 2, P, 28), {
				tone: "mid",
			}),
		);
	}
	out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 10, 1.8), { tone: "lo" }));
	out.push(L(k.planOutline(k.insetPlan(PLATE, 6), 0, P, 10), { tone: "faint" }));
	const screws = k.corners(PLATE, 12);
	out.push(
		L(
			screws.map(([x, y]) => k.ring(x, y, 2.6, 0.2, P, 18)).join(""),
			{ tone: "lo" },
		),
	);
	out.push(D(screws.map(([x, y]) => at([x, y, 0.2])), { size: 0.5 }));

	const strip = { x: -250, y: PLATE.y + PLATE.d - 20, w: 500, d: 8, r: 1 };
	out.push(S(k.slabOf(strip, 0, 0.7, P, 3), { tone: "lo", crease: "none" }));
	const ticks = k.topTicks(
		strip.x + 6,
		strip.x + strip.w - 6,
		5,
		5,
		strip.y + 1,
		0.7,
		[2, 3.8],
		P,
	);
	out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));

	out.push(S(k.slabOf(DECK, 0, DECK_H, P, 10, 1.4), { tone: "mid" }));
	out.push(
		L(k.planOutline(k.insetPlan(DECK, 5), DECK_H, P, 10), { tone: "faint" }),
	);
	return out.join("");
}

function rails() {
	const out = [];
	for (const y of RAIL_Y) {
		out.push(
			S(
				k.slabOf(
					{ x: RAIL_X[0], y, w: RAIL_X[1] - RAIL_X[0], d: 6, r: 1 },
					RAIL_Z,
					RAIL_H,
					P,
					3,
					0.5,
				),
				{ tone: "mid" },
			),
		);
		out.push(
			D(
				[RAIL_X[0] + 8, RAIL_X[1] - 8].map((x) =>
					at([x, y + 3, RAIL_Z + RAIL_H]),
				),
				{ size: 0.4 },
			),
		);
	}
	for (const x of [RAIL_X[0] - 6, RAIL_X[1]]) {
		out.push(
			S(
				k.slabOf(
					{ x, y: RAIL_Y[0] - 4, w: 6, d: RAIL_Y[1] - RAIL_Y[0] + 14, r: 1.4 },
					RAIL_Z,
					RAIL_H + 4,
					P,
					3,
					0.6,
				),
				{ tone: "mid" },
			),
		);
	}
	return out.join("");
}

function controlBox() {
	const out = [];
	out.push(S(k.slabOf(CONTROL, 0, CONTROL_H, P, 8, 1.2), { tone: "mid" }));
	out.push(
		L(k.planOutline(k.insetPlan(CONTROL, 5), CONTROL_H, P, 8), { tone: "faint" }),
	);
	const screen = { x: CONTROL.x + 12, y: CONTROL.y + 8, w: 76, d: 22, r: 2 };
	out.push(S(k.slabOf(screen, CONTROL_H, 1.2, P, 4), { tone: "lo", crease: "none" }));
	out.push(
		L(k.planOutline(k.insetPlan(screen, 2), CONTROL_H + 1.2, P, 4), {
			tone: "blue",
		}),
	);
	out.push(
		L(
			[0, 4, 8].map((offset) =>
				k.lineOnTop(
					[screen.x + 5, screen.y + 5 + offset],
					[screen.x + 5 + (offset === 4 ? 34 : 52), screen.y + 5 + offset],
					CONTROL_H + 1.2,
					P,
				),
			).join(""),
			{ tone: "blue" },
		),
	);
	const knobs = [
		[CONTROL.x + 106, CONTROL.y + 18],
		[CONTROL.x + 126, CONTROL.y + 18],
	];
	for (const [x, y] of knobs) {
		out.push(S(k.cylinder(x, y, 6, CONTROL_H, 4, P, 24), { tone: "mid" }));
		out.push(L(k.knurl(x, y, 6, CONTROL_H, CONTROL_H + 4, 30, P), { tone: "lo" }));
		out.push(L(k.lineOnTop([x, y], [x + 5, y], CONTROL_H + 4, P), { tone: "hi" }));
		out.push(D([at([x, y, CONTROL_H + 4])], { size: 0.5, tone: "hi" }));
	}
	const vents = { x: CONTROL.x + 12, y: CONTROL.y + 22, w: 64, d: 10, r: 1 };
	out.push(
		L(
			[0, 3, 6].map((offset) =>
				k.lineOnTop(
					[vents.x + 2, vents.y + 2 + offset],
					[vents.x + vents.w - 2, vents.y + 2 + offset],
					CONTROL_H,
					P,
				),
			).join(""),
			{ tone: "faint" },
		),
	);
	out.push(
		D(
			k.corners(CONTROL, 6).map(([x, y]) => at([x, y, CONTROL_H])),
			{ size: 0.45 },
		),
	);
	return out.join("");
}

function ledger() {
	const out = [];
	const strip = { x: -240, y: 102, w: 480, d: 22, r: 3 };
	out.push(S(k.slabOf(strip, DECK_H, 4, P, 4, 0.5), { tone: "lo" }));
	const ticks = k.topTicks(
		strip.x + 6,
		strip.x + strip.w - 6,
		6,
		5,
		strip.y + 2,
		DECK_H + 4,
		[1.6, 3.4],
		P,
	);
	out.push(L(ticks.minor, { tone: "faint" }), L(ticks.major, { tone: "lo" }));
	const dots = [];
	for (let index = 0; index < 18; index += 1) {
		const x = strip.x + 18 + index * 25;
		const y = strip.y + (index % 3 === 0 ? 8 : 13);
		dots.push(at([x, y, DECK_H + 4]));
	}
	out.push(D(dots, { size: 0.55, tone: "mid", pulse: true }));

	const head = { x: -34, y: 94, w: 38, d: 34, r: 3 };
	out.push(S(k.slabOf(head, DECK_H, 30, P, 4, 0.6), { tone: "mid" }));
	out.push(
		L(k.planOutline(k.insetPlan(head, 3), DECK_H + 30, P, 4), { tone: "faint" }),
	);
	out.push(
		D(
			k.corners(head, 5).map(([x, y]) => at([x, y, DECK_H + 30])),
			{ size: 0.4 },
		),
	);
	const lamp = [head.x + head.w / 2, head.y + head.d / 2];
	out.push(S(k.cylinder(lamp[0], lamp[1], 4, DECK_H + 30, 2, P, 20), { tone: "lit", lit: true }));
	return out.join("");
}

function sandbox() {
	const out = [];
	const posts = [
		[SANDBOX.x0, SANDBOX.y0],
		[SANDBOX.x0, SANDBOX.y1],
		[SANDBOX.x1, SANDBOX.y0],
		[SANDBOX.x1, SANDBOX.y1],
	];
	for (const [x, y] of posts) {
		out.push(
			S(k.cylinder(x, y, 5, DECK_H, SANDBOX_TOP - DECK_H, P, 20), {
				tone: "mid",
				crease: "none",
			}),
		);
		out.push(L(k.sideArc(x, y, 5, SANDBOX_TOP - 8, P, 12), { tone: "faint" }));
		out.push(S(k.cylinder(x, y, 6, SANDBOX_TOP, 3, P, 20), { tone: "mid" }));
	}
	const topX = { x: SANDBOX.x0 - 6, y: SANDBOX.y0 - 6, w: SANDBOX.x1 - SANDBOX.x0 + 12, d: 6, r: 1 };
	const topY = { x: SANDBOX.x1 - 6, y: SANDBOX.y0 - 6, w: 6, d: SANDBOX.y1 - SANDBOX.y0 + 12, r: 1 };
	out.push(S(k.slabOf(topX, SANDBOX_TOP, 4, P, 4), { tone: "mid" }));
	out.push(S(k.slabOf(topY, SANDBOX_TOP, 4, P, 4), { tone: "mid" }));

	const glass = k.onTop(
		[
			[SANDBOX.x0 + 5, SANDBOX.y1 - 5],
			[SANDBOX.x1 - 5, SANDBOX.y1 - 5],
			[SANDBOX.x1 - 5, SANDBOX.y1 - 5],
			[SANDBOX.x1 - 5, SANDBOX.y0 + 5],
		],
		DECK_H + 6,
		P,
		true,
	);
	out.push(
		`<path class="wf-glass" d="${glass}" />`,
	);
	out.push(
		L(
			k.onTop(
				[
					[SANDBOX.x0 + 5, SANDBOX.y1 - 5],
					[SANDBOX.x1 - 5, SANDBOX.y1 - 5],
				],
				SANDBOX_TOP - 4,
				P,
			),
			{ tone: "blue" },
		),
	);
	const table = { x: -118, y: -36, w: 46, d: 46, r: 3 };
	out.push(S(k.slabOf(table, DECK_H, 8, P, 4, 0.6), { tone: "hi" }));
	out.push(
		L(k.planOutline(k.insetPlan(table, 3), DECK_H + 8, P, 4), { tone: "faint" }),
	);
	const armBase = [-100, -14];
	out.push(S(k.cylinder(armBase[0], armBase[1], 7, DECK_H + 8, 8, P, 24), { tone: "mid" }));
	out.push(
		S(k.cylinder(armBase[0], armBase[1], 4, DECK_H + 16, 52, P, 18), {
			tone: "mid",
			crease: "none",
		}),
	);
	const arm = { x: armBase[0] + 4, y: armBase[1] - 3, w: 34, d: 6, r: 2 };
	out.push(S(k.slabOf(arm, DECK_H + 60, 4, P, 4, 0.5), { tone: "mid" }));
	out.push(S(k.cylinder(armBase[0] + 38, armBase[1], 3.4, DECK_H + 58, 10, P, 18), { tone: "hi" }));
	out.push(D([at([armBase[0] + 38, armBase[1], DECK_H + 68])], { size: 0.5, tone: "hi" }));
	return out.join("");
}

function validation() {
	const out = [];
	for (const y of VALIDATE_Y) {
		out.push(
			S(k.cylinder(VALIDATE_X, y, 5, DECK_H, VALIDATE_TOP - DECK_H, P, 20), {
				tone: "mid",
				crease: "none",
			}),
		);
		out.push(S(k.cylinder(VALIDATE_X, y, 6, VALIDATE_TOP, 3, P, 20), { tone: "mid" }));
	}
	const top = { x: VALIDATE_X - 6, y: VALIDATE_Y[0] - 6, w: 12, d: VALIDATE_Y[1] - VALIDATE_Y[0] + 12, r: 2 };
	out.push(S(k.slabOf(top, VALIDATE_TOP, 6, P, 4, 0.6), { tone: "mid" }));
	out.push(
		L(k.planOutline(k.insetPlan(top, 3), VALIDATE_TOP + 6, P, 4), { tone: "faint" }),
	);
	out.push(
		S(k.slabOf({ x: VALIDATE_X - 10, y: -34, w: 20, d: 68, r: 3 }, 92, 14, P, 4, 0.5), {
			tone: "mid",
		}),
	);
	out.push(
		L(
			k.onTop(
				[
					[VALIDATE_X, 0],
					[VALIDATE_X, 0],
				],
				106,
				P,
			),
			{ tone: "faint" },
		),
	);
	const scan = { x: VALIDATE_X - 7, y: -26, w: 14, d: 52, r: 2 };
	out.push(
		`<g data-part="scan">${S(k.slabOf(scan, 110, 5, P, 4, 0.4), { tone: "blue" })}${L(
			k.planOutline(k.insetPlan(scan, 2), 115, P, 4),
			{ tone: "blue" },
		)}</g>`,
	);
	out.push(
		D(
			[
				at([VALIDATE_X, -70, VALIDATE_TOP + 6]),
				at([VALIDATE_X, 70, VALIDATE_TOP + 6]),
			],
			{ size: 0.5, tone: "mid" },
		),
	);
	return out.join("");
}

function approval() {
	const out = [];
	out.push(S(k.cylinder(GATE[0], GATE[1], 22, DECK_H, 8, P, 32), { tone: "mid" }));
	out.push(L(k.ring(GATE[0], GATE[1], 22, DECK_H + 8, P, 40), { tone: "faint" }));
	out.push(
		S(k.cylinder(GATE[0], GATE[1], 7, DECK_H + 8, GATE_TOP - DECK_H - 20, P, 24), {
			tone: "mid",
			crease: "none",
		}),
	);
	const screen = at([GATE[0], GATE[1], 116]);
	const arm = `<g data-part="gate-arm" style="transform-box:view-box;transform-origin:${screen[0]}px ${screen[1]}px">${S(
		k.slabOf({ x: GATE[0] - 4, y: GATE[1] - 78, w: 8, d: 78, r: 3 }, 112, 6, P, 4, 0.6),
		{ tone: "lit", lit: true },
	)}${S(
		k.slabOf({ x: GATE[0] - 10, y: GATE[1] - 88, w: 20, d: 14, r: 2 }, 116, 12, P, 4, 0.6),
		{ tone: "lit", lit: true },
	)}${L(
		k.planOutline(
			{ x: GATE[0] - 10, y: GATE[1] - 88, w: 20, d: 14, r: 2 },
			128,
			P,
			4,
		),
		{ tone: "lit" },
	)}</g>`;
	out.push(arm);
	out.push(
		S(k.cylinder(GATE[0], GATE[1], 9, GATE_TOP, 8, P, 24), { tone: "mid" }),
	);
	out.push(
		S(k.cylinder(GATE[0], GATE[1], 5, GATE_TOP + 8, 4, P, 20), {
			tone: "lit",
			lit: true,
		}),
	);
	out.push(
		`<circle data-part="gate-lamp" class="wf-lamp" cx="${at([GATE[0], GATE[1], GATE_TOP + 13])[0]}" cy="${at([GATE[0], GATE[1], GATE_TOP + 13])[1]}" r="4" />`,
	);
	return out.join("");
}

function output() {
	const out = [];
	out.push(S(k.slabOf(TRAY, DECK_H, 6, P, 6, 0.6), { tone: "mid" }));
	out.push(
		L(k.planOutline(k.insetPlan(TRAY, 4), DECK_H + 6, P, 6), { tone: "faint" }),
	);
	out.push(S(k.slabOf(PR_CARD, DECK_H + 6, 4, P, 4, 0.5), { tone: "hi" }));
	out.push(
		L(k.planOutline(k.insetPlan(PR_CARD, 3), DECK_H + 10, P, 4), { tone: "blue" }),
	);
	const lines = [0, 5, 10, 15].map((offset) =>
		k.lineOnTop(
			[PR_CARD.x + 5, PR_CARD.y + 10 + offset],
			[PR_CARD.x + PR_CARD.w - 5, PR_CARD.y + 10 + offset],
			DECK_H + 10,
			P,
		),
	);
	out.push(L(lines.join(""), { tone: "faint" }));
	out.push(
		D(k.corners(TRAY, 7).map(([x, y]) => at([x, y, DECK_H + 6])), { size: 0.45 }),
	);
	return out.join("");
}

function carriage() {
	const out = [];
	const body = { x: -228, y: -72, w: 66, d: 66, r: 4 };
	out.push(S(k.slabOf(body, RAIL_Z + RAIL_H, 8, P, 5, 0.6), { tone: "mid" }));
	out.push(D(k.corners(body, 7).map(([x, y]) => at([x, y, RAIL_Z + RAIL_H + 8])), { size: 0.4 }));
	out.push(
		L(
			[0, 1].map((index) =>
				k.lineOnTop(
					[body.x + 6, body.y + 12 + index * 8],
					[body.x + body.w - 6, body.y + 12 + index * 8],
					RAIL_Z + RAIL_H + 8,
					P,
				),
			).join(""),
			{ tone: "faint" },
		),
	);
	return out.join("");
}

function task() {
	const plan = { x: TASK_X, y: TASK_Y, w: TASK_W, d: TASK_D, r: 3 };
	const out = [];
	out.push(S(k.slabOf(plan, TASK_Z, TASK_H, P, 5, 0.7), { tone: "hi" }));
	out.push(L(k.planOutline(k.insetPlan(plan, 3), TASK_Z + TASK_H, P, 5), { tone: "blue" }));
	out.push(
		L(
			[0, 1].map((index) =>
				k.lineOnTop(
					[plan.x + 7, plan.y + 10 + index * 8],
					[plan.x + plan.w - 7, plan.y + 10 + index * 8],
					TASK_Z + TASK_H,
					P,
				),
			).join(""),
			{ tone: "blue" },
		),
	);
	out.push(D([at([TASK_X + 6, TASK_Y + 6, TASK_Z + TASK_H])], { size: 0.5, tone: "hi" }));
	return out.join("");
}

function cables() {
	const paths = [
		[
			[-52, -132],
			[-52, -100],
			[-95, -70],
			[-95, -40],
		],
		[
			[70, -132],
			[70, -105],
			[40, -92],
			[40, -70],
		],
		[
			[96, -132],
			[96, -110],
			[140, -90],
			[140, -40],
		],
	];
	return paths
		.map((points) =>
			L(k.onTop(points, DECK_H, P), { tone: "blue", flow: true }),
		)
		.join("");
}

const body = [
	base(),
	controlBox(),
	cables(),
	rails(),
	ledger(),
	sandbox(),
	validation(),
	approval(),
	output(),
	carriage(),
	`<g data-part="task" class="wf-task">${task()}</g>`,
].join("");

const deltas = STATIONS.map((x) => screenDelta(x - TASK_X));
const gateScreen = at([GATE[0], GATE[1], 116]);
const style = `
<style>
.wf-glass{fill:rgba(2,151,222,.07);stroke:rgba(2,151,222,.32);stroke-width:.6}
.wf-task .iso-top{fill:#63bce8}.wf-task .iso-shade{fill:#0277ad}.wf-task .iso-edge{stroke:#8fd4f5}.wf-task .iso-line{stroke:#8fd4f5}.wf-lamp{fill:#fc734d;opacity:.9;animation:wf-lamp 2.4s ease-in-out infinite}
@keyframes wf-task{
  0%,6%{transform:translate(0,0);opacity:1}
  20%,30%{transform:translate(${px(deltas[0][0])},${px(deltas[0][1])});opacity:1}
  42%,52%{transform:translate(${px(deltas[1][0])},${px(deltas[1][1])});opacity:1}
  62%,70%{transform:translate(${px(deltas[2][0])},${px(deltas[2][1])});opacity:1}
  82%,94%{transform:translate(${px(deltas[3][0])},${px(deltas[3][1])});opacity:1}
  98%,100%{transform:translate(${px(deltas[3][0])},${px(deltas[3][1])});opacity:0}
}
@keyframes wf-gate{
  0%,58%{transform:rotate(0deg)}
  66%,78%{transform:rotate(-72deg)}
  88%,100%{transform:rotate(0deg)}
}
@keyframes wf-scan{
  0%,32%{transform:translateY(0)}
  42%,50%{transform:translateY(34px)}
  60%,100%{transform:translateY(0)}
}
@keyframes wf-lamp{
  0%,100%{opacity:.35}
  12%,46%{opacity:1}
  60%{opacity:.35}
}
[data-part="task"]{animation:wf-task 18s cubic-bezier(.23,1,.32,1) infinite}
[data-part="gate-arm"]{animation:wf-gate 18s cubic-bezier(.23,1,.32,1) infinite}
[data-part="scan"]{animation:wf-scan 18s cubic-bezier(.23,1,.32,1) infinite}
@media (prefers-reduced-motion:reduce){
  [data-part="task"],[data-part="gate-arm"],[data-part="scan"],.wf-task .iso-top{fill:#63bce8}.wf-task .iso-shade{fill:#0277ad}.wf-task .iso-edge{stroke:#8fd4f5}.wf-task .iso-line{stroke:#8fd4f5}.wf-lamp{animation:none!important}
}
</style>`;

const BRAND_CSS = `.iso{
--anatomy-card:#02070a;--anatomy-paper:#071016;--anatomy-top:#1c4658;
--anatomy-shade-0:#08161d;--anatomy-shade-1:#0c2029;--anatomy-shade-2:#112b37;--anatomy-shade-3:#173846;
--anatomy-face:#fc734d;--anatomy-lit-top:#ff9b78;--anatomy-lit-shade:#d9572f;
--anatomy-hi:#eaf2f5;--anatomy-mid:#6a8b9c;--anatomy-lo:#3d6072;--anatomy-faint:#203541;--anatomy-lit:#fc734d;
--anatomy-blue:#0297de;--anatomy-red:#fc734d;--anatomy-green:#4ccb91;--anatomy-dot:#63bce8;
--anatomy-halo:#000000;--anatomy-halo-opacity:.55;--anatomy-weight:.7px;
}`;

const full = k.figureSvg({
	width: WIDTH,
	height: HEIGHT,
	label:
		"An isometric workflow machine. A task block leaves the input carriage, passes through a glass sandbox chamber, under a validation arch, through an orange approval turnstile, and onto the branch tray. A ledger strip records each event.",
	body: [style, body],
	className: "wf-svg",
	standalone: true,
});
const branded = (source) => source.replace("</style>", `${BRAND_CSS}</style>`);
const outDir = "apps/web/public/iso";
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/workflow-machine.svg`, branded(full));
console.log(`wrote ${outDir}/workflow-machine.svg (${(full.length / 1024).toFixed(1)} KiB)`);