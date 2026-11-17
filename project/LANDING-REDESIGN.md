# Landing illustration redesign — reference study and implementation spec

Status: illustration implementation merged as `5ef4a9a`; implementation record
and design-rule amendments are in [`design.md`](design.md#landing-schematics-2026-11-14).
The reference study and original checklist below are retained as design history;
unchecked boxes are not evidence that the merged code is missing.
Scope: illustration and diagram language for the public landing page only.
Owner: landing surface (`apps/web/src/features/landing/**`, `apps/web/public/ill/**`).

This document replaces the current Modal-style isometric drawing set with one
orthographic, line-diagram system called **Isolate schematics**. It does not
change the page's sections, copy, layout grid, shader, product captures, or any
non-landing package.

It deliberately conflicts with two sentences in `project/design.md`:

- §8, line 276: "Use Modal-inspired isometric SVGs and technical illustrations
  selectively".
- §14, line 503: "Illustration | Modal-style isometric storytelling".

Phase 0 below amends those two lines and appends an implementation record. Until
that amendment lands, this document is the newer, more specific instruction for
the landing page; the dashboard guidance in §8 is unaffected.

---

## 1. Current landing map

### 1.1 Route and component topology

`apps/web/src/routes/index.tsx` is a 25-line route wrapper. It owns the auth
redirect, the page title and description, and the component binding:

- line 3: `import { LandingPage } from "@/features/landing/landing-page";`
- line 13: `component: LandingPage`
- lines 14-23: `head()` meta

Every landing section lives in `apps/web/src/features/landing/landing-page.tsx`.
A section-by-section map therefore has to cite that file, not the route file.
The route file stays untouched by this work.

### 1.2 Section-by-section map and illustration slots

Line numbers are from `apps/web/src/features/landing/landing-page.tsx` unless a
component file is named.

| # | Section | Source lines | Current content | Illustration slot | Action |
|---|---|---|---|---|---|
| 1 | Skip link | 97-102 | fixed skip link | none | keep |
| 2 | Shader backdrop | 104 | `<ShaderBackdrop />` (fixed, behind page) | none — the shader *is* the background | keep, unchanged |
| 3 | Header | 106 | `<SiteHeader />` | none | keep |
| 4 | Hero | 109-154 | h1 at 111, lede at 122, buttons at 130-152 | none. A hero trace strip was considered and rejected: it would sit over the brightest shader region and break both contrast and the centred composition. | keep, unchanged |
| 5 | Product view | 156-173 | `<ProductShot src="/images/dashboard-overview.png">` at 164-171 | raster product capture (1600×1200), not an illustration | keep, unchanged |
| 6 | Facts strip | 176-203 | `facts.map` at 183, `<FrameDots />` at 180 | none | keep |
| 7 | Capabilities intro | 211-219 | h2 at 212, lede at 215 | none | keep |
| 8 | Capability row 1 — sandbox | 222-230 | copy + 3 bullets; visual at 230 `<FeatureVisual feature="sandbox" />` | primary figure, 720×470 | **replace** with A1 |
| 9 | Capability row 2 — approval (reverse, orange tone) | 233-243 | copy + 3 bullets; visual at 243 `feature="approval"` | primary figure, 720×470 | **replace** with A3 |
| 10 | Capability row 3 — record | 246-250 | copy only, no bullets; visual at 249 `feature="record"` | primary figure, 720×470 | **replace** with A5 |
| 11 | Lifecycle | 255 → `components/lifecycle-section.tsx` | h2 at file line 22, visual at 30, ordered list at 33-52 | wide figure, 1000×560 | **replace** with A6 (inline SVG) |
| 12 | Trust | 257 → `components/trust-section.tsx` | explanatory copy at 87-94, DOM diagram `TrustDiagram` at 12-79, rendered at line 98 | inline DOM diagram with real text; `figcaption.sr-only` at 15-19 | **replace drawing area** with A7 + A8, preserve the three visible text blocks and the footnote |
| 13 | Closing CTA | 259-293 | h2 at 266, copy at 269, actions at 273-290 | none; `<FrameDots />` at 260-261 and `<FrameLines />` at 294 | keep |
| 14 | Footer | 298 | `<SiteFooter />` | none | keep |

The visual slot is currently abstracted by
`apps/web/src/features/landing/components/feature-visual.tsx`. It is the only
file that references `/iso`:

```ts
sandbox:   { src: "/iso/sandbox.svg",   width: 720,  height: 470 },
approval:  { src: "/iso/approval.svg",  width: 720,  height: 470 },
record:    { src: "/iso/record.svg",    width: 720,  height: 470 },
lifecycle: { src: "/iso/lifecycle.svg", width: 1000, height: 560, wide: true },
```

It renders `<figure className="wf-figure">` (plus `wf-figure-wide`) with
`<img alt="" loading="lazy" decoding="async">`. A grep for `/iso` across
`apps/web/src` returns only this file.

### 1.3 Audit of the current illustration set

Weights and sizes:

| File | Bytes | viewBox |
|---|---:|---|
| `/iso/sandbox.svg` | 19,968 | 720×470 |
| `/iso/approval.svg` | 19,075 | 720×470 |
| `/iso/record.svg` | 20,222 | 720×470 |
| `/iso/lifecycle.svg` | 32,612 | 1000×560 |
| **Total** | **91,877** | |

Findings that motivate the redesign:

1. **Strokes render below one CSS pixel.** The drawings use stroke widths of
   0.4, 0.45, 0.6, 0.8, 1, 1.15 and 1.4 user units. `.wf-figure img` caps the
   display width at 560 px, so a 720-wide viewBox scales by 0.778: 0.8 units
   becomes 0.62 CSS px and 1.4 becomes 1.09. At that size anti-aliasing spreads
   each line over two pixels at reduced alpha, so the effective contrast is well
   below the declared colour value.
2. **The structural colour fails non-text contrast.** `#31505F` (line-strong)
   measures **2.36:1** against `#02070A`; `#203541` measures 1.59:1 and
   `#14232C` 1.26:1. WCAG 1.4.11 requires 3:1 for graphics that carry meaning.
   Most of the current hairline network is therefore not perceivable as
   structure at all.
3. **Three theme variants per file are dead weight.** Each SVG carries
   `--anatomy-paper`, `--anatomy-hi`, `--anatomy-mid` and matching light/mid/dark
   blocks. The product is dark-only (`project/design.md` §3), so two thirds of
   every file is never used.
4. **The isometric projection fights the content.** Oblique cubes and stacked
   planes imply a physical object. The product is a set of boundaries, gates and
   events, which are better shown in plan and elevation.
5. **No motion, no annotation discipline.** Labels are baked into dense line
   art, so there is no way to adapt density on small screens.

Keep: the figure has no card and no frame (`.wf-figure` at `landing.css:66-95`);
that decision is correct and survives.

---

## 2. Reference teardown

All measurements below were taken from the live pages and their shipped assets
on 2026-11-14. Sizes are byte counts of the assets as served.

### 2.1 Baseten — flat-shaded 2.5D objects with a code face

Sources:
- <https://www.baseten.co/>
- <https://www.baseten.co/products/sandboxes/>
- <https://www.datocms-assets.com/104802/1793991385-baseten-sandboxes-01.png?auto=format&w=1600>
- <https://www.datocms-assets.com/104802/1793317611-baseten-ctalarge-01.png?auto=format&w=1600>
- <https://www.datocms-assets.com/104802/1793282998-baseten-nav-04.png>

**Composition.** One cropped object per frame, never a scene. The object is a
2.5D extrusion with flat shaded faces (three tones maximum) and one face
replaced by a black terminal panel showing real code. Dashed white connectors
leave the object and stop at the frame edge. A faint isometric grid floor sits
behind and is cropped. Tiny diamond particles are the only ambient element. The
object is allowed to bleed off the canvas on two sides, which makes the frame
feel like a crop of a larger system.

**Palette behaviour.** Near-black ground, white line work, one saturated hue per
object. Shading is done with value, not gradient: base tone, lighter top face,
darker side face. No glow, no bloom. The accent lives on the object, never in the
background.

**Illustration style.** Vector-like but shipped as high-resolution raster for
product tiles (1600×1600), with 141×141 PNGs for navigation. The landing hero is
not a static image at all: it is a client-rendered, CSS-masked canvas
(`.s5zMka_canvas`), so the "illustration" is a live surface with a hard-edged
mask.

**Do.**
- Crop aggressively; let the subject leave the frame.
- Limit each object to three values plus one accent.
- Replace one face with real code or real data.
- Use dashed connectors that terminate at the edge.
- Keep the grid faint and behind everything.

**Don't.**
- Do not compose several objects into a scene.
- Do not shade with gradients or add glow.
- Do not use the accent as a background wash.
- Do not animate the raster tiles.

### 2.2 Modal — one luminous object in a void, plus a masked particle field

Sources:
- <https://modal.com/>
- Full-page capture: <https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/modal-com/full.1440.webp?v=1777662088>
- Shipped animation CSS: `WorkloadAnimation.C9weL7CL.css` (7,730 bytes)

**Composition.** Extreme negative space: a single lime cube on black, occupying
well under a tenth of the viewport, with a soft halo. The eye is given nothing
else to land on, so the object reads instantly. Secondary illustrations are a
five-tile isometric icon row and a 3D security stack; both use the same
single-object discipline.

**Palette behaviour.** Black, white, and one green. The green appears as surface
emission (the lit cube), as thin framing on screenshots, and as small state
accents. Nothing else is coloured.

**Illustration style.** Two mechanisms:
1. A masked inline hexagonal particle field: `viewBox="0 0 662 486"`, repeated
   path `M0 11.8L-10.2 5.9V-5.9L0 -11.8...`, one node per particle, driven by CSS
   custom properties `--dim`, `--delay`, `--fade`, `--tx`, `--ty` and a `data-lit`
   attribute. The field is cheap because the animation lives in CSS variables
   rather than in per-frame JavaScript.
2. Orbital rings drawn as 96-segment circles in a `-221 -221 442 442` viewBox,
   used as a framing device around product imagery.

**Motion.** The workload animation uses `--t-enter: .85s`, an 80 ms stagger,
`--t-hold: .2s`, `--t-reflow: 6s`, `--spin-duration: 5.3s`, and
`motion-reduce:transition-none`. Motion is slow, continuous and low-amplitude;
it never competes with reading.

**Do.**
- Buy attention with emptiness, not with detail.
- One lit object per view.
- Drive ambient motion from CSS variables on a small number of nodes.
- Neutralise motion under `prefers-reduced-motion` at the transition level.

**Don't.**
- Do not copy the glow: it only works because the rest of the page is empty.
- Do not run a 6-second looping animation next to body copy on a content page.
- Do not let a particle field become the page background.

### 2.3 Fireworks — square diagram films with a true reduced-motion fallback

Sources:
- <https://fireworks.ai/>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/7bf4f8defdb7474e26f24b824b14097605e1df11-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/020a4975048bc6ae775727b618af9ef121fe183d-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/24170776adcefd472cbde0cd67f4ea632f48d9b3-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/6b512b4af5b4557e7786b1f24c452e4453dc9405-1080x1080.svg>

**Composition.** Every asset is a 1080×1080 square, so the set tiles into any
grid without art direction per slot. Inside the square, a single small diagram
sits on a large flat ground with a consistent margin. The diagram is a film: it
has a beginning, a transit and a settled end state.

**Palette behaviour.** Ground `#280016`, structure `#4B3F42` at a 1.884 unit
stroke, neutral `#857979`, cream `#E2DDD8`, accent `#FF0073` used in thick
24-60 unit strokes, white for highlights. Structure is low-contrast; the accent
does the storytelling. Colour is never the only signal: the accent stroke is also
thicker and moves.

**Illustration style.** Vector only, no raster. Animation is SMIL inside the SVG:
five-second loops with 29-71 `<animate>` elements. Critically, every animated
figure ships two groups, `.anim` and `.still`, and a stylesheet inside the file:

```css
@media (prefers-reduced-motion: reduce) { .anim { display: none } .still { display: inline } }
```

The object also carries an `aria-label` that narrates the motion, so the meaning
survives when the animation does not.

**Do.**
- Fixed square aspect for a tiling set.
- A real `.still` fallback, not a paused animation.
- One accent stroke that is both coloured and thicker.
- A narration string for the motion.

**Don't.**
- Do not embed fonts as base64: in the sampled files the base64 font payload is
  the majority of the weight (82-104 KB total, 21-43 KB without fonts).
- Do not use SMIL loops on a page that already runs a shader.
- Do not rely on 5-second loops to communicate sequence: a reader who arrives
  mid-loop has missed the beginning.

### 2.4 What we adopt, and what we reject

| Reference | Adopt | Reject |
|---|---|---|
| Baseten | aggressive cropping; three values plus one accent; dashed connectors that exit the frame; one subject per figure; faint background grid | raster product tiles for diagrams; multi-object scenes |
| Modal | massive negative space; one lit object; CSS-variable-driven ambient motion; transition-level reduced-motion handling | lime glow as a house style; continuous loops near copy; particle fields behind text |
| Fireworks | fixed aspect ratios; a true static fallback; accent differentiated by weight as well as hue; motion narration | SMIL loops inside static files; base64 fonts; colour as the sole state signal |

The combined lesson for Isolate: **the figure is a schematic, the page supplies
the atmosphere, and motion is a single one-shot reveal rather than a loop.**

---

## 3. Unified direction: Isolate schematics

### 3.1 What the system explains

One continuous chain, split across the page's existing slots:

```
event → task → sandbox → validation → approval → pull request
                    ↘ audit trail (every transition is an event)
connectors: control plane → device daemon → vendor, with the key never crossing
```

Each figure owns one link in that chain, and no figure repeats another's job:

| Figure | Explains |
|---|---|
| A1 sandbox boundary | event → task → sandbox, ownership, egress |
| A2 validation gate | the diff gate and the outside-scope diversion |
| A3 approval payload | payload-bound approval, hash, no replay |
| A4 PR handoff | approved branch becoming a pull request |
| A5 audit record | the durable event trail and hash chain |
| A6 lifecycle rail | the whole sequence at once, with the pause |
| A7 device boundary | connectors execute on-device |
| A8 connector call | one typed call, key stays inside |

### 3.2 Projection: orthographic only

The illustration vocabulary is a technical drawing set, not a 3D scene:

- **Plan view** for containment and ownership (A1, A7): boundaries are rectangles
  seen from above, scope is a hatched region, egress is a line that leaves and is
  cut.
- **Elevation view** for gates and decisions (A2, A3, A4): posts, bars, stamps and
  forks read as a front elevation.
- **Rail view** for sequence (A5, A6): one horizontal or vertical spine with
  stations.

Rules:

- No isometric or perspective projection.
- No extrusion, bevels, faux materials, shadows, bloom or grain.
- Depth is expressed by overlap and by dash patterns, never by a third axis.
- Right angles and 45° hatch only. No freehand curves except a single branch fork
  arc in A4 and connector bends drawn as two 90° segments.
- Every figure must remain readable as a wireframe if all colour is removed.

### 3.3 Line grammar

All strokes are square-capped (`stroke-linecap="square"`), mitred
(`stroke-linejoin="miter"`), unfilled, and marked
`vector-effect="non-scaling-stroke"` so the weights below are CSS pixels at any
display size. Implement this with one internal stylesheet per file:

```svg
<style>svg *{vector-effect:non-scaling-stroke}</style>
```

| Role | Width | Colour |
|---|---|---|
| Grid / tick | 1 | `#203541`, decorative only |
| Hairline (construction, hidden edges) | 1 | `#728792` |
| Structure (boundaries, plates, containers) | 1.5 | `#728792`, primary structure `#A8BAC3` |
| Active path (agent / system movement) | 2 | `#0297DE` |
| Negative path (denied, rejected, cut) | 2 | `#F16E72` |
| Gate bar / boundary beam | 2.5 | `#A8BAC3` |

Dash patterns (user units, so they scale gently with the figure):

| Meaning | `stroke-dasharray` |
|---|---|
| Boundary / enclosure | `4 4` |
| Hidden or inactive edge | `2 3` |
| Tick marks, hatch | `1 4` |
| Typed call in transit (A8) | `4 4` |

Fills: effectively none. The write-scope region is drawn with 1 px hatch lines,
not a fill pattern. The single exception is A5's lifted row strip, which may use
a flat `#071016` fill so the raised row separates from the canvas. No gradients,
no opacity below 1 except where a rule explicitly allows it.

### 3.4 Palette behaviour

Neutral-dominant: roughly 80% neutral structure, 20% blue path, and a trace of
orange on the human boundary. The three accents are *roles*, not decoration:

| Role | Token | Hex | Contrast on `#02070A` |
|---|---|---|---|
| Agent / system path, token, typed call | brand | `#0297DE` | 6.25:1 |
| Human-controlled boundary: approval, device-held key | orange | `#FC734D` | 7.42:1 |
| Negative outcome: denied, rejected, cut | danger | `#F16E72` | 6.95:1 |
| Structure, primary | ink-secondary | `#A8BAC3` | 10.10:1 |
| Structure, secondary / labels | ink-muted | `#728792` | 5.39:1 |
| Decorative texture only | line-strong | `#31505F` | 2.36:1 |
| Positive check (A2 only, always labelled) | success | `#4CCB91` | 9.89:1 |

Hard rules:

- **Meaningful strokes are at least `#728792`.** `#31505F`, `#203541` and
  `#14232C` are below 3:1 and may only be used for texture that carries no
  information (background ticks that would not be missed).
- **Orange and blue are never adjacent.** Their mutual contrast is **1.19:1**,
  so a shared edge is invisible. Keep at least 24 user units of neutral geometry
  between an orange element and a blue element, or separate them with a white
  structure line.
- **Blue is never placed on ink.** `#0297DE` on `#EAF2F5` is 2.86:1; orange on
  ink is 2.41:1. Never put an accent line over a light plate.
- **Colour is never the only signal.** Every orange element is also a latch,
  stamp, ring or boundary; every red element is also cut, crossed or terminated.
- Success and danger appear only in A2 and only with a visible label.

Because the page is dark-only, the new assets ship **one theme**. No
`prefers-color-scheme` variants and no `--anatomy-*` custom properties.

### 3.5 Figure, ground and the grid field

- Figures are transparent. There is no card, no frame, no panel fill; the page
  canvas shows through. This preserves the existing `.wf-figure` decision at
  `landing.css:66-69`.
- The grid field is **CSS, not SVG**. `.wf-figure::before` gains a second
  background layer behind the existing radial:

  ```css
  background-image:
    radial-gradient(ellipse 54% 48% at 50% 52%, rgb(2 151 222 / 0.07), transparent 72%),
    linear-gradient(to right, rgb(49 80 95 / 0.22) 1px, transparent 1px),
    linear-gradient(to bottom, rgb(49 80 95 / 0.22) 1px, transparent 1px);
  background-size: 100% 100%, 8px 8px, 8px 8px;
  mask-image: radial-gradient(ellipse 62% 58% at 50% 52%, #000 30%, transparent 78%);
  ```

  Major lines every 64 px are optional and should be omitted until the minor
  field has been reviewed in place. The mask is what keeps the field from
  becoming wallpaper, and it costs nothing because it is not in the SVGs.
- Figures sit on `bg-canvas` (`#02070A`) in capability rows and on `bg-elevated`
  (`#071016`) in the lifecycle section. Strokes must be checked against both:
  `#728792` measures 5.39:1 and 5.11:1 respectively, both fine; `#31505F` fails
  on both and stays decorative.
- No figure may overlap the shader. All figure slots are below the hero, on
  solid sections.

### 3.6 Annotation system

- Monospace, uppercase, `font-family` = the theme's `--font-mono` for inline SVG,
  or the literal stack `ui-monospace, SFMono-Regular, Menlo, monospace` inside
  static files.
- Size 20 user units for primary figures, letter-spacing 1.6 units, fill
  `#A8BAC3`.
- Maximum four labels per primary figure and zero labels per inset.
- Labels are **supplementary**: adjacent page copy must make the figure's
  meaning clear without them. This is what allows the labels to shrink on a
  335 px mobile column without losing information.
- Leader line: 1 px `#728792` ending in a dot of radius 1.5, or no leader at all.
- Corner ticks: four L-shaped ticks at the viewBox corners, 1 px `#203541`, 12
  units long. They are the only decorative element allowed inside a figure.
- Node shapes carry meaning: **square = machine**, **circle = human**,
  **double-ruled rectangle = outcome** (the pull request).

### 3.7 Motion

Exactly one animated figure exists: A6, the lifecycle rail in the lifecycle
section. Everything else is static. The shader remains the only continuous
motion on the page.

Rules:

- Base state is the final frame. Without JavaScript, with JavaScript disabled,
  or before hydration, the rail is fully drawn.
- Animation arms only after hydration, only on first intersection, and only when
  `window.matchMedia("(prefers-reduced-motion: no-preference)").matches`.
  Reuse `useInView` from `apps/web/src/features/landing/components/reveal.tsx`
  (IntersectionObserver, once, `rootMargin: 0px 0px -10% 0px`, threshold 0.12).
- Animate **opacity** and **stroke-dashoffset** only. No transforms on the
  figure, no layout properties, no filters, no `will-change`.
- Sequence: station nodes fade in order (task.submitted → sandbox.provisioned →
  validation.finished → approval.requested → approval.decided → PR outcome),
  then the rail segments draw between them, then the approval gap pulses once
  and settles.
- Total 1.4 s; 110 ms stagger; easing `cubic-bezier(.16, 1, .3, 1)`; the gap
  settle is 220 ms at the end.
- One shot. No loop, no hover response, no scroll-linked scrub, no parallax.
- Under `prefers-reduced-motion: reduce`, no transition and no animation is
  applied at all; the final state is already in the markup.

The implementation shape:

```css
.lifecycle-rail .rail-segment { stroke-dasharray: var(--seg-len); stroke-dashoffset: var(--seg-len); }
.lifecycle-rail.is-armed .rail-segment { transition: stroke-dashoffset 420ms cubic-bezier(.16,1,.3,1) var(--seg-delay); stroke-dashoffset: 0; }
.lifecycle-rail:not(.is-armed) .rail-segment { stroke-dashoffset: 0; }
```

with `.is-armed` added by the component only when both the in-view flag and the
motion query allow it.

### 3.8 Content truth constraints

The figures are product claims. Every element must be traceable to page copy or
to the product's own content module:

- The five event names come from `apps/web/src/features/landing/content.ts`
  (`task.submitted`, `sandbox.provisioned`, `validation.finished`,
  `approval.requested`, `approval.decided`). Do not invent event names.
- Timestamps and details, if used in A5, must be the exact values in
  `content.ts` (`+0.0s`, `+1.2s`, `+42.6s`, `+43.1s`, `+2m 14s`;
  `exit 0 · 214 checks`; `payload 9f3c…`).
- Do not print a person's name in a diagram. `content.ts` contains `maya.chen`,
  but the landing page does not display it; use `reviewer` or `actor`.
- The PR endpoint is the outcome of `approval.decided`, not a sixth event. It is
  drawn as an outcome node and labelled `pull request`, matching the page copy
  "a push or pull request".
- No customer logos, testimonials, benchmark numbers or capability badges that
  are not already in the page copy or `PRODUCT.md`.

---

## 4. Asset list and implementation specs

Eight assets. Six primaries and two insets. All are dark-only, transparent,
unfilled line drawings.

| # | File | Purpose | Canvas | Aspect | Placement | Format | Budget |
|---|---|---|---|---|---|---|---|
| A1 | `sandbox-boundary.svg` | event → task → sandbox, ownership, denied egress | 720×470 | 72:47 | capability row 1, primary | static file | ≤ 8 KB |
| A2 | `validation-gate.svg` | diff gate, outside-scope rejection, exit 0 | 360×240 | 3:2 | capability row 1, inset | static file | ≤ 4 KB |
| A3 | `approval-payload.svg` | payload-bound approval, hash, no replay | 720×470 | 72:47 | capability row 2, primary | static file | ≤ 8 KB |
| A4 | `pr-handoff.svg` | approved branch → pull request | 360×240 | 3:2 | capability row 2, inset | static file | ≤ 4 KB |
| A5 | `audit-record.svg` | five-event trail, hash chain, lifted approval row | 720×470 | 72:47 | capability row 3, primary | static file | ≤ 8 KB |
| A6 | `lifecycle-rail` | the full sequence and the pause | 1000×560 | 25:14 | lifecycle section, wide | **inline React SVG** | ≤ 12 KB JSX |
| A7 | `device-boundary.svg` | connectors run on-device; control plane stores hashes | 960×540 | 16:9 | trust section, primary | static file | ≤ 8 KB |
| A8 | `connector-call.svg` | one typed call; key never crosses the boundary | 360×240 | 3:2 | trust section, inset | static file | ≤ 4 KB |

Total budget: **≤ 56 KB uncompressed**, roughly 18 KB gzip, against 91,877 B
today. Serving path: `apps/web/public/ill/`.

Accessibility treatment for the whole set:

- All eight render with `alt=""` and `aria-hidden="true"` is **not** added: an
  empty `alt` on `<img>` is already removed from the accessibility tree, and
  adding `aria-hidden` to inline SVG would hide it from AT without a text
  alternative. For A6 (inline), use `role="img"` plus `aria-labelledby` pointing
  at a `<title>` and `<desc>`, because inline SVG is exposed by default.
- A6 and the trust figure get an `sr-only` caption that states the sequence and
  the boundary in one sentence. The capability figures do not: their adjacent
  copy already carries the meaning, and the current `alt=""` treatment is
  correct.
- Inline SVG must not be focusable: no `tabindex`, no `<a>`, no `<title>` used as
  a tooltip on the static figures.
- Visible labels are decorative annotations; meaning is never label-only.

### A1 · `sandbox-boundary.svg`

- **Placement.** Capability row 1 primary, replacing `feature="sandbox"` at
  `landing-page.tsx:230`.
- **Canvas.** `viewBox="0 0 720 470"`, intrinsic `width="720" height="470"`.
  Displayed at up to 560 CSS px, so 1 unit ≈ 0.78 px.
- **Composition.** Plan view, left to right along a baseline at `y=260`.
  - Event inlet, x 36-132: a 24×24 square at (72, 248), centred on the baseline,
    with a 2 px blue stub entering from the left edge. Label `event` above at
    (48, 220).
  - Ownership boundary, x 144-456: dashed 4 4 rectangle from (156, 148) to
    (456, 372), stroke 1.5 `#A8BAC3`. Label `task boundary` at (164, 132).
  - Repository stack inside the boundary: four 120×10 bars at x=180,
    y=188/208/228/248, stroke 1 `#728792`; the top bar is 2 px blue to mark the
    checked-out branch.
  - Task plate: 120×64 rectangle at (180, 296), stroke 1.5 `#728792`, with three
    1 px internal rules. Label `task` at (184, 384).
  - Write scope: a 96×96 region at (330, 276) drawn as a 45° hatch, 1 px
    `#728792`, dash 1 4, plus a 1.5 px boundary. Label `write scope` at (330, 258).
  - Validation gate at the boundary's right edge: two 8×96 posts at x=408 and
    x=464, y=212, joined by a 2.5 px bar at y=212, span 56. Label `diff gate`
    at (408, 196).
  - Denied egress: from the sandwich's right edge at (456, 190) a blue 2 px line
    runs to (516, 190), then a red 10×36 bar at x=530 cuts it, and a dashed 2 3
    grey stub continues to a 40×40 internet node at (568, 170). Label
    `egress denied` at (516, 148) in `#F16E72`, 1 px leader to the cut.
  - Budget ruler below: 1 px line from (156, 404) to (456, 404) with ten 1 4
    ticks; label `execution budget` at (156, 428), `#728792`.
  - Corner ticks: four, 1 px `#203541`.
- **Strokes.** Hairlines 1, structure 1.5, active 2, gate bar 2.5. All
  `non-scaling-stroke`.
- **Colour.** Structure `#A8BAC3` / `#728792`; active path `#0297DE`; denial
  `#F16E72` with its label; hatch and corner ticks `#203541` / `#728792`. No
  orange: nothing human-controlled happens in this figure.
- **Labels (4 max).** `event`, `task boundary`, `write scope`, `egress denied`.
  The gate and budget labels are intentionally dropped to stay within four.
- **Must not.** Show a network line that reaches the internet uncut; show writes
  outside the hatch; use perspective on the repository bars.

### A2 · `validation-gate.svg` (inset)

- **Placement.** Capability row 1, inset beneath the primary figure.
- **Canvas.** `viewBox="0 0 360 240"`, intrinsic `360×240`.
- **Composition.** Elevation view.
  - Diff sheet: 96×120 rectangle at (40, 56), stroke 1.5 `#A8BAC3`, with seven
    1 px rules inside, lengths 64/48/72/40/56/68/44, starting x=52 and y=76,
    step 14.
  - Gate: 1.5 px posts at x=188 and x=236, y=64 to y=176, joined by a 2.5 px
    bar at y=64.
  - In-scope path: blue 2 px from (136, 116) to (280, 116), through the gate.
    Terminates at a 20×20 square at (280, 106) containing a 2 px tick.
    Label `exit 0` at (272, 148).
  - Outside-scope diversion: from (188, 128) a 2 px red line runs up to
    (212, 60) then to a 14×14 square at (205, 38) with a 2 px cross. Label
    `outside scope` at (150, 24).
- **Colour.** Structure `#A8BAC3`/`#728792`, blue active path, red diversion,
  `#4CCB91` only on the tick, which is also labelled `exit 0`.
- **Budget.** ≤ 4 KB. Fewer than 40 elements.

### A3 · `approval-payload.svg`

- **Placement.** Capability row 2 primary, replacing `feature="approval"` at
  `landing-page.tsx:243`.
- **Canvas.** `viewBox="0 0 720 470"`, intrinsic `720×470`.
- **Composition.** Elevation view, centred on a payload envelope.
  - Envelope: 240×168 rectangle at (56, 148), stroke 1.5 `#A8BAC3`; a 1.5 px
    diagonal flap from the top corners to (176, 232).
  - Hash strip: eight 12×12 squares from x=72, y=292, step 20, 1 px `#728792`.
    Label `payload 9f3c…` at (72, 332).
  - Orange latch: 28×12 rectangle at (296, 232) and a 2 px orange bracket 8
    units outside the envelope's right edge, y 208-264. This is the only orange
    on the payload, and it is separated from every blue element by at least 32
    units of neutral geometry.
  - Reviewer: circle of r=24 at (452, 128), 2 px `#FC734D`, with a centred dot of
    r=3. Label `reviewer` at (428, 88). Circle = human.
  - Decision fork at x=560: blue 2 px from (536, 216) to (620, 168) ending in a
    16×16 square labelled `approved`; red 2 px from (536, 240) down to (620, 320)
    ending in a 16×16 square with a cross, labelled `rejected`.
  - No-replay cut: a 1.5 px loop leaves the envelope at (296, 316), arcs to
    (336, 300) and returns to (296, 284); a 2 px red slash crosses it at
    (322, 308). Label `no replay` at (300, 356) in `#F16E72`.
- **Colour.** Orange = latch, reviewer ring, bracket. Blue = approved path and
  the checked-out payload route. Red = rejection and the replay cut. Never place
  the orange latch adjacent to the blue decision line.
- **Labels (4 max).** `payload 9f3c…`, `reviewer`, `no replay`, `approved`.
- **Must not.** Show approval as a free-standing check mark detached from the
  payload; show a replay path that succeeds.

### A4 · `pr-handoff.svg` (inset)

- **Placement.** Capability row 2, inset beneath the primary figure.
- **Canvas.** `viewBox="0 0 360 240"`, intrinsic `360×240`.
- **Composition.**
  - Trunk: 2 px `#728792` vertical at x=56 from y=24 to y=216.
  - Branch: 2 px blue from (56, 152) curving to (128, 104) then horizontally to
    the PR body.
  - PR body: 112×72 rectangle at (136, 68), stroke 1.5 `#A8BAC3`, with three
    1 px rules inside at y=92/108/124, widths 80/64/72.
  - Merge line: dashed 4 4 `#728792` from (248, 104) back to the trunk at
    (56, 104).
  - Orange stamp: 22×22 square at (272, 40) rotated 0°, 2 px `#FC734D`, with an
    inner 1 px diagonal. Label `approved` at (258, 20).
  - Hash square: 16×16 at (136, 168), 1.5 px `#728792`, with an inner 6×6
    square. Label `9f3c` at (160, 182).
- **Colour.** Orange only on the stamp, kept ≥ 24 units from the blue branch.
- **Budget.** ≤ 4 KB.

### A5 · `audit-record.svg`

- **Placement.** Capability row 3 primary, replacing `feature="record"` at
  `landing-page.tsx:249`.
- **Canvas.** `viewBox="0 0 720 470"`, intrinsic `720×470`.
- **Composition.** Rail view, vertical.
  - Spine: 2 px `#728792` at x=72 from y=48 to y=424. The segment above
    `approval.decided` is blue 2 px; below it is neutral.
  - Five event rows at y = 88, 156, 224, 292, 360. Each row has a 10×10 square
    node on the spine (2 px), an event name in mono at x=100, and an offset
    right-aligned at x=660.
  - Event names and offsets exactly:
    `task.submitted` `+0.0s`; `sandbox.provisioned` `+1.2s`;
    `validation.finished` `+42.6s`; `approval.requested` `+43.1s`;
    `approval.decided` `+2m 14s`.
  - Lifted row: `approval.requested` (y=292) is drawn on a 1.5 px `#203541`
    strip from (88, 274) to (676, 310), background `#071016`, offset 12 units to
    the right of the other rows. This is the row the reviewer acts on.
  - Hash chain: a column of five 12×12 squares at x=600, y=82/150/218/286/354,
    joined by 1 px vertical links. Each square has a 1 px inner cross. These
    connect to the event names with 1 px `#728792` leaders.
  - Time ruler: 1 px `#203541` line from (100, 44) to (668, 44), 1 4 ticks every
    48 units.
  - Orange appears only on the `approval.decided` node (circle, r=7, 2 px orange)
    because that transition is human. The `approval.requested` node stays a
    square (machine) with an orange 1.5 px ring at r=10 to mark the pause.
- **Colour.** Mostly `#728792`/`#A8BAC3`; blue on the spine above the decision;
  orange only on the human node and the pause ring, separated by ≥ 24 units from
  blue.
- **Labels (4 max).** The five event names are content, not annotation labels;
  the four-label cap applies to non-content annotations, of which this figure has
  none.
- **Must not.** Imply a log file or a text dump; the ledger is structured rows on
  a spine. Do not reorder events.

### A6 · `lifecycle-rail` (inline React SVG)

- **Placement.** `components/lifecycle-section.tsx:30`, replacing
  `<FeatureVisual feature="lifecycle" />`. Rendered by a new
  `components/lifecycle-rail.tsx`.
- **Canvas.** `viewBox="0 0 1000 560"`, `role="img"`,
  `aria-labelledby="lifecycle-rail-title lifecycle-rail-desc"`, with an internal
  `<title id="lifecycle-rail-title">Lifecycle of one task</title>` and a
  `<desc id="lifecycle-rail-desc">` naming all six stations and the pause at
  approval. The figure is not focusable.
- **Composition.** Rail view, horizontal, rail at y=280.
  - Stations at x = 90, 250, 410, 570, 730, 890.
    1. `task.submitted` — square 16, machine.
    2. `sandbox.provisioned` — square 16, machine.
    3. `validation.finished` — square 16, machine.
    4. `approval.requested` — square 16, machine, orange 1.5 px ring at r=14.
    5. `approval.decided` — circle r=14, 2 px orange, human.
    6. `pull request` — double-ruled rectangle 32×32, 2 px `#A8BAC3`, outcome.
  - Rail: 2 px blue from x=90 to x=706 (stops before approval); a 48-unit gap
    with a dashed 4 4 `#728792` bridge at y=280 and a mono label `pause` at
    (702, 246) in `#FC734D`; then 1.5 px `#A8BAC3` from x=754 to x=890.
  - Below each station: event name in mono at y=332, size 20, `#A8BAC3`;
    stage name in mono uppercase at y=360, size 16, `#728792`. Four labels per
    row maximum is not a constraint here because these are content, matching the
    ordered list below the figure.
  - Above the rail: a 1 px time ruler at y=160 from x=90 to x=890 with 1 4 ticks
    every 40 units, and a single orange `approval` bracket spanning x 546-754,
    y 176-196, labelled `human decision` at (560, 152).
  - Corner ticks: four, 1 px `#203541`.
- **Motion.** Exactly as §3.7. Segments reveal in order; the approval gap bridge
  fades last. `.rail-segment` uses `--seg-len` and `--seg-delay` per segment.
  The base DOM has `stroke-dashoffset: 0`; only the armed class sets a non-zero
  offset first, then transitions to zero. Reduced motion never adds the armed
  class.
- **Budget.** ≤ 12 KB of JSX including the title and desc. Six stations, about
  ten segments, no icons.
- **Must not.** Show the PR as a sixth named event; label the gap `waiting for
  approval` in a way that implies a timeout; loop the animation.

### A7 · `device-boundary.svg`

- **Placement.** Trust section primary, replacing the drawing half of
  `TrustDiagram` in `components/trust-section.tsx` (the DOM diagram at 12-79,
  rendered at 98). The three existing visible text blocks must be preserved
  verbatim as a legend; see §6 Phase 2.
- **Canvas.** `viewBox="0 0 960 540"`, intrinsic `960×540`.
- **Composition.** Plan view, two enclosures.
  - Device enclosure: dashed 4 4 rectangle from (48, 92) to (448, 452), stroke
    1.5 `#A8BAC3`, with rounded 0 corners. Label `your device` at (64, 72).
  - Vendor keychain module: 140×88 rectangle at (88, 148), stroke 1.5 `#728792`,
    containing a key glyph (circle r=10 at (120, 184), 2 px shaft to (168, 184),
    two 2 px teeth down). Label `keychain` at (96, 132).
  - Device daemon module: 168×96 rectangle at (88, 300), stroke 1.5 `#728792`,
    with three 1 px internal rules. Label `device daemon` at (96, 284).
  - Key path: 2 px orange from the keychain's right edge (228, 192) to the
    daemon's top edge (196, 300), with a 2 px orange terminal bar 8 units inside
    the device boundary at x=424, y 180-260. Label `key never leaves` at
    (260, 236) in `#FC734D`.
  - Token path: 2 px blue from the daemon's right edge (256, 348) to (424, 348),
    crossing the device boundary at x=448 with a 12×12 blue-bordered badge,
    continuing to the control plane's left edge at (600, 348). Label `token` at
    (470, 326) in `#0297DE`.
  - Control plane: 280×200 rectangle at (600, 148), stroke 1.5 `#A8BAC3`, with
    three mono rows at x=624, y=300/326/352: `token_hash`, `connector_id`,
    `scopes`. Label `control plane` at (600, 128).
  - Vendor API: 160×64 rectangle at (600, 420), stroke 1.5 `#728792`, label
    `vendor api` at (624, 456). A 2 px blue path from the daemon runs outside
    the device boundary at y=420 to the vendor node.
- **Colour.** Orange only inside the device. Blue crosses the boundary. The two
  never touch: the orange terminal bar at x=424 and the blue token line at y=348
  are separated by 64 units of neutral geometry.
- **Labels (4 max).** `your device`, `key never leaves`, `token`, `control plane`.
- **Must not.** Draw the key path crossing the boundary, even dashed; imply the
  control plane stores a vendor key.

### A8 · `connector-call.svg` (inset)

- **Placement.** Trust section, inset beneath the primary figure.
- **Canvas.** `viewBox="0 0 360 240"`, intrinsic `360×240`.
- **Composition.**
  - Device boundary: dashed 4 4 rectangle from (24, 40) to (200, 208), 1.5 px
    `#A8BAC3`.
  - Control plane node: 64×40 rectangle at (272, 88), 1.5 px `#728792`, label
    `control plane` at (276, 76).
  - Typed call: blue 2 px dashed 4 4 from (272, 108) to the daemon's right edge
    at (160, 108); 12×12 badge at the boundary crossing x=200.
  - Daemon: 88×56 rectangle at (72, 80), 1.5 px `#728792`, label `daemon` at
    (80, 68).
  - Key glyph inside the daemon at (88, 100), 2 px orange, with a 12-unit orange
    stub that stops 8 units short of the boundary. Label `key` at (88, 124).
  - Vendor call: blue 2 px from the daemon's bottom (116, 136) down to y=184,
    then right to a 60×36 vendor node at (272, 166), label `vendor` at (284, 180).
- **Colour.** Orange confined to the key glyph and its stub; blue on both call
  legs. The nearest approach of orange and blue is 24 units.
- **Labels (4 max).** `control plane`, `daemon`, `key`, `vendor`.

---

## 5. Accessibility and performance constraints

### 5.1 Accessibility

- **Decorative treatment.** A1-A5, A7 and A8 are decorative: the adjacent copy
  carries the meaning, so `<img alt="">` is correct and matches today's
  `FeatureVisual`. Empty `alt` removes them from the accessibility tree; do not
  add `aria-hidden` on top.
- **Meaningful inline figure.** A6 is exposed to assistive technology because it
  is inline. Give it `role="img"`, `aria-labelledby` pointing at `<title>` and
  `<desc>`, and a one-sentence `<desc>`:
  "A task is submitted, a sandbox is provisioned, validation finishes, a person
  approves the exact payload, and a pull request is opened. The rail pauses
  between the approval request and the decision."
- **Captions.** The lifecycle figure and the trust figure get an `sr-only`
  `<figcaption>` that states the same sequence or boundary in prose. The
  capability figures do not.
- **Contrast.** Every meaningful stroke is ≥ 3:1 against its actual surface.
  `#728792` is the floor (5.39:1 on canvas, 5.11:1 on elevated, 4.96:1 on
  `surface`). `#31505F` (2.36:1 on canvas), `#203541` (1.59:1) and `#14232C`
  (1.26:1) are texture only. Accent pairs that fail against each other (orange/blue 1.19:1,
  blue/ink 2.86:1, orange/ink 2.41:1) must never share an edge.
- **Non-colour redundancy.** Every state has a shape: square = machine,
  circle = human, cross = rejected, tick = passed, dashed = boundary, cut =
  denied. A grayscale screenshot must still tell the story.
- **Focus.** No inline SVG element is focusable; no `tabindex`; no interactive
  shapes. A6 is a static image.
- **Motion.** Reduced motion yields the final frame with no transition and no
  animation. The reveal never gates opacity on the figure's own content, so
  content is visible before hydration.
- **Zoom and reflow.** Figures scale with the container (`width: 100%`,
  `height: auto`) and never introduce horizontal scroll at 320 px. The grid
  field uses `mask-image` with a `-webkit-mask-image` fallback; if masks are
  unsupported the field degrades to the existing radial only.
- **Text in images.** Static figures contain only short mono annotations that are
  supplementary. No body copy is rasterised or vectorised into a figure.

### 5.2 Performance

Per-asset budgets and hard bans:

- ≤ 8 KB per primary, ≤ 4 KB per inset, ≤ 12 KB for A6. Total ≤ 56 KB.
- ≤ 80 elements and ≤ 24 drawn paths per figure.
- Banned: `<image>`, `<foreignObject>`, `<filter>`, `@font-face`, base64 payloads,
  `<script>`, `<animate>`, external references, embedded rasters, gradients.
- One internal `<style>` block per static file, max 120 bytes, for
  `vector-effect` and the mono font stack.
- No `id` collisions: static files use no `id`s; A6 prefixes all `id`s with
  `lifecycle-rail-`.
- Width and height attributes are mandatory on every `<img>` to prevent CLS.
  A1, A3, A5 use 720×470; A2, A4, A8 use 360×240; A7 uses 960×540.
- Below-the-fold figures keep `loading="lazy" decoding="async"`. A6 is inline and
  therefore not lazy; its markup is static and small.
- The grid field is three CSS gradients plus a mask on one pseudo-element; it
  adds no requests and no raster layers. It must sit on `.wf-figure::before`,
  which is already `pointer-events: none`.
- No continuous animation is added, so the page keeps exactly one always-on
  surface (the shader) and one one-shot reveal per lifecycle view.
- Measure with the production build: total transferred JS/CSS for the landing
  route must not increase beyond the removed `feature-visual` map, and LCP must
  not regress. Record Lighthouse mobile scores before and after in the Phase 4
  record.

---

## 6. Phased implementation plan

Constraints: sections keep their order, copy, containers and anchors; no
non-landing file changes except the `project/` docs named in Phase 0.

### Phase 0 — docs amendment (this commit's successor)

- Amend `project/design.md` §8 line 276 and §14 line 503 to name the
  orthographic schematic system and to scope isometric guidance to dashboard
  empty states only.
- Append a §18 implementation record with the asset table and the measured
  before/after sizes.
- No code.

### Phase 1 — assets and primitives

- Create `apps/web/public/ill/` with A1-A5, A7, A8 (seven static files).
- Create `apps/web/src/features/landing/components/landing-figure.tsx`:
  a small component that maps an asset key to `{ src, width, height }` and renders
  `<figure className="wf-figure"><img alt="" ... /></figure>`, with an optional
  `inset` asset rendered as a second `<img className="wf-figure-inset">` inside
  the same figure.
- Create `apps/web/src/features/landing/components/lifecycle-rail.tsx` with A6,
  the `useInView` gate and the reduced-motion query.
- Add `.wf-figure-inset` and the grid-field layers to
  `apps/web/src/features/landing/landing.css`.
- Add a colocated test `apps/web/src/features/landing/components/illustrations.test.ts`
  that reads the SVG files from disk and asserts: no banned element or attribute,
  no `<image>`, no base64, no `@font-face`, byte budget per file, `viewBox` and
  intrinsic `width`/`height` match the manifest, and every stroke colour is in the
  approved token set. This test is the guard against regressions when someone
  edits an asset by hand.
- Do not change any section component yet.

### Phase 2 — slot swap

Only these landing files change:

- `components/feature-visual.tsx`: replace the `/iso` map with the `/ill` map, or
  delete it and have callers use `LandingFigure`. Prefer keeping the file as a
  thin re-export so `landing-page.tsx` and `lifecycle-section.tsx` diff stays
  small.
- `landing-page.tsx`: swap the three `<FeatureVisual feature="...">` calls at
  lines 230, 243 and 249 to the new keys and pass the insets. No other change to
  this file.
- `components/lifecycle-section.tsx`: line 30 becomes `<LifecycleRail />`.
- `components/trust-section.tsx`: replace the inner drawing area of
  `TrustDiagram` with `<LandingFigure asset="device-boundary" inset="connector-call" />`,
  keep the three visible text blocks (Vendor keychain, Device daemon, Control
  plane) and their descriptions verbatim as a legend below or beside the figure,
  and keep the footnote "No vendor secret is stored server-side, in logs, or in
  the sandbox." Keep the `sr-only` caption.
- `landing.css`: adjust `.wf-figure` spacing only if the new aspect ratios need
  it. No new colour tokens.

All other files are out of scope, specifically:
`apps/web/src/routes/index.tsx`, `apps/web/src/styles.css`,
`apps/web/src/components/brand/**`, `apps/web/src/components/ui/**`, any
dashboard feature, any package, root config, lockfiles, and `.env*`.

### Phase 3 — motion, accessibility, performance verification

- Verify the rail's no-JS state is the final frame.
- Verify reduced motion by emulation: no transition, no dash offset, no fade.
- Verify keyboard: no new tab stops.
- Verify the grayscale test: screenshot each figure with saturation 0 and confirm
  the story survives.
- Verify contrast with a colour picker at the rendered size, not from the hex
  alone; sub-pixel strokes have already been ruled out by `non-scaling-stroke`,
  but check the actual pixels.
- Check CLS on load, LCP, and total bytes at 1440 and 390 widths.

### Phase 4 — retire the old set and record

- Delete `apps/web/public/iso/` (91,877 B) once no reference remains.
- Append the measured results to the `project/design.md` §18 record: per-file
  bytes, gzip total, contrast notes, and any deviation from this spec.
- Run the report gates.

### Gates before each report

- `bunx biome check apps/web/src/features/landing` (scoped; no repo-wide run)
- `bunx tsc --noEmit -p apps/web/tsconfig.json` (project typecheck)
- `bun test apps/web/src/features/landing` twice for determinism
- Record the exact command output and commit hash in the stop report.

---

## 7. Acceptance checklist

The redesign is done when all of the following are true:

- [ ] No isometric, perspective or extruded geometry remains on the landing page.
- [ ] Eight assets exist at the specified paths, canvases and budgets, and the
      total is under 56 KB.
- [ ] `/iso` has no references and the directory is deleted.
- [ ] Every meaningful stroke measures at least 3:1 against its real surface.
- [ ] Orange and blue never share an edge; a 24-unit neutral gutter is measured
      in A3, A5, A7 and A8.
- [ ] A grayscale screenshot of each figure still communicates its state.
- [ ] No figure is focusable; A6 has a title and desc; A6 and trust have
      `sr-only` captions.
- [ ] The lifecycle rail is complete without JavaScript and with reduced motion.
- [ ] The rail animates exactly once, 1.4 s, and never loops.
- [ ] No SVG contains a raster, filter, font, base64 payload, script or SMIL.
- [ ] Every `<img>` has width and height, and below-the-fold figures are lazy.
- [ ] Section order, copy, anchors (`#capabilities`, `#lifecycle`, `#trust`) and
      the route file are unchanged.
- [ ] `project/design.md` no longer mandates isometric landing illustrations.

---

## Appendix A — sourced references

Baseten:
- <https://www.baseten.co/>
- <https://www.baseten.co/products/sandboxes/>
- <https://www.datocms-assets.com/104802/1793991385-baseten-sandboxes-01.png>
- <https://www.datocms-assets.com/104802/1793317611-baseten-ctalarge-01.png>
- <https://www.datocms-assets.com/104802/1793282998-baseten-nav-04.png>

Modal:
- <https://modal.com/>
- <https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/modal-com/full.1440.webp?v=1777662088>
- shipped `WorkloadAnimation.C9weL7CL.css` (7,730 B)

Fireworks:
- <https://fireworks.ai/>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/7bf4f8defdb7474e26f24b824b14097605e1df11-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/020a4975048bc6ae775727b618af9ef121fe183d-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/24170776adcefd472cbde0cd67f4ea632f48d9b3-1080x1080.svg>
- <https://cdn.sanity.io/images/pv37i0yn/horizon/6b512b4af5b4557e7786b1f24c452e4453dc9405-1080x1080.svg>

Supporting composition references:
- <https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/netlify-com/full.1440.webp?v=1779110519>
- <https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/unkey-com/full.1440.webp?v=1780406460>

## Appendix B — measured contrast against landing surfaces

Ratios computed with the WCAG 2.x relative-luminance formula.
Canvas `#02070A`, elevated `#071016`, surface `#0A141B`.

| Colour | Token | On canvas | On elevated | On surface | Allowed use |
|---|---|---:|---:|---:|---|
| `#EAF2F5` | ink | 17.85 | 16.92 | 16.40 | text, primary marks |
| `#A8BAC3` | ink-secondary | 10.10 | 9.57 | 9.28 | structure, labels |
| `#728792` | ink-muted | 5.39 | 5.11 | 4.96 | structure floor, labels |
| `#31505F` | line-strong | 2.36 | 2.23 | 2.16 | decorative texture only |
| `#203541` | line | 1.59 | 1.50 | 1.46 | decorative ticks only |
| `#14232C` | line-subtle | 1.26 | 1.19 | 1.16 | decorative only |
| `#0297DE` | brand | 6.25 | 5.92 | 5.74 | active path, token |
| `#FC734D` | orange | 7.42 | 7.03 | 6.82 | human boundary |
| `#4CCB91` | success | 9.89 | 9.37 | 9.09 | pass, always labelled |
| `#F2B45F` | warning | 11.06 | 10.48 | 10.16 | not used on landing |
| `#F16E72` | danger | 6.95 | 6.59 | 6.39 | denied, rejected, cut |
| `#63BCE8` | info | 9.53 | 9.03 | 8.76 | not used on landing |

Pair constraints:

| Pair | Ratio | Consequence |
|---|---:|---|
| orange on brand | 1.19 | never adjacent |
| brand on ink | 2.86 | never place accent on light plates |
| orange on ink | 2.41 | never place accent on light plates |
