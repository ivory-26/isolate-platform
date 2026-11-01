# Third-party notices

This repository vendors or depends on the following frontend work. Keep this
file current when a dependency or vendored component changes.

| Work | License | Where | Notes |
|---|---|---|---|
| shadcn/ui | MIT | `apps/web/src/components/ui` | Generated source, adapted to Isolate tokens. |
| Radix UI | MIT | `radix-ui` dependency | Primitives used by shadcn/ui. |
| Reicon React | MIT | `reicon-react`, wrapper in `apps/web/src/components/icons` | The published package exposes Outline and Filled weights; Isolate composes duotone from both. |
| React Bits `GradientASCII` | Free React Bits component (MIT-style) | `apps/web/src/components/GradientASCII.tsx` | Source installed from the React Bits shadcn registry; used with the design.md configuration. |
| Dither Kit | npm CLI is MIT; the GitHub source had **no LICENSE file** at the time of use | `apps/web/src/components/dither-kit` | Vendored chart source. **Verify with the Dither Kit author before commercial redistribution.** |
| NumberFlow | MIT | `@number-flow/react` | Animated numeric values; respects reduced motion. |
| Inter, JetBrains Mono | SIL Open Font License 1.1 | `@fontsource-variable/*` | Self-hosted variable fonts. |
| Tailwind CSS | MIT | `tailwindcss` | Styling engine. |
| TanStack Start / Router / Query | MIT | app dependencies | Application framework. |
| React | MIT | app dependency | UI runtime. |
| unslop skill | CC BY 4.0 | `.agents/skills/unslop` | Credit retained in the skill; used as the final design audit. |
| Anatomy isometric kit | MIT | `apps/web/scripts/iso/iso-kit.mjs`, generated `apps/web/public/iso/workflow-machine.svg` | Source: [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy). Geometry and shading helpers only; the workflow machine drawing is original and remapped to Isolate brand tokens. |

No font files, illustrations, or CSS from the supplied Fireworks, Baseten, or
Modal reference archives are shipped. Those archives remain reference material.
