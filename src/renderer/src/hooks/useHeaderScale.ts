import { useEffect } from 'react'

// Overlay window default width — must match createOverlayWindow() in main/index.ts
export const DEFAULT_OVERLAY_WIDTH = 840
// Smallest width the resize handles allow — must match minWidth in main/index.ts
export const MIN_OVERLAY_WIDTH = 540

// Floor of the scale ramp: reached exactly at the minimum window width, so the
// header keeps scaling proportionally across the whole resizable range.
const MIN_SCALE = MIN_OVERLAY_WIDTH / DEFAULT_OVERLAY_WIDTH

/**
 * Keeps `--hdr-scale` on <html> in sync with the overlay width.
 *
 * 1 at the default width (840px) and proportionally smaller below it, capped at
 * 1 above it. Every header size / gap / font is a multiple of this token (see
 * "Overlay header scale tokens" in main.css), so shrinking the window shrinks
 * every button, the status indicator and all spacing by the same factor, while
 * widening it only stretches the bar.
 */
export function useHeaderScale(): void {
  useEffect(() => {
    const root = document.documentElement
    let last = ''

    const apply = (): void => {
      const width = window.innerWidth
      if (!width) return
      const scale = Math.min(1, Math.max(MIN_SCALE, width / DEFAULT_OVERLAY_WIDTH))
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
