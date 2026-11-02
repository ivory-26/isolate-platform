"use client"

import { type RefObject, useEffect, useMemo, useRef } from "react"
import { type ChartContextValue, useChart } from "./chart-context"
import {
  backingSize,
  bloomLayerStyle,
  clamp01,
  easeOutCubic,
  paintColumn,
  prefersReducedMotion,
} from "./dither-paint"
import { useFrameLoop } from "./use-frame-loop"

type Bars = { top: number[]; base: number[] } // per data index, in backing rows

type LoopArgs = {
  canvas: HTMLCanvasElement
  bloomCanvas: HTMLCanvasElement | null
  cols: number
  rows: number
  width: number
  state: RefObject<ChartContextValue>
  targets: RefObject<Record<string, Bars>>
}

type CanvasLoop = { tick: (now: number) => boolean }

// Fraction of the timeline spent staggering bar starts — the rest is each bar's
// own grow window, so the rise sweeps across the chart as a wave.
const STAGGER = 0.55

/**
 * Builds the bar paint step. The shared {@link useFrameLoop} hook owns
 * scheduling; `tick` returns whether another frame is needed, so the loop parks
 * as soon as the entrance and the hover lift have settled.
 */
function createBarLoop({
  canvas,
  bloomCanvas,
  cols,
  rows,
  width,
  state,
  targets,
}: LoopArgs): CanvasLoop | undefined {
  const c = canvas.getContext("2d")
  if (!c || cols <= 0 || rows <= 0) return undefined
  canvas.width = cols
  canvas.height = rows

  const bloomCtx = bloomCanvas?.getContext("2d") ?? null
  if (bloomCanvas) {
    bloomCanvas.width = cols
    bloomCanvas.height = rows
  }

  const reduce = prefersReducedMotion()
  const animate = state.current.animate && !reduce
  const duration = state.current.animationDuration
  const fx = cols / Math.max(width, 1)

  // Eased grow factor for bar `i` at global progress `prog`.
  const barProgress = (i: number, len: number, prog: number) => {
    if (!animate) return 1
    const start = len > 1 ? (i / (len - 1)) * STAGGER : 0
    return easeOutCubic(clamp01((prog - start) / (1 - STAGGER)))
  }

  let intensity = 0

  const paint = (prog: number) => {
    const s = state.current
    c.clearRect(0, 0, cols, rows)
    const stacked = s.stackType === "stacked" || s.stackType === "percent"
    const keys = s.configKeys
    keys.forEach((key, si) => {
      const t = targets.current[key]
      if (!t) return
      const seed = s.seedOf(key)
      const variant = s.seriesSpecs[key]?.variant ?? "gradient"
      const emphasis = s.selectedDataKey ?? s.focusDataKey
      const selDim = emphasis !== null && emphasis !== key ? 0.3 : 1
      for (let i = 0; i < s.dataLength; i++) {
        const bp = barProgress(i, s.dataLength, prog)
        const base = t.base[i] ?? rows - 1
        const grown = base + ((t.top[i] ?? base) - base) * bp
        // Bars grow from the zero baseline toward the value. Positive values
        // sit above the baseline (smaller pixel), negative ones below it —
        // paintColumn wants the higher edge first, so order the pair.
        const top = Math.min(grown, base)
        const bottom = Math.max(grown, base)
        const active = s.hoverIndex === i
        const hoverDim =
          s.hoverIndex != null && !active && s.isMouseInChart ? 0.5 : 1
        const slot = s.barSlot(i, si, keys.length)
        const c0 = Math.round(slot.x * fx)
        const c1 = Math.round((slot.x + slot.width) * fx)
        for (let x = c0; x < c1; x++) {
          paintColumn(c, x, top, bottom, seed, {
            variant,
            intensity: intensity + (active ? 0.4 : 0),
            dim: selDim * hoverDim,
            stacked,
          })
        }
      }
    })
  }

  let animStart = 0
  let lastProg = -1
  let lastRevision = state.current.revision
  let needsFill = true
  let lastPaintSig = ""
  let lastSelected: string | null | undefined = Symbol() as never
  let lastHover: number | null | undefined = Symbol() as never

  const draw = (now: number) => {
    const s = state.current
    if (!s.ready) return false
    if (bloomCtx) {
      const on =
        s.bloom !== "off" &&
        (!s.bloomOnHover || s.isMouseInChart || s.hovered)
      if (on) {
        bloomCtx.clearRect(0, 0, cols, rows)
        bloomCtx.drawImage(canvas, 0, 0)
      }
    }
    if (s.revision !== lastRevision) {
      lastRevision = s.revision
      animStart = 0 // re-play the wave on data change / replay
      lastProg = -1
    }
    if (!animStart) animStart = now
    const prog = animate ? Math.min(1, (now - animStart) / duration) : 1

    if (prog !== lastProg) {
      lastProg = prog
      needsFill = true
    }
    const emphasisNow = s.selectedDataKey ?? s.focusDataKey
    if (emphasisNow !== lastSelected) {
      lastSelected = emphasisNow
      needsFill = true
    }
    if (s.hoverIndex !== lastHover) {
      lastHover = s.hoverIndex
      needsFill = true
    }
    const itTarget = s.isMouseInChart || s.hovered ? 1 : 0
    const settling = Math.abs(intensity - itTarget) > 0.001
    if (settling) {
      intensity += (itTarget - intensity) * (reduce ? 1 : 0.16)
      needsFill = true
    } else intensity = itTarget

    // Live tweak repaint (variant, stacking) without replaying the wave.
    const paintSig = `${s.stackType}|${s.configKeys
      .map((k) => s.seriesSpecs[k]?.variant ?? "")
      .join(",")}`
    if (paintSig !== lastPaintSig) {
      lastPaintSig = paintSig
      needsFill = true
    }

    if (!needsFill) return false
    paint(prog)
    needsFill = false
    // Keep the frame only while the wave is playing or the lift is easing.
    return (animate && prog < 1) || settling
  }

  return { tick: draw }
}

/**
 * Dither canvas for bar charts. Each category owns a band; grouped series split
 * it into side-by-side bars, stacked series share its full width and pile in y.
 * Every bar is filled with the shared {@link paintColumn} ordered dither. Bars
 * grow up from their base in a staggered left-to-right wave (eased), and the
 * hovered category lifts while the rest dim.
 */
export function BarCanvas() {
  const ctx = useChart()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bloomRef = useRef<HTMLCanvasElement>(null)

  const { width, height } = ctx.plot
  const { cols, rows } = backingSize(width, height)
  const { ready, configKeys, bands, y } = ctx

  // Memoized: per-series bar tops/bases (backing rows) over the data indices.
  // The canvas re-renders on every hover/cursor tick, so pin this map to the
  // exact ctx fields it reads plus the backing geometry — a bar hover must not
  // rebuild every band's geometry.
  const targets = useMemo(() => {
    const out: Record<string, Bars> = {}
    if (!ready) return out
    const h = height || 1
    for (const key of configKeys) {
      const band = bands[key]
      if (!band) continue
      out[key] = {
        top: band.map((b) => (y(b[1]) / h) * (rows - 1)),
        base: band.map((b) => (y(b[0]) / h) * (rows - 1)),
      }
    }
    return out
  }, [ready, configKeys, bands, y, height, rows])

  // The paint loop reads these through refs so it always sees the latest values;
  // refs are written in an effect (never during render) — mutating a ref
  // mid-render tears under Strict Mode / concurrent rendering.
  const state = useRef(ctx)
  const targetsRef = useRef(targets)
  useEffect(() => {
    state.current = ctx
    targetsRef.current = targets
  })

  // One shared scheduler per canvas: parked offscreen or in a hidden tab,
  // resumed by `wake()` after any render (hover, selection, data revisions).
  const loopRef = useRef<CanvasLoop | null>(null)
  const wake = useFrameLoop(
    canvasRef,
    (now) => loopRef.current?.tick(now) ?? false,
    `${cols}x${rows}x${width}`
  )
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    loopRef.current =
      createBarLoop({
        canvas,
        bloomCanvas: bloomRef.current,
        cols,
        rows,
        width,
        state,
        targets: targetsRef,
      }) ?? null
    return () => {
      loopRef.current = null
    }
  }, [cols, rows, width])
  useEffect(() => {
    wake()
  })

  const bloomActive = ctx.bloomOnHover
    ? ctx.isMouseInChart || ctx.hovered
    : true
  const bloom = bloomLayerStyle(ctx.bloom, bloomActive)
  const pos = {
    left: ctx.margins.left,
    top: ctx.margins.top,
    width,
    height,
  } as const

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute"
        style={{ ...pos, imageRendering: "pixelated" }}
      />
      <canvas
        ref={bloomRef}
        className="pointer-events-none absolute"
        style={{
          ...pos,
          transition: "opacity 220ms ease",
          ...(bloom ?? { opacity: 0 }),
        }}
      />
    </>
  )
}
