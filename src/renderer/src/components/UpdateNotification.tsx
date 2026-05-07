import React, { useState, useEffect } from 'react'

interface UpdateInfo {
  version: string
  releaseNotes?: string
}

interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export const UpdateNotification: React.FC = () => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<number>(0)
  const [isReady, setIsReady] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isDismissed, setIsDismissed] = useState(false)

  useEffect(() => {
    const unsubAvailable = window.api.onUpdateAvailable((info) => {
      const typed = info as UpdateInfo
      setUpdateInfo(typed)
      // Don't show banner yet — download is happening silently in background
      // isVisible will be set to true only when download completes
      console.log('[UpdateUI] Update found:', typed.version, '— downloading silently...')
    })

    const unsubProgress = window.api.onUpdateProgress((p) => {
      const typed = p as DownloadProgress
      const pct = Math.floor(typed.percent)
      setProgress(pct)
      if (!isDownloading) setIsDownloading(true)
    })

    const unsubReady = window.api.onUpdateReady((info) => {
      const typed = info as UpdateInfo
      setUpdateInfo(typed)
      setIsReady(true)
      setIsDownloading(false)
      setProgress(100)
      setIsVisible(true) // Now surface the banner: "Install & Relaunch"
    })

    const unsubError = window.api.onUpdateError((err) => {
      setError(err)
      setIsDownloading(false)
      setIsVisible(true)
      // Auto-dismiss error after 8 seconds
      setTimeout(() => {
        setIsVisible(false)
        setError(null)
      }, 8000)
    })

    return () => {
      unsubAvailable()
      unsubProgress()
      unsubReady()
      unsubError()
    }
  }, [isDownloading])

  const handleInstall = (): void => {
    window.api.installUpdate()
  }

  const handleDismiss = (): void => {
    setIsDismissed(true)
    setIsVisible(false)
  }

  if (!isVisible || isDismissed) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        width: 320,
        borderRadius: 16,
        overflow: 'hidden',
        background: 'rgba(13, 14, 22, 0.92)',
        border: error
          ? '1px solid rgba(248, 113, 113, 0.3)'
          : '1px solid rgba(139, 92, 246, 0.35)',
        backdropFilter: 'blur(20px)',
        boxShadow: error
          ? '0 20px 60px rgba(0,0,0,0.5), 0 0 30px rgba(248, 113, 113, 0.08)'
          : '0 20px 60px rgba(0,0,0,0.5), 0 0 30px rgba(139, 92, 246, 0.1)',
        animation: 'slideUpFadeIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        padding: '18px 20px 16px'
      }}
    >
      {/* Background glow */}
      <div style={{
        position: 'absolute',
        top: -20,
        right: -20,
        width: 100,
        height: 100,
        borderRadius: '50%',
        background: error
          ? 'rgba(248, 113, 113, 0.08)'
          : 'rgba(139, 92, 246, 0.08)',
        filter: 'blur(30px)',
        pointerEvents: 'none'
      }} />

      <div style={{ position: 'relative' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          {/* Icon */}
          <div style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: error
              ? 'rgba(248, 113, 113, 0.15)'
              : 'rgba(139, 92, 246, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}>
            {error ? (
              // Error icon
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : isReady ? (
              // Rocket icon
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
                <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
              </svg>
            ) : (
              // Download icon (animated when downloading)
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#a78bfa"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={isDownloading ? { animation: 'bounceDown 1s ease infinite' } : {}}
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
          </div>

          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 700,
              color: error ? '#f87171' : '#e2e8f0',
              lineHeight: 1.3,
              marginBottom: 2
            }}>
              {error
                ? 'Update Failed'
                : isReady
                  ? 'Update Available'
                  : 'Downloading Update...'}
            </div>
            <div style={{
              fontSize: 11,
              color: '#64748b',
              fontVariantNumeric: 'tabular-nums'
            }}>
              {error
                ? 'Will retry next launch'
                : isReady
                  ? `v${updateInfo?.version}`
                  : `v${updateInfo?.version || '...'} — ${progress}%`}
            </div>
          </div>
        </div>

        {/* Progress bar (only when downloading, not on error or ready) */}
        {!error && isDownloading && (
          <div style={{
            height: 3,
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 99,
            overflow: 'hidden',
            marginBottom: 14
          }}>
            <div style={{
              height: '100%',
              width: `${progress}%`,
              background: isReady
                ? 'linear-gradient(90deg, #8b5cf6, #6366f1)'
                : 'linear-gradient(90deg, #8b5cf6, #6366f1)',
              borderRadius: 99,
              transition: 'width 0.4s ease'
            }} />
          </div>
        )}

        {/* Buttons */}
        {error ? (
          <div style={{
            fontSize: 11,
            color: 'rgba(248, 113, 113, 0.7)',
            padding: '8px 0 4px',
            lineHeight: 1.5
          }}>
            {error.length > 100 ? error.substring(0, 100) + '...' : error}
          </div>
        ) : isReady ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <button
              onClick={handleInstall}
              style={{
                flex: 1,
                height: 34,
                background: 'linear-gradient(135deg, rgba(139,92,246,0.9), rgba(99,102,241,0.9))',
                border: '1px solid rgba(139,92,246,0.4)',
                borderRadius: 9,
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'all 0.2s ease',
                boxShadow: '0 4px 20px rgba(139,92,246,0.25)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139,92,246,1), rgba(99,102,241,1))'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139,92,246,0.9), rgba(99,102,241,0.9))'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7" />
              </svg>
              Install & Relaunch
            </button>
            <button
              onClick={handleDismiss}
              style={{
                width: 34,
                height: 34,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 9,
                color: '#64748b',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease',
                flexShrink: 0
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#94a3b8'
                e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#64748b'
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
              }}
            >
              ×
            </button>
          </div>
        ) : (
          // Downloading state — no user action needed, just show progress
          <div style={{
            fontSize: 11,
            color: '#475569',
            textAlign: 'center',
            padding: '4px 0'
          }}>
            Preparing update in background · App continues working normally
          </div>
        )}
      </div>

      <style>{`
        @keyframes slideUpFadeIn {
          from { opacity: 0; transform: translateY(16px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)   scale(1); }
        }
        @keyframes bounceDown {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(3px); }
        }
      `}</style>
    </div>
  )
}
