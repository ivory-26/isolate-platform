import { mkdirSync, writeFileSync } from "node:fs";
import * as k from "./iso/iso-kit.mjs";

/**
 * Landing feature figures.
 *
 * One hairline vocabulary, borrowed from instrument drawing: a single stroke
 * weight, dashed hidden edges, small nodes at the ends, no fills or shading.
 * Each figure is built from its section's own words:
 *
 *   sandbox  -> clone, ownership globs, network (denied), budget
 *   approval -> payload, commit sha, approve, reject
 *   record   -> event, stage, timestamp, durable
 *
 * Every scene sits on a plate so the three figures share one ground plane.
 *
 * Run: bun apps/web/scripts/build-iso.mjs
 */

const WIDTH = 720;
const HEIGHT = 470;
const PAD = 38;
const AZ = 45;
const EL = 30;
const OUT = "apps/web/public/iso";

/* Tokens: the page is #02070A, so strokes are light and thin. */
const BRAND_CSS = `.iso{
  --anatomy-paper:#02070a;
  --anatomy-hi:#e4f0f6;
  --anatomy-mid:#8aa7b6;
  --anatomy-lo:#44626f;
  --anatomy-faint:#203138;
  --anatomy-lit:#fc734d;
  --anatomy-red:#fc734d;
  --anatomy-blue:#0297de;
  --anatomy-dot:#9fd3ec;
  --anatomy-weight:.8px;
}
.iso-line[data-tone="blue"]{stroke-width:1.15px}
.iso-line[data-tone="red"]{stroke-width:1.15px}
.iso-line[data-tone="hi"]{stroke-width:1px}
.iso-dots circle{fill:#9fd3ec}
.iso-dots[data-tone="mid"] circle{fill:#5f8ba0}
.iso-dots[data-tone="faint"] circle{fill:#2c4653}`;

const px = (value) => `${value.toFixed(1)}px`;

/** Projection helpers shared by every scene. */
function geometry(P) {
	const iso = (point) => k.iso(point, P);
	const line = (d, tone, opts = {}) => k.lineSvg(d, { tone, ...opts });
	const edge = (a, b, tone, opts = {}) =>
		line(k.pathOf([iso(a), iso(b)]), tone, opts);
	const edges = (pairs, tone, opts = {}) =>
		line(
			pairs.map(([a, b]) => k.pathOf([iso(a), iso(b)])).join(""),
			tone,
			opts,
		);
	const strokePaths = (paths, tone, opts = {}) =>
		line(paths.filter(Boolean).join(""), tone, opts);
	const planRing = (plan, z, tone, opts = {}) =>
		line(k.planOutline(plan, z, P, 10), tone, opts);
	const planEdge = (points, z, tone, closed = false, opts = {}) =>
		line(k.onTop(points, z, P, closed), tone, opts);
	const lineOnTop = (from, to, z, tone, opts = {}) =>
		line(k.lineOnTop(from, to, z, P), tone, opts);
	const dot = (point, size = 2, tone = "mid") =>
		k.dotsSvg([iso(point)], { size, tone });
	const dots = (points, size = 2, tone = "mid") =>
		k.dotsSvg(points.map(iso), { size, tone });
	const ticks = (from, to, step, every, y, z, lengths, tone = "lo") => {
		const marks = k.topTicks(from, to, step, every, y, z, lengths, P);
		return `${line(marks.minor, "faint")}${line(marks.major, tone)}`;
	};

	/** A box drawn as a wireframe: top edge solid, far edge dashed. */
	const box = (
		plan,
		z0,
		z1,
		{ top = "mid", side = "lo", hidden = "faint" } = {},
	) => {
		const radius = plan.r ?? 0;
		const inset = radius * (1 - Math.SQRT1_2);
		const posts = [
			[plan.x + inset, plan.y + inset],
			[plan.x + plan.w - inset, plan.y + inset],
			[plan.x + plan.w - inset, plan.y + plan.d - inset],
			[plan.x + inset, plan.y + plan.d - inset],
		];
		return [
			hidden ? planRing(plan, z0, hidden, { dashed: true }) : "",
			strokePaths(
				posts.map(([x, y]) => k.pathOf([iso([x, y, z0]), iso([x, y, z1])])),
				side,
			),
			planRing(plan, z1, top),
		].join("");
	};

	/** A column: two ellipses and the two silhouette lines. */
	const cyl = (
		cx,
		cy,
		radius,
		z0,
		z1,
		{ top = "mid", side = "lo", hidden = "faint" } = {},
	) => {
		const [vx, vy] = k.towardViewer(P);
		const bearing = Math.atan2(vy, vx);
		const out = [
			planEdge(k.circleRing(cx, cy, radius, 40), z0, hidden, true, {
				dashed: true,
			}),
			planEdge(k.circleRing(cx, cy, radius, 40), z1, top, true),
		];
		for (const sign of [1, -1]) {
			const angle = bearing + (sign * Math.PI) / 2;
			const px0 = cx + radius * Math.cos(angle);
			const py0 = cy + radius * Math.sin(angle);
			out.push(edge([px0, py0, z0], [px0, py0, z1], side));
		}
		return out.join("");
	};

	return {
		iso,
		line,
		edge,
		edges,
		strokePaths,
		planRing,
		planEdge,
		lineOnTop,
		dot,
		dots,
		ticks,
		box,
		cyl,
	};
}

/** Screen-space offset for a world-space move, used by the animations. */
function shift(P, from, to) {
	const a = k.iso(from, P);
	const b = k.iso(to, P);
	return [b[0] - a[0], b[1] - a[1]];
}

function writeScene({ name, label, fit, css = "", build }) {
	const P = k.fitProjection(fit, WIDTH, HEIGHT, {
		pad: PAD,
		azimuth: AZ,
		elevation: EL,
	});
	const g = geometry(P);
	const rules = typeof css === "function" ? css({ g, P }) : css;
	const body = [
		`<style>${rules}
@media (prefers-reduced-motion:reduce){[data-part]{animation:none!important}}
</style>`,
		...build(g, P),
	];
	const svg = k.figureSvg({
		width: WIDTH,
		height: HEIGHT,
		label,
		body,
		className: "line-svg",
		standalone: true,
	});
	mkdirSync(OUT, { recursive: true });
	const file = svg.replace("</style>", `${BRAND_CSS}</style>`);
	writeFileSync(`${OUT}/${name}.svg`, file);
	console.log(`${name}.svg`, `${(file.length / 1024).toFixed(1)} KiB`);
}

/* ------------------------------------------------------------------ */
/* sandbox: the plate is the sandbox; the wire is cut at its wall.      */
/* ------------------------------------------------------------------ */

writeScene({
	name: "sandbox",
	label:
		"Hairline isometric diagram of a sandbox: a wireframe plate holds a stack of cloned repository layers and a task block raised on a column inside a dashed ownership boundary. A network wire leaves the task, crosses the boundary and is cut at the sandbox wall. A budget dial and a tick ruler sit at the front.",
	fit: [
		...k.boxCorners({ x: -150, y: -88, w: 300, d: 176 }, 0, 12),
		[-16, -30, 64],
		[146, 6, 24],
		[-78, 72, 12],
	],
	css: `[data-part="deny"]{animation:s-deny 6.5s ease-in-out infinite}
@keyframes s-deny{0%,70%,100%{opacity:.35}80%,90%{opacity:1}}
[data-part="needle"]{animation:s-needle 9s cubic-bezier(.32,.72,0,1) infinite}
@keyframes s-needle{0%,100%{transform:rotate(-9deg)}40%,60%{transform:rotate(7deg)}}`,
	build: (g, P) => {
		const PLATE = { x: -150, y: -88, w: 300, d: 176, r: 14 };
		const OWN = { x: -56, y: -50, w: 108, d: 92, r: 8 };
		const parts = [];

		parts.push(g.box(PLATE, 0, 12, { top: "mid", side: "lo" }));

		// clone: three repository layers, inside the sandbox, outside the globs.
		const CLONE = { x: -132, y: -42, w: 58, d: 58, r: 5 };
		for (let layer = 0; layer < 3; layer += 1) {
			parts.push(
				g.box(CLONE, 12 + layer * 4, 16 + layer * 4, {
					top: layer === 2 ? "mid" : "lo",
					side: "faint",
				}),
			);
		}
		parts.push(
			g.dots(
				k.corners(CLONE, 9).map(([x, y]) => [x, y, 24]),
				1.7,
				"faint",
			),
		);

		// ownership: the files this run may write.
		parts.push(g.planRing(OWN, 12, "lo", { dashed: true }));
		const bracket = 12;
		parts.push(
			g.edges(
				[
					[[OWN.x, OWN.y], [OWN.x + bracket, OWN.y]],
					[[OWN.x, OWN.y], [OWN.x, OWN.y + bracket]],
					[
						[OWN.x + OWN.w - bracket, OWN.y],
						[OWN.x + OWN.w, OWN.y],
					],
					[
						[OWN.x + OWN.w, OWN.y],
						[OWN.x + OWN.w, OWN.y + bracket],
					],
					[
						[OWN.x, OWN.y + OWN.d - bracket],
						[OWN.x, OWN.y + OWN.d],
					],
					[
						[OWN.x, OWN.y + OWN.d],
						[OWN.x + bracket, OWN.y + OWN.d],
					],
					[
						[OWN.x + OWN.w - bracket, OWN.y + OWN.d],
						[OWN.x + OWN.w, OWN.y + OWN.d],
					],
					[
						[OWN.x + OWN.w, OWN.y + OWN.d - bracket],
						[OWN.x + OWN.w, OWN.y + OWN.d],
					],
				].map(([a, b]) => [
					[a[0], a[1], 12],
					[b[0], b[1], 12],
				]),
				"lo",
			),
		);

		// The task: the only object at that height.
		parts.push(g.cyl(8, -4, 12, 12, 38, { top: "lo", side: "faint" }));
		parts.push(
			g.box({ x: -16, y: -28, w: 48, d: 48, r: 4 }, 38, 64, {
				top: "blue",
				side: "blue",
			}),
		);
		parts.push(g.dot([-8, -20, 64], 2.2, "hi"));

		// network: leaves the task, crosses the globs, cut at the sandbox wall.
		parts.push(
			g.line(k.onTop([[18, -4], [96, -4], [138, -4]], 24, P), "blue", {
				flow: true,
			}),
		);
		parts.push(
			`<g data-part="deny">${g.strokePaths(
				[
					k.lineOnTop([140, -14], [140, 6], 24, P),
					k.lineOnTop([133, -14], [133, 6], 24, P),
				],
				"red",
			)}</g>`,
		);

		// budget: a dial and the plate's own ruler.
		const DIAL = [-100, 56];
		const R = 17;
		parts.push(
			g.planEdge(k.circleRing(DIAL[0], DIAL[1], R, 40), 12, "lo", true),
		);
		parts.push(
			g.strokePaths(
				Array.from({ length: 12 }, (_, index) => {
					const angle = (index / 12) * Math.PI * 2;
					const inner = R - (index % 3 === 0 ? 5 : 3);
					return k.lineOnTop(
						[DIAL[0] + inner * Math.cos(angle), DIAL[1] + inner * Math.sin(angle)],
						[DIAL[0] + R * Math.cos(angle), DIAL[1] + R * Math.sin(angle)],
						12,
						P,
					);
				}),
				"faint",
			),
		);
		const pivot = k.iso([DIAL[0], DIAL[1], 12], P);
		parts.push(
			`<g data-part="needle" style="transform-box:view-box;transform-origin:${px(pivot[0])} ${px(pivot[1])}">${g.lineOnTop(
				[DIAL[0], DIAL[1]],
				[DIAL[0] + R * 0.74, DIAL[1] - R * 0.3],
				12,
				"red",
			)}</g>`,
		);
		parts.push(g.dot([DIAL[0], DIAL[1], 12], 1.7, "hi"));
		parts.push(g.ticks(-124, 116, 8, 5, PLATE.y + PLATE.d - 10, 12, [2, 4]));

		return parts;
	},
});

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* approval: a stamp held over the exact payload.                      */
/* ------------------------------------------------------------------ */

writeScene({
	name: "approval",
	label:
		"Hairline isometric diagram of an approval gate: a plinth carries a payload sheet marked with three commit hash dots. A stamp hangs from a slim column and arm, its head held above the paper. Two round buttons on the plinth read approve and reject.",
	fit: [
		...k.boxCorners({ x: -84, y: -46, w: 172, d: 92 }, 0, 10),
		[58, -32, 56],
		[-46, -30, 52],
		[52, 30, 10],
	],
	css: ({ P }) => {
		const press = shift(P, [-31, -4, 42], [-31, -4, 24]);
		return `[data-part="press"]{animation:a-press 9s cubic-bezier(.32,.72,0,1) infinite}
@keyframes a-press{0%,26%{transform:translate(0,0)}44%,62%{transform:translate(${px(press[0])},${px(press[1])})}78%,100%{transform:translate(0,0)}}
[data-part="lamp"]{animation:a-lamp 9s ease-in-out infinite}
@keyframes a-lamp{0%,40%{opacity:.2}48%,66%{opacity:1}80%,100%{opacity:.2}}`;
	},
	build: (g) => {
		const PLINTH = { x: -84, y: -46, w: 172, d: 92, r: 10 };
		const SHEET = { x: -64, y: -30, w: 66, d: 52, r: 3 };
		const HEAD = { x: -51, y: -24, w: 40, d: 40, r: 3 };
		const DIE = { x: -44, y: -17, w: 26, d: 26, r: 2 };
		const ARM = { x: -46, y: -34, w: 104, d: 10, r: 3 };
		const POST = [58, -32];
		const parts = [g.box(PLINTH, 0, 10, { top: "mid", side: "lo" })];

		// The payload: the exact thing being authorized.
		parts.push(g.box(SHEET, 10, 16, { top: "blue", side: "blue", hidden: null }));
		parts.push(
			g.dots(
				[
					[SHEET.x + 8, SHEET.y + 9, 16],
					[SHEET.x + 21, SHEET.y + 9, 16],
					[SHEET.x + 34, SHEET.y + 9, 16],
				],
				1.9,
				"blue",
			),
		);
		parts.push(
			g.lineOnTop(
				[SHEET.x + 8, SHEET.y + 25],
				[SHEET.x + 54, SHEET.y + 25],
				16,
				"faint",
			),
		);
		parts.push(
			g.lineOnTop(
				[SHEET.x + 8, SHEET.y + 34],
				[SHEET.x + 40, SHEET.y + 34],
				16,
				"faint",
			),
		);

		// The stamp: column, arm, rod, head, die, held just above the sheet.
		parts.push(g.cyl(POST[0], POST[1], 5, 10, 52, { top: "mid", side: "lo" }));
		parts.push(g.box(ARM, 46, 52, { top: "mid", side: "lo", hidden: null }));
		parts.push(
			`<g data-part="press">${[
				g.cyl(-31, -24, 2.2, 42, 46, { top: "lo", side: "faint" }),
				g.box(HEAD, 38, 42, { top: "red", side: "red", hidden: null }),
				g.box(DIE, 34, 38, { top: "red", side: "red", hidden: null }),
			].join("")}</g>`,
		);
		parts.push(
			`<g data-part="lamp">${g.planEdge(k.circleRing(POST[0], POST[1], 3, 18), 52, "red", true)}</g>`,
		);

		// approve / reject: two buttons set straight into the plate.
		const button = (x, y, tone) =>
			[
				g.planEdge(k.circleRing(x, y, 8.5, 30), 10, "lo", true),
				g.planEdge(k.circleRing(x, y, 5, 24), 10, tone, true),
				g.dot([x, y, 10], 1.5, "hi"),
			].join("");
		parts.push(button(26, 30, "blue"));
		parts.push(button(52, 30, "red"));

		// A scale along the open front edge.
		parts.push(g.ticks(-74, 4, 8, 4, PLINTH.y + PLINTH.d - 7, 10, [2, 4]));

		return parts;
	},
});

/* ------------------------------------------------------------------ */
/* record: a strip of event tiles, one still being written.            */
/* ------------------------------------------------------------------ */

writeScene({
	name: "record",
	label:
		"Hairline isometric diagram of a run record: a plinth carries a record strip with five event tiles, the fourth lifted above the others on a dashed drop line. A tick ruler on the front edge reads elapsed time, and an archive drawer at the left holds the durable copy.",
	fit: [
		...k.boxCorners({ x: -128, y: -56, w: 256, d: 112 }, 0, 8),
		[47, -21, 78],
		[-118, 2, 24],
		[-22, 46, 24],
		[118, 28, 18],
	],
	css: ({ P }) => {
		const drop = shift(P, [47, -21, 78], [47, -21, 17]);
		return `[data-part="lift"]{animation:r-lift 8s cubic-bezier(.32,.72,0,1) infinite}
@keyframes r-lift{0%,16%{transform:translate(0,0)}40%,60%{transform:translate(${px(drop[0])},${px(drop[1])})}76%,100%{transform:translate(0,0)}}`;
	},
	build: (g) => {
		const PLINTH = { x: -128, y: -56, w: 256, d: 112, r: 12 };
		const TAPE = { x: -118, y: -46, w: 236, d: 46, r: 4 };
		const parts = [g.box(PLINTH, 0, 8, { top: "mid", side: "lo" })];

		parts.push(g.box(TAPE, 8, 12, { top: "mid", side: "faint" }));

		// Five events on the strip. The fourth is the approval.
		const TILE_Y = -42;
		for (const [index, x] of [-118, -70, -22, 26, 74].entries()) {
			const plan = { x, y: TILE_Y, w: 42, d: 42, r: 4 };
			const tone = index === 3 ? "red" : index === 4 ? "lo" : "mid";
			const centre = [x + 21, TILE_Y + 21];

			if (index === 3) {
				parts.push(
					g.edge(
						[centre[0], centre[1], 12],
						[centre[0], centre[1], 74],
						"red",
						{ dashed: true },
					),
				);
				parts.push(
					`<g data-part="lift">${g.box(plan, 74, 78, {
						top: tone,
						side: tone,
						hidden: null,
					})}${g.dot([centre[0], centre[1], 78], 2.4, tone)}</g>`,
				);
				continue;
			}

			parts.push(g.box(plan, 12, 17, { top: tone, side: "faint" }));
			parts.push(g.dot([centre[0], centre[1], 17], 2.2, tone));
		}

		// durable: the archive drawer, front left.
		const DRAWER = { x: -118, y: 2, w: 96, d: 44, r: 5 };
		const face = DRAWER.y + DRAWER.d;
		parts.push(g.box(DRAWER, 8, 24, { top: "mid", side: "lo" }));
		parts.push(
			g.edge([DRAWER.x + 14, face, 16], [DRAWER.x + 82, face, 16], "mid"),
		);
		parts.push(g.dot([DRAWER.x + 48, face, 16], 2, "hi"));

		// timestamp: the ruler, with a marker under the event being written.
		parts.push(g.edge([-6, 28, 8], [118, 28, 8], "mid"));
		parts.push(g.ticks(-4, 116, 7, 4, 28, 8, [2.5, 5], "mid"));
		parts.push(g.edge([47, 28, 8], [47, 28, 18], "red"));
		parts.push(g.dot([47, 28, 18], 2.2, "red"));

		return parts;
	},
});
