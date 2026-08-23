import { useCallback } from 'react'
import { MIN_OVERLAY_WIDTH, DEFAULT_OVERLAY_WIDTH } from './useHeaderScale'

// direction: 'e'|'w'|'ne'|'nw'|'se'|'sw' (height is locked — width only)
export function useResize(direction: string): { onPointerDown: (e: React.PointerEvent) => Promise<void> } {
  const onResizeStart = useCallback(async (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const startMouse = { x: e.screenX, y: e.screenY }
    const startBounds = await window.api.getBounds()

    const target = e.target as HTMLElement
    target.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.screenX - startMouse.x
      const dy = ev.screenY - startMouse.y

      // Lock height completely — only width changes
      let { x, width } = { ...startBounds }
      let { y, height } = startBounds

      // Width minimum matches the header scale floor, so the header keeps shrinking
      // proportionally right down to the smallest allowed width.
      const minW = MIN_OVERLAY_WIDTH
      const maxW = DEFAULT_OVERLAY_WIDTH
      const minH = 400

      if (direction.includes('e')) {
        // Right-side drag: grow right
        width = Math.min(maxW, Math.max(minW, startBounds.width + dx))
      }

      if (direction.includes('w')) {
        // Left-side drag: grow left (move x left, increase width)
        let potentialW = startBounds.width - dx
        
        // Clamp between min and max width
        if (potentialW > maxW) potentialW = maxW
        if (potentialW < minW) potentialW = minW
        
        x = startBounds.x + (startBounds.width - potentialW)
        width = potentialW
      }

      if (direction.includes('s')) {
        height = Math.max(minH, startBounds.height + dy)
      }

      if (direction.includes('n')) {
        const potentialH = startBounds.height - dy
        if (potentialH >= minH) {
          y = startBounds.y + dy
          height = potentialH
        } else {
          y = startBounds.y + (startBounds.height - minH)
          height = minH
        }
      }

      window.api.setBounds({ x, y, width, height })
    }

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [direction])

  return { onPointerDown: onResizeStart }
}

