import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useEyeContact } from '../hooks/useEyeContact'

interface Props {
  onToggle?: (enabled: boolean) => void
  externalEnabled?: boolean
}

export default function EyeContactPiP({ onToggle, externalEnabled }: Props): React.ReactElement {
  const { enabled, tracking, canvasRef, enable, disable, setStrength } = useEyeContact()
  const [strength, setStrengthLocal] = useState(80)
  const [loading, setLoading]         = useState(false)
  const [dragging, setDragging]       = useState(false)
  const [pos, setPos]                 = useState({ x: 16, y: 16 })
  const [showControls, setShowControls] = useState(false)
  const dragStart                     = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })
  const containerRef                  = useRef<HTMLDivElement>(null)
  const previewRef                    = useRef<HTMLDivElement>(null)
  const prevExternalRef               = useRef<boolean | undefined>(undefined)

  // Sync with external toggle (Ctrl+G from OverlayPage)
  useEffect(() => {
    if (externalEnabled === undefined) return
    if (prevExternalRef.current === externalEnabled) return
    prevExternalRef.current = externalEnabled
    if (externalEnabled && !enabled) {
      setLoading(true)
      enable().finally(() => setTimeout(() => setLoading(false), 1500))
    } else if (!externalEnabled && enabled) {
      disable()
      setLoading(false)
    }
  }, [externalEnabled, enabled, enable, disable])

  // Mount canvas into preview div
  useEffect(() => {
    const canvas = canvasRef.current
    const preview = previewRef.current
    if (!canvas || !preview) return
    if (!preview.contains(canvas)) {
      canvas.style.width  = '100%'
      canvas.style.height = '100%'
      canvas.style.borderRadius = '6px'
      canvas.style.display = 'block'
      preview.appendChild(canvas)
    }
    return () => {
      if (preview.contains(canvas)) preview.removeChild(canvas)
    }
  }, [canvasRef])

  // Sync strength
  useEffect(() => {
    setStrength(strength / 100)
  }, [strength, setStrength])

  const handleToggle = useCallback(async () => {
    if (enabled) {
      disable()
      onToggle?.(false)
      setLoading(false)
    } else {
      setLoading(true)
      onToggle?.(true)
      await enable()
      setTimeout(() => setLoading(false), 1500)
    }
  }, [enabled, enable, disable, onToggle])

  // Drag handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    dragStart.current = {
      mx: e.clientX, my: e.clientY,
      ox: pos.x,     oy: pos.y,
    }
  }, [pos])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.mx
      const dy = e.clientY - dragStart.current.my
      setPos({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy })
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  const statusColor = !enabled ? '#555' : tracking ? '#22c55e' : '#f59e0b'
  const statusLabel = !enabled ? 'OFF' : loading ? 'Loading…' : tracking ? 'Tracking' : 'No Face'

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        bottom: pos.y,
        right: pos.x,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        userSelect: 'none',
      }}
    >
      {/* Controls panel */}
      {showControls && (
        <div style={{
          background: 'rgba(10,10,20,0.92)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10,
          padding: '10px 12px',
          width: 180,
          backdropFilter: 'blur(12px)',
        }}>
          <div style={{ color: '#aaa', fontSize: 10, marginBottom: 6, fontFamily: 'monospace', letterSpacing: 1 }}>
            CORRECTION STRENGTH
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0} max={100} value={strength}
              onChange={e => setStrengthLocal(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#6366f1', height: 4 }}
            />
            <span style={{ color: '#e2e8f0', fontSize: 11, width: 32, textAlign: 'right' }}>
              {strength}%
            </span>
          </div>
          <div style={{ color: '#666', fontSize: 9, marginTop: 8, lineHeight: 1.4 }}>
            At 100%: eyes always centred<br />
            At 30%: subtle nudge
          </div>
        </div>
      )}

      {/* Main PiP card */}
      <div style={{
        background: 'rgba(8,8,18,0.90)',
        border: `1px solid ${enabled ? (tracking ? 'rgba(34,197,94,0.4)' : 'rgba(245,158,11,0.4)') : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 12,
        overflow: 'hidden',
        width: enabled ? 200 : 'auto',
        transition: 'all 0.25s ease',
        backdropFilter: 'blur(16px)',
        boxShadow: enabled ? '0 8px 32px rgba(0,0,0,0.5)' : '0 2px 12px rgba(0,0,0,0.3)',
      }}>

        {/* Header bar — drag handle */}
        <div
          onMouseDown={onMouseDown}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 10px',
            cursor: dragging ? 'grabbing' : 'grab',
            borderBottom: enabled ? '1px solid rgba(255,255,255,0.06)' : 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Gaze icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={enabled ? '#818cf8' : '#555'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span style={{ color: '#e2e8f0', fontSize: 11, fontWeight: 600, letterSpacing: 0.3 }}>
              Eye Contact
            </span>
            {/* Status dot */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: statusColor,
              boxShadow: enabled ? `0 0 6px ${statusColor}` : 'none',
              display: 'inline-block',
              marginLeft: 2,
            }} />
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            {/* Settings button */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setShowControls(v => !v)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: showControls ? '#818cf8' : '#555',
                padding: 2, lineHeight: 1,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>

            {/* Toggle ON/OFF */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={handleToggle}
              disabled={loading}
              style={{
                background: enabled ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${enabled ? 'rgba(99,102,241,0.6)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 5,
                cursor: loading ? 'wait' : 'pointer',
                color: enabled ? '#818cf8' : '#888',
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                letterSpacing: 0.5,
                transition: 'all 0.2s',
              }}
            >
              {loading ? '…' : enabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Video preview */}
        {enabled && (
          <div style={{ position: 'relative' }}>
            <div
              ref={previewRef}
              style={{
                width: 200, height: 150,
                background: '#000',
                overflow: 'hidden',
              }}
            />
            {/* Status overlay */}
            <div style={{
              position: 'absolute', bottom: 6, left: 6,
              background: 'rgba(0,0,0,0.6)',
              borderRadius: 4,
              padding: '2px 6px',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
              <span style={{ color: '#ccc', fontSize: 9 }}>{statusLabel}</span>
            </div>
            {/* Strength badge */}
            <div style={{
              position: 'absolute', bottom: 6, right: 6,
              background: 'rgba(0,0,0,0.6)',
              borderRadius: 4, padding: '2px 6px',
            }}>
              <span style={{ color: '#818cf8', fontSize: 9 }}>{strength}%</span>
            </div>
          </div>
        )}
      </div>

      {/* Hotkey hint */}
      {!enabled && (
        <div style={{ color: '#444', fontSize: 9, textAlign: 'right', marginRight: 4 }}>
          Ctrl+G to toggle
        </div>
      )}
    </div>
  )
}
