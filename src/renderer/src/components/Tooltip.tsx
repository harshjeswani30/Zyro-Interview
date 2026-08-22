import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'

export type TooltipPosition =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top-left'
  | 'top-right'

interface TooltipProps {
  content: string
  position?: TooltipPosition
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  delay?: number
}

export default function Tooltip({
  content,
  position = 'top',
  children,
  className = '',
  style,
  delay = 80
}: TooltipProps): React.ReactElement {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [shiftStyle, setShiftStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (visible && bubbleRef.current) {
      const rect = bubbleRef.current.getBoundingClientRect()
      const padding = 12
      const newShift: React.CSSProperties = {}

      // If tooltip spills beyond the right window boundary
      if (rect.right > window.innerWidth - padding) {
        const overflow = rect.right - (window.innerWidth - padding)
        if (position === 'bottom' || position === 'top') {
          newShift.transform = `translateX(calc(-50% - ${overflow}px))`
        } else if (position === 'bottom-left' || position === 'top-left') {
          newShift.right = `${overflow}px`
        } else if (position === 'right') {
          newShift.left = 'auto'
          newShift.right = 'calc(100% + 8px)'
          newShift.transform = 'translateY(-50%)'
        }
      }
      // If tooltip spills beyond the left window boundary
      else if (rect.left < padding) {
        const overflow = padding - rect.left
        if (position === 'bottom' || position === 'top') {
          newShift.transform = `translateX(calc(-50% + ${overflow}px))`
        } else if (position === 'left') {
          newShift.right = 'auto'
          newShift.left = 'calc(100% + 8px)'
          newShift.transform = 'translateY(-50%)'
        }
      }

      setShiftStyle(newShift)
    } else {
      setShiftStyle({})
    }
  }, [visible, position])

  if (!content) return <>{children}</>

  const handleMouseEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }

  return (
    <div
      className={`modern-tooltip-wrapper ${className}`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && (
        <div
          ref={bubbleRef}
          className={`modern-tooltip-bubble modern-tooltip-${position}`}
          style={shiftStyle}
        >
          <span>{content}</span>
        </div>
      )}
    </div>
  )
}
