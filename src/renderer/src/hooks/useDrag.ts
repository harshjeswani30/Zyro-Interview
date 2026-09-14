import { useCallback, useRef } from 'react'

export function useDrag(): { onPointerDown: (e: React.PointerEvent) => Promise<void> } {
  const isDragging = useRef(false)

  const onDragStart = useCallback(async (e: React.PointerEvent) => {
    // Only primary mouse button (left-click)
    if (e.button !== 0) return

    const target = e.target as HTMLElement
    const tag = target.tagName
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(tag)) return
    if (target.closest('button, input, textarea, select, a, .no-drag')) return

    e.preventDefault()
    e.stopPropagation()

    // Immediately capture pointer synchronously on container or target
    const captureTarget = (e.currentTarget as HTMLElement) || target
    try {
      captureTarget.setPointerCapture(e.pointerId)
    } catch {}

    isDragging.current = true
    ;(window as any).__isDraggingOverlay = true

    const startMouse = { x: e.screenX, y: e.screenY }

    let onMove: ((ev: PointerEvent) => void) | null = null

    const onUp = (): void => {
      isDragging.current = false
      ;(window as any).__isDraggingOverlay = false
      try {
        if (captureTarget.hasPointerCapture(e.pointerId)) {
          captureTarget.releasePointerCapture(e.pointerId)
        }
      } catch {}
      if (onMove) {
        window.removeEventListener('pointermove', onMove)
      }
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
    }

    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)

    const fallbackBounds = {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth || 940,
      height: window.outerHeight || 700
    }

    const initialBounds = (await window.api.getBounds()) || fallbackBounds
    if (!initialBounds || !isDragging.current) {
      onUp()
      return
    }

    onMove = (ev: PointerEvent): void => {
      if (!isDragging.current) return
      const dx = ev.screenX - startMouse.x
      const dy = ev.screenY - startMouse.y

      window.api.setBounds({
        x: Math.round(initialBounds.x + dx),
        y: Math.round(initialBounds.y + dy),
        width: Math.round(initialBounds.width),
        height: Math.round(initialBounds.height)
      })
    }

    window.addEventListener('pointermove', onMove)
  }, [])

  return { onPointerDown: onDragStart }
}

