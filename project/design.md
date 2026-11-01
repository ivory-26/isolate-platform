# Isolate — Design System & Product UI Direction

> **Status:** Initial product design specification  
> **Scope:** Marketing landing page and authenticated web control plane  
> **Priority:** The dashboard is the primary product surface and receives the majority of design effort.  
> **Audience:** Product engineers, frontend developers, design contributors, and coding agents.

This document defines Isolate's visual language, dashboard information architecture, shared components, interaction patterns, and implementation constraints. It is intended to evolve as the product is built. Update this file when a reusable design decision changes; do not create parallel, undocumented design systems.

---

## 1. Product design intent

Isolate is an autonomous DevSecOps control plane, not a chat wrapper. It lets developers configure work, submit engineering tasks, observe agent execution, inspect policy decisions, approve sensitive actions, and review resulting changes.

The interface should feel like a focused developer operations console: technically credible, information-dense without clutter, calm under failure, and fast to scan. A developer should understand what is running, what needs attention, what is waiting for approval, and what action is available without searching through decorative UI.

### Design principles

1. **Dashboard-first.** Prioritize the signed-in application shell, overview, runs, run details, approvals, workflow authoring, and repository management ahead of marketing-page polish.
2. **Operational clarity.** Status, ownership, current stage, next action, risk, and provenance must be immediately legible.
3. **Dark, restrained, purposeful.** Midnight Black anchors the UI. Electric Blue marks primary interaction and active focus. Cantaloupe Orange is a limited secondary accent.
4. **Layered depth, not card soup.** Use page regions, separators, and a small number of distinct surfaces. Do not place every field inside its own card.
5. **Motion communicates state.** Animations should explain transitions and feedback, not compete with data or delay action.
6. **Trust is part of the design.** Approval scope, execution boundaries, policy denials, audit history, and sandbox state should be explicit and inspectable.
7. **Consistency over one-off styling.** Build shared tokens and primitives before styling individual routes.
8. **Truthful UI.** Never imply that an agent is running, a provider is healthy, a sandbox exists, or a task has completed unless the server reports that fact.

## 2. Visual reference roles

Use the supplied reference archive and websites as design inputs, not as a mandate to reproduce their pages.

| Reference | Borrow | Avoid copying |
|---|---|---|
| [Fireworks.ai](https://fireworks.ai) | Typography character: expressive display grotesk, editorial heading hierarchy, technical mono accents | Its light/warm palette as the dashboard foundation |
| [Modal](https://modal.com) | Isometric diagrams, infrastructure illustrations, shader/gradient treatment, technical visual storytelling | Large decorative imagery inside dense operational views |
| [Baseten](https://baseten.co) and [Baseten app](https://app.baseten.co) | Spacing discipline, border treatment, component proportions, restrained system UI, compact technical layouts | Its green-led brand palette as Isolate's primary palette |
| [React Bits GradientASCII](https://reactbits.dev) | Existing landing-page background shader, using the exact supplied configuration | Animated shader behind dashboard tables, logs, or forms |
| [Reicon](https://reicon.dev/docs) | Duotone icon language, selected using the Reicon MCP integration | Mixing unrelated icon families or emoji |
| Emil Kowalski motion skills | Practical motion principles, transitions, and micro-interactions | Motion for its own sake |

### Asset inventory and usage rights

The supplied archive includes Fireworks CSS and SVG references, Modal CSS plus SVG/raster assets (including `block.svg`), and Baseten marketing/app CSS plus SVG assets. The CSS font-family declarations identify these reference families:

- **Fireworks:** `Monument Grotesk`, `Monument Grotesk Mono`, `Sharp Serif Text`.
- **Baseten marketing:** `NeueAlteGrotesk`, `Chivo Mono`.
- **Baseten app:** `Inter`.
- **Modal CSS variants:** `ABC Diatype` with `DM Mono`, and `Inter Variable` with `Fira Mono`.

These are names observed in the supplied CSS, not a grant to redistribute or embed font files. The asset archives include copyright notices stating that extracted assets are for reference/personal study and that usage rights must be verified. Use reference assets to guide original work. Before shipping any extracted SVG, image, or font in a public or commercial build, verify its license or obtain permission. Prefer newly authored SVGs or properly licensed equivalents when rights are unclear.

## 3. Brand foundation

### Core palette

These three colors are fixed brand anchors and must remain consistent across the landing page and dashboard.

| Token | Hex | Primary role |
|---|---|---|
| Midnight Black | `#02070A` | Main page background and dark canvas |
| Electric Blue | `#0297DE` | Primary actions, active navigation, focus, links, selected states |
| Cantaloupe Orange | `#FC734D` | Secondary accent, attention, and selected highlights |

### Extended dark UI palette

The following values are starting tokens. Validate them against real page compositions and contrast checks before treating them as final.

| Token | Suggested value | Usage |
|---|---|---|
| `--color-bg` | `#02070A` | App background |
| `--color-bg-elevated` | `#071016` | Raised page regions |
| `--color-surface` | `#0A141B` | Panels, menus, table header bands |
| `--color-surface-raised` | `#0E1B23` | Popovers, dialogs, selected surfaces |
| `--color-surface-hover` | `#10232D` | Hovered rows and controls |
| `--color-border-subtle` | `#14232C` | Low-emphasis dividers |
| `--color-border` | `#203541` | Standard panel/control borders |
| `--color-border-strong` | `#31505F` | Emphasized boundaries |
| `--color-text-primary` | `#EAF2F5` | Main text |
| `--color-text-secondary` | `#A8BAC3` | Supporting copy |
| `--color-text-muted` | `#728792` | Metadata, timestamps, hints |
| `--color-electric-blue` | `#0297DE` | Brand/action |
| `--color-cantaloupe` | `#FC734D` | Brand accent |
| `--color-success` | `#4CCB91` | Successful/healthy state |
| `--color-warning` | `#F2B45F` | Warning / needs attention |
| `--color-danger` | `#F16E72` | Failed / destructive |
| `--color-info` | `#63BCE8` | Informational state |

Semantic colors are not interchangeable with brand accents. Use success, warning, danger, and info only where their meaning applies. Always pair state color with a text label and, where useful, an icon.

### Color application rules

- Keep the majority of the dashboard on near-black and deep blue-black surfaces.
- Concentrate Electric Blue on primary actions, selected navigation, links, keyboard focus, active workflow nodes, and selected controls.
- Cantaloupe Orange is an accent, not a second primary action color. Reserve it for selected callouts, review attention, usage emphasis, or warning-adjacent highlights.
- Do not use brand colors to decorate every panel. Neutral surfaces should dominate.
- Avoid neon glows around every control. A restrained glow may be used for a focused or active element, or one small brand moment.
- Do not communicate status by color alone.
- Verify text and control contrast against the actual rendered surface; muted aesthetics are not a reason to sacrifice readability.

## 4. Typography

### Recommended hierarchy

Use the Fireworks typography direction for visual personality while keeping the dashboard's dense information legible.

| Role | Preferred reference face | Fallback direction | Usage |
|---|---|---|---|
| Display / major page headings | Monument Grotesk | Licensed grotesk with similar proportions | Landing hero, onboarding, top-level page title |
| UI / body | Inter | Inter Variable or system sans | Dashboard, forms, tables, navigation |
| Technical / data | Monument Grotesk Mono | Chivo Mono, DM Mono, Fira Mono | IDs, branches, model names, timestamps, logs, code |
| Editorial accent | Sharp Serif Text | Licensed restrained serif | Rare landing-page emphasis only; not dashboard labels |

Suggested tokens:

```css
:root {
  --font-display: "Monument Grotesk", "Inter", ui-sans-serif, sans-serif;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Monument Grotesk Mono", "Chivo Mono", "DM Mono", ui-monospace, monospace;

  --text-xs: 0.75rem;      /* 12px */
  --text-sm: 0.8125rem;   /* 13px */
  --text-base: 0.875rem;  /* 14px dashboard default */
  --text-md: 1rem;        /* 16px */
  --text-lg: 1.125rem;    /* 18px */
  --text-xl: 1.375rem;    /* 22px */
  --text-2xl: 1.75rem;    /* 28px */
  --text-3xl: 2.25rem;    /* 36px */
}
```

Dashboard guidance:

- Default data-dense UI body size: 14px; use 13px for secondary metadata only when still comfortably readable.
- Primary page headings: 24–28px. Avoid oversized marketing-style headings inside the app.
- Table headers: 11–12px, medium weight, modest tracking, adequate contrast.
- IDs, hashes, code, and timestamps use mono; ordinary prose stays sans-serif.
- Use tabular numerals for metrics, counters, durations, token and cost values.
- Establish hierarchy with weight and spacing before adding color.
- Avoid excessive uppercase. Reserve it for compact overlines or table column labels.
- Do not load multiple large font families when a small subset covers the required hierarchy.

## 5. Layout and spacing

Borrow Baseten's spacing discipline and compact component proportions, then adapt them to Isolate's dark surfaces.

### Spacing scale

Use a 4px base grid.

| Token | Value | Common use |
|---|---:|---|
| `space-1` | 4px | Icon/text gap, tiny adjustments |
| `space-2` | 8px | Inline control gap |
| `space-3` | 12px | Compact component padding |
| `space-4` | 16px | Standard component padding |
| `space-5` | 20px | Section gaps |
| `space-6` | 24px | Card/panel padding |
| `space-8` | 32px | Major section separation |
| `space-10` | 40px | Page-level grouping |
| `space-12` | 48px | Large layout separation |
| `space-16` | 64px | Landing-page spacing |

### Application shell

The authenticated dashboard should have a persistent application shell:

- **Left navigation:** fixed-width, collapsible, with product mark, primary destinations, workspace/repository context, and settings/account affordances.
- **Main content:** flexible width with a consistent page-title/action row followed by task-specific content.
- **Top bar:** compact breadcrumb/context, global search or command entry, notifications/activity, and workspace/user menu.
- **Optional contextual panel:** use only where it adds value (run details, properties inspector, approval context). Do not force a permanent third column.
- Keep content gutters and page-title positions consistent across routes.

Suggested desktop dimensions:

- Expanded sidebar: 232–256px.
- Collapsed rail: 64–72px.
- Top bar: 56–64px.
- Main content horizontal padding: 28–36px.
- Typical panel padding: 16–24px.
- Typical table row: 48–56px, with a compact mode for dense logs.

Responsive behavior:

- At tablet widths, collapse the sidebar to an icon rail and move secondary actions into menus.
- At mobile widths, use a navigation drawer and stack panels. Preserve high-value actions and status.
- Do not attempt to render wide workflow canvases or complex tables as tiny desktop layouts. Provide horizontal scrolling, a column chooser, or a dedicated detail view as appropriate.
- Keep the dashboard usable at 1280px desktop width; do not optimize only for ultra-wide monitors.

## 6. Borders, surfaces, elevation, and radius

Baseten is the reference for disciplined borders and proportions.

- Prefer 1px borders with subtle contrast over heavy shadows.
- Use borders to define grouping and hierarchy, not to outline every nested element.
- Panels generally use 8–12px corner radii; controls use 6–9px; fully rounded pills are reserved for compact chips/tags.
- Avoid excessive glassmorphism. Translucency may be used for overlays or a command palette, not as the default panel treatment.
- Shadows are soft, low-opacity, and reserved for overlays that need elevation.
- Avoid stacking a border, glow, and shadow on one component.
- Selected items may use a faint Electric Blue tint and a clearer border; do not fill whole panels with saturated blue.

Suggested tokens:

```css
:root {
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --border-width: 1px;

  --shadow-menu: 0 12px 32px rgb(0 0 0 / 0.38);
  --shadow-dialog: 0 24px 72px rgb(0 0 0 / 0.48);
  --focus-ring: 0 0 0 2px #02070A, 0 0 0 4px #0297DE;
}
```

## 7. Iconography

Use [Reicon](https://reicon.dev/docs) in the **duotone** style. Fetch and select icons through the configured Reicon MCP integration rather than manually inventing SVGs or substituting emoji.

- Use one consistent duotone weight and optical size within a screen.
- Standard UI icons: 16px; navigation/common actions: 18px; empty-state or feature illustrations: 24–32px.
- Establish consistent semantic icons for run/play, pause, stop, retry, approve, deny, inspect, branch, repository, policy/shield, terminal/logs, workflow, and settings.
- Pair icons with text for important or destructive actions.
- Keep secondary duotone layers muted but visible on dark surfaces.
- Do not mix Reicon duotone with emoji, unrelated outline icon packs, or ad hoc Unicode symbols.
- If the MCP integration is unavailable, use an existing project icon abstraction as a temporary fallback and document it. Do not casually add a second icon library.

## 8. Illustration and background system

### Landing page: existing GradientASCII shader

The landing page already has a React Bits `GradientASCII` shader. Preserve the supplied configuration as the canonical landing background:

```tsx
import GradientASCII from "./GradientASCII";

<div style={{ position: "fixed", inset: 0, zIndex: -1 }}>
  <GradientASCII
    colors={["#02070a", "#0297de", "#fc734d", "#b097f7"]}
    shape="horizon"
    characters=" .·•●"
    cellSize={12}
    density={0.4}
    glyphOpacity={0.63}
    gradientOpacity={0.91}
    glow={0.3}
    flicker={0.17}
    softness={0.43}
    flow={0.4}
  />
</div>
```

Install with the existing project workflow:

```bash
bunx --bun shadcn@latest add @react-bits/GradientASCII-TS-TW
```

Implementation constraints:

- Keep the shader behind content and non-interactive.
- Verify text contrast over the brightest shader region.
- Respect `prefers-reduced-motion`; provide a static or reduced-motion mode.
- Avoid running multiple large animated canvas effects on the same page.
- The purple `#B097F7` is a tertiary shader highlight, not a fourth core brand color.

### Dashboard: solid operational surfaces

Do **not** reuse the animated GradientASCII background behind dashboard tables, forms, logs, charts, or other operational content. Use a solid dark canvas so dense information remains legible.

Use Modal-inspired isometric SVGs and technical illustrations selectively:

- Workflow builder empty state / getting started.
- Sandbox topology, isolation boundaries, or execution-plane overview.
- Integration setup and onboarding explanations.
- Landing-page diagrams and feature explanations.

Illustration rules:

- Prefer crisp SVG with restrained colors, thin strokes, simple geometry, and limited gradients.
- Isometric illustrations should explain a system relationship or topology, not serve as meaningless decoration.
- Use Electric Blue for active/control-plane paths, Cantaloupe for attention/approval paths, and muted gray-blue for inactive infrastructure.
- Keep illustrations out of dense tables and active run logs.
- Prefer lightweight SVGs to large raster images for simple diagrams.
- Provide an accessible label or equivalent text explanation for meaningful diagrams.
- Treat the Modal assets in the supplied archive as reference material until their reuse rights are verified. Recreate the visual language with original diagrams where necessary.

## 9. Dashboard information architecture

The dashboard is the primary product. On sign-in, it should communicate platform state and the user's next useful action immediately.

### Primary navigation

Suggested first-level destinations:

1. **Overview** — operational health, recent activity, active runs, and next actions.
2. **Runs** — execution history, current status, progress, logs, retries, and artifacts.
3. **Workflows** — workflow library, versions, builder, validation, and publication.
4. **Repositories** — connected repositories, default branches, permissions, and integration health.
5. **Approvals** — pending human decisions and exact proposal/context.
6. **Usage** — model/sandbox usage and configured limits, using measured data only.
7. **Settings** — workspace, members, integrations, policies, and account controls.

Only expose routes that are implemented and authorized. Hide or clearly mark planned capabilities; never present mock controls as live production functionality.

### Overview dashboard

Prioritize this content order:

- **Header:** workspace/project context, concise title, primary action to create or submit a task.
- **Operational summary:** active runs, queued tasks, approvals waiting, recent failures. Prefer compact metric groups to oversized KPI cards.
- **Active runs:** task name, repository/branch, status, current stage, elapsed time, initiator, and latest update.
- **Pending approvals:** action required, requester, scope, and age.
- **Recent activity:** chronological, compact, filterable event feed.
- **System/integration health:** show only verified current status. Avoid generic green “all systems operational” claims without a real health check.

Every section must answer a user question or enable an operational decision. Remove panels that add no useful information.

### Runs list and run detail

The runs table should be a high-quality, dense data surface:

- Search and filters for status, repository, workflow, initiator, and date.
- Sortable columns with persistent sort indication.
- Clear status labels: icon plus text, not color alone.
- Row click opens run detail; keyboard focus and selection are supported.
- Keep row actions in a predictable overflow menu or visible primary action.
- Design empty, loading, error, and stale states explicitly.

Run detail should present:

- Task/repository/branch identity and lifecycle status.
- A readable timeline of workflow stages and transitions.
- Current agent activity with stage-level detail, not an unbounded “thinking” transcript.
- Structured logs with severity, timestamp, source, and copy controls.
- Test/scan results, artifacts, and diff/PR links.
- Retry/cancel controls only when allowed by actual state and policy.
- Approval gates with exact proposed action, risk, scope, and consequences.
- Audit history and durable event timestamps.

### Workflow builder

Treat workflow authoring as a core product experience:

- Node canvas with a clear grid, restrained background, legible node states, and obvious connection affordances.
- Node palette and property inspector in separate, predictable panels.
- Node colors used sparingly and consistently by function/category.
- Validation errors shown inline and at graph level; never rely only on a color or toast.
- Version, draft/published state, and validation status always visible.
- Unsaved-change indicator and confirmation before destructive navigation.
- Consider keyboard shortcuts, zoom, pan, fit-to-view, minimap, and accessible non-canvas alternatives.
- Editing must be deterministic. Never use arbitrary code evaluation in the browser.

### Approvals and trust

Approvals are a trust-critical interface:

- Show the exact action to be approved, task/run, repository, branch, requested permissions, affected resources, and relevant diff or command preview.
- Separate Approve and Reject. Keep the default/safer action visually neutral.
- Confirm irreversible or broad-scope decisions.
- Preserve decision maker, timestamp, payload identity, and audit outcome.
- Never style a high-impact approval as a casual one-click CTA.

## 10. Component system

Build reusable components around the current stack and existing UI conventions. Use shadcn/ui patterns where appropriate, with project-owned theme tokens and wrappers. Do not replace the established framework or introduce a heavyweight UI system solely for styling.

### Mandatory frontend setup preflight: shadcn/ui

**This is the first step an implementation agent must perform before building or restyling dashboard components. Do not assume shadcn/ui is already installed or configured.**

The repository is a Bun monorepo. The web application workspace is `apps/web`; run shadcn commands against that workspace, not the repository root.

1. **Inspect the existing setup before changing anything.** Check `apps/web/package.json`, `apps/web/components.json`, `apps/web/src/styles.css`, the app's TypeScript/Vite alias configuration, `apps/web/src/components/ui/`, and the existing `cn` utility (usually `apps/web/src/lib/utils.ts`). Also inspect the installed dependencies and existing component imports. Do not overwrite existing configuration just to make it match a generic template.
2. **Confirm whether shadcn/ui is initialized.** Run the current CLI project inspection command and inspect its output:

   ```bash
   bunx --bun shadcn@latest info --cwd apps/web
   ```

   A valid `components.json`, configured CSS entry point/theme variables, working import alias, `cn` utility, and generated UI component location are stronger evidence of an initialized project than checking for a package name alone. shadcn/ui components are source files in the application; the CLI can be invoked with `bunx` and does not need to be globally installed.
3. **If shadcn/ui is already correctly initialized, do not initialize it again.** Preserve the existing base (Base UI, Radix, or other configured primitive choice), aliases, CSS setup, component paths, and custom tokens. Repair only genuinely missing or inconsistent pieces.
4. **If it is missing or not initialized, initialize it in the existing TanStack Start app.** First confirm that the app has a supported Tailwind CSS setup and a working `@/*` import alias. If either is missing, configure it according to the current official TanStack Start installation guide before running the shadcn CLI. Then run:

   ```bash
   bunx --bun shadcn@latest init --cwd apps/web
   ```

   Follow the CLI prompts and choose the component primitive/base and style that best fit this specification. Keep CSS variables enabled so Isolate's design tokens can be defined centrally. **Do not use `--force` over existing app configuration. Do not use `--template start` here:** this is an existing TanStack Start application, not a request to scaffold a second app. Do not replace TanStack Start, Vite, Tailwind, or the current project structure.
5. **Verify the initialization before implementing UI.** Re-run `bunx --bun shadcn@latest info --cwd apps/web`. Confirm that `components.json` is valid, the required dependencies are recorded in `apps/web/package.json`, the global stylesheet imports/configures the shadcn and Tailwind styles correctly, the `cn` helper resolves, and generated components can be imported using the configured alias. Run the web app's typecheck/build (and relevant Biome checks) to catch configuration issues.
6. **Add components incrementally.** Use the CLI to add only the components needed for the current feature, from the `apps/web` workspace. For example:

   ```bash
   bunx --bun shadcn@latest add button card badge dialog dropdown-menu input select separator skeleton table tooltip --cwd apps/web
   ```

   Adjust the component list to the actual screen; do not install the entire registry speculatively. Inspect generated source before adapting it. Apply Isolate's colors, typography, borders, radii, spacing, and interaction states through shared tokens and component variants rather than one-off page overrides.

**Official references:** [TanStack Start installation for an existing project](https://ui.shadcn.com/docs/installation/tanstack) · [shadcn CLI reference](https://ui.shadcn.com/docs/cli). Re-check these official docs if CLI syntax or the supported TanStack/Tailwind setup has changed.

### Core primitives

- `Button`: primary, secondary, outline, ghost, destructive; clear disabled/loading states.
- `IconButton`: accessible label and tooltip required.
- `Input`, `Textarea`, `Select`, `Combobox`: consistent heights, borders, focus ring, and validation.
- `Tabs`: short labels and visible selected state.
- `Badge` / `StatusBadge`: semantic state and neutral metadata variants.
- `Tooltip`, `Popover`, `DropdownMenu`, `CommandPalette`.
- `Dialog` / `Sheet`: clear title, description, action order, and escape behavior.
- `Table`: sticky header where useful, row hover/focus, sorting, filters, and empty/loading/error states.
- `Skeleton`: geometry should match the final layout to prevent layout shift.
- `Toast`: concise confirmation/error; never the only location for important information.
- `Progress`: determinate when measurable; indeterminate only when progress genuinely cannot be quantified.
- `Separator`: low-contrast border token; do not add a decorative line everywhere.

### Product-level components

- `AppSidebar`, `AppHeader`, `WorkspaceSwitcher`, `RepositorySwitcher`.
- `PageHeader`, `FilterBar`, `MetricStrip`, `DataTable`.
- `RunStatusBadge`, `RunTimeline`, `RunStageItem`, `RunLogViewer`.
- `ApprovalCard`, `ApprovalDetail`, `PolicyDecision`.
- `WorkflowCanvas`, `WorkflowNode`, `NodePalette`, `NodeInspector`.
- `UsageMeter`, `UsageBreakdown`, `IntegrationHealth`, `ActivityFeed`.

### Component sizing

| Component | Suggested height |
|---|---:|
| Compact button | 30–32px |
| Default button/input | 36–40px |
| Large primary action | 44px |
| Table row | 48–56px |
| Sidebar item | 36–40px |
| Compact badge | 20–24px |
| Top bar | 56–64px |

Maintain consistent alignment and control heights within each form or toolbar.

## 11. Data visualization

- Use charts only when they reveal a trend or comparison that is difficult to understand in a table.
- Use the brand palette sparingly; avoid rainbow charts.
- Include labels, legends, units, and time range. Never rely on color alone.
- Prefer sparklines or compact trend indicators for overview metrics.
- Usage and cost charts must distinguish measured values from estimates and identify the period/timezone.
- Keep chart gridlines subtle and tooltip content legible.
- Provide a data table or accessible summary when the chart conveys important information.

## 12. Motion and micro-interactions

Use Emil Kowalski's motion guidance/skills as the implementation reference for interaction quality. Motion should be purposeful, quick, and interruptible.

### Motion principles

- Prefer CSS transitions for simple state changes; use the project's approved motion library only when it adds clear value.
- Animate opacity and transform where possible; avoid layout-thrashing properties.
- Respect `prefers-reduced-motion: reduce` globally.
- Motion must not obscure state changes, delay actions, or trap focus.
- Avoid spring overshoot in dashboard controls.
- Avoid animating large lists or every table row on mount.

### Recommended behaviors

| Interaction | Motion direction |
|---|---|
| Sidebar collapse | Short width/opacity transition |
| Dropdown/popover | Small opacity + vertical offset |
| Dialog/sheet | Fade + subtle scale/translate; manage focus correctly |
| Button press | 1–2px press feedback; no exaggerated bounce |
| Tabs | Immediate content change with subtle indicator movement |
| Toast | Short enter/exit; do not cover critical controls |
| Run stage transition | Update state first, then subtly highlight the new stage |
| Workflow node select | Border/background transition; inspector opens predictably |
| Loading | Skeleton for known layout; restrained spinner for brief unknown wait |
| Progress | Smooth only when actual incremental progress data exists |

Use the motion skill during implementation to tune timing, easing, sequencing, and reduced-motion alternatives. Do not invent fake progress or animate a run as if it is advancing when no new state has arrived.

## 13. Accessibility and usability

- Meet WCAG AA contrast for text and meaningful UI boundaries.
- Support full keyboard operation for navigation, forms, dialogs, menus, tables, and workflow controls.
- Provide a visible focus ring using the Electric Blue focus token.
- Give icon-only buttons accessible names and all inputs meaningful labels.
- Announce status/errors to assistive technology without excessive live-region noise.
- Never use color as the sole indication of status, selection, or severity.
- Respect reduced motion and browser zoom.
- Maintain usable touch targets on mobile.
- Provide semantic or keyboard-accessible alternatives for tables and workflow canvas interactions.

## 14. Landing page vs dashboard

| Concern | Landing page | Dashboard |
|---|---|---|
| Main job | Explain value and establish identity | Help operate, observe, and control runs |
| Typography | Display-led; Fireworks-inspired | Inter-led, compact, highly readable |
| Background | Existing GradientASCII shader | Solid dark canvas |
| Illustration | Modal-style isometric storytelling | Contextual setup/empty-state diagrams only |
| Color | Full brand expression, restrained gradient accents | Neutral dark UI, blue actions, orange accents |
| Motion | More expressive but restrained | Functional, short, low-distraction |
| Density | Spacious | Information-dense and scannable |

## 15. Implementation constraints

- Current web app stack: Bun, TypeScript, React, TanStack Start/Router/Query. Do not rewrite the stack to implement the design.
- Before any dashboard UI work, execute the shadcn/ui setup preflight in Section 10. Detect the existing state first; initialize the existing `apps/web` workspace only when it is not already configured.
- Keep database, provider, sandbox, worker, MCP, and credential-bearing logic server-side. The browser consumes safe server projections only.
- Preserve authorization, tenant scoping, input validation, no-store behavior for personalized data, and client-bundle secret checks.
- Do not expose operations that are not implemented or authorized.
- Do not expose raw provider errors, secrets, internal prompts, or unrestricted logs to the browser.
- Design to actual product capabilities. Clearly distinguish implemented, unavailable, and planned features.
- Centralize visual tokens. Avoid one-off hex and spacing values inside feature components.
- Before adding a dependency, check whether the existing stack or shadcn/ui provides the component.
- Keep page state and URL state deliberate. Filters/search/sort may be URL-driven where useful; secrets and sensitive user data must never be put in query parameters.
- Do not use arbitrary `eval`, dynamic code execution, or user-authored script execution to support visual workflow editing.

## 16. Design review checklist

A page is ready for review when:

- [ ] shadcn/ui setup was inspected and verified; the existing app was initialized only if required, with no destructive overwrite.
- [ ] It follows the core palette and shared typography tokens.
- [ ] Layout spacing follows the 4px scale and aligns with the app shell.
- [ ] Borders, radii, surface levels, and control heights are consistent.
- [ ] Iconography uses Reicon duotone consistently.
- [ ] The primary action and next step are visually obvious.
- [ ] Status, errors, approvals, and risks are understandable without color alone.
- [ ] Loading, empty, error, stale, disabled, and success states are designed.
- [ ] Motion is purposeful and reduced-motion behavior is implemented.
- [ ] Keyboard navigation, focus, labels, and contrast are verified.
- [ ] Displayed data is grounded in actual server state and safe projections.
- [ ] Dashboard content remains legible without decorative shaders or illustrations.
- [ ] No unimplemented capability is presented as working functionality.
- [ ] Third-party assets and fonts have verified usage rights before production use.

## 17. Ongoing design evolution

This document is expected to evolve as the UI is built. When using Reicon MCP, Emil Kowalski motion skills, or additional design references:

1. Inspect the current implementation and this document before changing design decisions.
2. Prefer additive refinements to the current token system over parallel systems.
3. Update this file when a reusable pattern, token, component, or interaction rule changes.
4. Record meaningful deviations with a short rationale.
5. Keep the landing shader configuration and three core brand colors stable unless an explicit design decision changes them.

**North star:** A developer should be able to open Isolate and understand what is running, what needs attention, what is safe to approve, and what action to take next—without fighting the interface.

## 18. Implementation record — wave 20 (2026-11-01)

This section records durable decisions made while building the authenticated
control plane. Sections 1–17 remain the design source of truth; this section
must be updated rather than replaced when the implementation changes.

- **Routes.** `/` is the public landing page. Authenticated and local-demo
  callers are redirected to `/overview`; the protected surfaces are
  `/overview`, `/runs`, `/runs/$taskId`, `/approvals`, `/repositories`,
  `/workflows`, `/usage`, `/settings`, `/devices`, and `/submit`. The app shell
  (sidebar + topbar + command palette) wraps every protected route.
- **Landing composition.** The landing follows a product-led, Baseten-style
  structure: quiet sticky header, centered hero, two actions, a large real
  dashboard screenshot in a browser frame, a facts strip, alternating feature
  sections, lifecycle, trust boundary, closing CTA and a column footer. Customer
  logos and testimonials are deliberately absent because the project has no
  verified customers or quotes to show.
- **Shader placement.** The React Bits `GradientASCII` component from §8 is used
  with the supplied configuration, but it sits behind the dashboard screenshot
  as the hero's visual bed rather than behind the headline. The supplied
  horizon is bright; full-bleed placement failed text contrast. This is the
  Modal-style composition: text on calm canvas, shader and product view below.
  Auth pages use a lower-intensity variant behind a solid card. The shader is
  non-interactive (`mouseInteraction={false}`, `clickEffect="none"`) and
  respects reduced motion through the component.
- **Icons.** `reicon-react` is the only icon family. Its published package
  exposes Outline and Filled weights, not a true duotone weight; the shared
  `Icon` wrapper composes duotone from a 20% Filled layer beneath the Outline
  glyph. Control glyphs opt out at 16px. The Reicon MCP is installed in the Qoder
  app for icon selection; generated shadcn icons are replaced with this wrapper.
- **Typography and tokens.** Inter carries UI and display; JetBrains Mono carries
  IDs, timestamps, logs and technical metadata. The fixed brand anchors remain
  Midnight Black `#02070A`, Electric Blue `#0297DE`, and Cantaloupe Orange
  `#FC734D`. The extended dark ramp lives in `apps/web/src/styles.css`.
- **Data surfaces.** Every page reads real tenant-scoped server projections
  through `uiRead`, with capability checks before storage, bounded rows and
  `no-store`. Empty, unavailable and error states are explicit. The workflow
  canvas builder remains deferred; the Workflows page is a read-only library.
- **Charts and numbers.** Usage charts use Dither Kit area/bar/sparkline
  components with one accent per chart; metrics use NumberFlow with tabular
  figures. A null cost is shown as `—`, never as zero.
- **Screenshot assets.** `apps/web/public/images/dashboard-overview.png` and
  the two panel clips are real UI captures with synthetic data. Their provenance
  is recorded in `apps/web/public/images/PROVENANCE.md`; the landing labels them
  illustrative.
- **Licensing.** See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The
  Dither Kit source had no LICENSE file when vendored; verify rights before
  commercial redistribution.

### Wave 21 implementation record (2026-11-01)

- **Shader placement.** The supplied GradientASCII configuration is now the
  landing background exactly: fixed to the viewport at `z-index: -1`, the eleven
  visual props unchanged, no scrim, mask or transform over the copy. The hero
  copy sits on the field; the console begins 56px below the actions. The
  component's `loseContext()` cleanup call was removed because React's dev
  double-mount reused a dead context and painted the canvas white.
- **Landing composition.** Centered display headline with one Electric Blue
  phrase, two pill actions, the 1600×1200 console capture at 1200px wide with
  three masked `backdrop-blur` bands at its bottom edge, a four-cell facts
  strip, three alternating product rows, a lifecycle rail with a drawn
  blue→orange trace, one bounded trust diagram, a closing statement and a
  four-column footer.
- **Auth.** Sign-in and sign-up reuse the same shader field: split brand panel
  on desktop, short band on mobile, solid card on canvas, and a static
  blue/orange fallback behind the canvas. The Google action uses the official
  four-colour mark. No auth-specific shader configuration exists.
- **Console refit.** `PageHeader` stopped rendering a kicker; `Section` and
  `MetricStrip` gained plain variants; `StatusBadge` is a dot plus label.
  Overview and Runs use hairline bands, dense tables and a single primary
  action. The secondary pages use full-width hairline sections rather than card
  grids.
- **Motion.** One vocabulary: 150/200/300ms with
  `cubic-bezier(0.23, 1, 0.32, 1)`. The landing keeps the shader as its
  signature continuous motion plus one scroll reveal per section; the app keeps
  state feedback only. Skeleton pulses were removed, the sheet timing was
  corrected, and reduced motion disables the entrance and reveal while leaving
  the static trace complete.
- **Mobile.** `viewport-fit=cover`, `interactive-widget=resizes-content`,
  theme color, tap-highlight removal, `touch-action: manipulation`,
  control-only `user-select`, 16px inputs on coarse pointers, root overscroll,
  and safe-area padding on the topbar, sidebar and auth. Every route was
  measured at 390px with zero horizontal overflow.

### Wave 21 open items

- Chart canvases still run a continuous `requestAnimationFrame`; park them and
  wake on interaction.
- The run-timeline gate animation from the motion plan is not implemented.
- Real-device QA for sticky hover, tap delay, safe areas with the keyboard and
  pull-to-refresh.
- The landing's scroll reveal arms after hydration; below-fold sections are
  hidden until scrolled (by design) and a full-page capture must scroll first.
