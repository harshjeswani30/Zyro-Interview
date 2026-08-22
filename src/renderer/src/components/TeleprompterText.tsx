import React, { useState, useRef, useEffect } from 'react'

interface TeleprompterTextProps {
  text: string
}

export default function TeleprompterText({ text }: TeleprompterTextProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLParagraphElement>(null)
  const [scrollDistance, setScrollDistance] = useState<number>(0)
  const [isHovered, setIsHovered] = useState<boolean>(false)

  const isDragging = useRef(false)
  const startMouse = useRef({ x: 0, y: 0 })
  const startBounds = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const measureOverflow = (): void => {
    if (textRef.current && containerRef.current) {
      const containerW = containerRef.current.clientWidth || containerRef.current.getBoundingClientRect().width
      const textW = textRef.current.scrollWidth
      const diff = textW - containerW
      setScrollDistance(diff > 4 ? Math.ceil(diff + 24) : 0)
    }
  }

  useEffect(() => {
    measureOverflow()
    const timer1 = setTimeout(measureOverflow, 100)
    const timer2 = setTimeout(measureOverflow, 400)
    window.addEventListener('resize', measureOverflow)
    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
      window.removeEventListener('resize', measureOverflow)
    }
  }, [text])

  const handlePointerDown = async (e: React.PointerEvent): Promise<void> => {
    if (e.button !== 0) return
    isDragging.current = true
    startMouse.current = { x: e.screenX, y: e.screenY }
    try {
      const bounds = await window.api.getBounds()
      startBounds.current = bounds
    } catch {
      return
    }

    const onMove = (ev: PointerEvent): void => {
      if (!isDragging.current) return
      const dx = ev.screenX - startMouse.current.x
      const dy = ev.screenY - startMouse.current.y
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
  }

  const duration = Math.max(2.0, scrollDistance / 50)

  return (
    <div
      ref={containerRef}
      className={`shr-desc-wrapper no-drag ${isHovered && scrollDistance > 0 ? 'overflowing' : ''}`}
      onMouseEnter={() => {
        measureOverflow()
        setIsHovered(true)
      }}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={handlePointerDown}
    >
      <p
        ref={textRef}
        className={`shr-desc no-drag ${isHovered && scrollDistance > 0 ? 'teleprompter-active' : ''}`}
        style={
          isHovered && scrollDistance > 0
            ? ({
                '--scroll-offset': `${scrollDistance}px`,
                '--scroll-duration': `${duration}s`
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </p>
    </div>
  )
}
