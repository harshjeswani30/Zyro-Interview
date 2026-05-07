import { useCallback, useRef } from 'react'

export function useDrag(): { onPointerDown: (e: React.PointerEvent) => Promise<void> } {
  const isDragging = useRef(false)
  const startMouse = useRef({ x: 0, y: 0 })
  const startBounds = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const onDragStart = useCallback(async (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(tag)) return
    if (target.closest('.no-drag')) return

    // Prevent default and stop propagation ONLY if we are actually starting a drag
    e.preventDefault()
    e.stopPropagation()

    isDragging.current = true
    startMouse.current = { x: e.screenX, y: e.screenY }
    const bounds = await window.api.getBounds()
    startBounds.current = bounds

    target.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent): void => {
      if (!isDragging.current) return
      const dx = ev.screenX - startMouse.current.x
      const dy = ev.screenY - startMouse.current.y
      
      // Explicitly set BOTH position and size to prevent "auto-resize"
      window.api.setBounds({
        x: Math.round(startBounds.current.x + dx),
        y: Math.round(startBounds.current.y + dy),
        width: Math.round(startBounds.current.width),
        height: Math.round(startBounds.current.height)
      })
    }

    const onUp = (): void => {
      isDragging.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return { onPointerDown: onDragStart }
}
