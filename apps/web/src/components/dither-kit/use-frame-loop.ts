"use client"

import { type RefObject, useCallback, useEffect, useRef } from "react"

/** Return `true` to keep the loop scheduled, `false` to park until woken. */
export type FrameCallback = (now: number) => boolean

/**
 * Shared requestAnimationFrame scheduler for the Dither Kit canvases.
 *
 * One loop per canvas: a frame is only scheduled while the element is in the
 * viewport and the document is visible, and `onFrame` decides whether another
 * frame is needed at all. `wake()` (returned) resumes a parked loop — the
 * canvases call it after every render so hover, selection, data revisions and
 * entrance replays start work again. Cleanup cancels the pending frame and
 * removes both observers exactly once.
 */
export function useFrameLoop(
  target: RefObject<Element | null>,
  onFrame: FrameCallback,
  restartKey: string | number = 0
): () => void {
  const frameRef = useRef(onFrame)
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    frameRef.current = onFrame
  }, [onFrame])

  useEffect(() => {
    const element = target.current
    if (!element) return undefined
    let raf = 0
    let disposed = false
    // Without IntersectionObserver (non-browser hosts) assume visible; the
    // document visibility check still protects background tabs.
    let visible = typeof IntersectionObserver === "undefined"

    const canRun = () => !disposed && visible && !document.hidden

    const schedule = () => {
      if (!raf && canRun()) raf = requestAnimationFrame(tick)
    }

    function tick(now: number) {
      raf = 0
      if (!canRun()) return
      if (frameRef.current(now)) schedule()
    }

    const wake = () => schedule()
    wakeRef.current = wake

    const onVisibility = () => {
      if (!document.hidden) schedule()
    }

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1]
            visible = entry ? entry.isIntersecting : false
            if (visible) schedule()
          })
    observer?.observe(element)
    document.addEventListener("visibilitychange", onVisibility)
    schedule()

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      if (wakeRef.current === wake) wakeRef.current = null
    }
  }, [target, restartKey])

  return useCallback(() => {
    wakeRef.current?.()
  }, [])
}
