import { useEffect } from 'react'

// Overlay window default width when session opens — must match createOverlayWindow() in main/index.ts
export const DEFAULT_OVERLAY_WIDTH = 940
// Maximum width allowed when resizing — must match maxWidth in main/index.ts
export const MAX_OVERLAY_WIDTH = 1040
// Smallest width the resize handles allow — must match minWidth in main/index.ts
export const MIN_OVERLAY_WIDTH = 720
// Reference width for 1.0 scale
export const BASE_SCALE_WIDTH = 1040

// Floor of the scale ramp: allows smooth scaling down across the whole resizable range
const MIN_SCALE = 0.55

/**
 * Keeps `--hdr-scale` on <html> in sync with the overlay width.
 *
 * 1 at 1040px and proportionally smaller below it, capped at 1 above it.
 * Every header size / gap / font is a multiple of this token, so shrinking the window
 * shrinks every button, indicator and spacing by the same factor.
 */
export function useHeaderScale(): void {
  useEffect(() => {
    const root = document.documentElement
    let last = ''

    const apply = (): void => {
      const width = window.innerWidth
      if (!width) return
      const scale = Math.min(1, Math.max(MIN_SCALE, width / BASE_SCALE_WIDTH))
      const next = scale.toFixed(4)
      // Only write on change — avoids redundant style recalcs while dragging
      if (next === last) return
      last = next
      root.style.setProperty('--hdr-scale', next)
    }

    apply()

    // ResizeObserver tracks Electron setBounds drags more reliably than 'resize'
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    window.addEventListener('resize', apply)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', apply)
      root.style.removeProperty('--hdr-scale')
    }
  }, [])
}
