import React from 'react'

interface MinimalUpdateButtonProps {
  updateStatus: 'idle' | 'available' | 'downloading' | 'ready'
  updateInfo: { version: string } | null
  updateProgress: number
  updateError?: string | null
  onDownload: () => void
  onInstall: () => void
  onDismiss: () => void
}

export default function MinimalUpdateButton({
  updateStatus,
  updateInfo,
  updateProgress,
  updateError,
  onDownload,
  onInstall,
  onDismiss
}: MinimalUpdateButtonProps): React.ReactElement | null {
  if (updateStatus === 'idle') return null

  const isDownloading = updateStatus === 'downloading'
  const isReady = updateStatus === 'ready'

  const handleClick = () => {
    if (updateStatus === 'available') {
      onDownload()
    } else if (updateStatus === 'ready') {
      onInstall()
    }
  }

  const tooltip = updateError && updateStatus === 'available'
    ? `Update failed: ${updateError}. Click to retry.`
    : isReady
      ? `Zyro AI${updateInfo?.version ? ` v${updateInfo.version}` : ''} downloaded. Click to install and restart.`
      : isDownloading
        ? `Downloading update (${Math.round(updateProgress)}%)...`
        : `Click to download Zyro AI${updateInfo?.version ? ` v${updateInfo.version}` : ''}`

  return (
    <div className="update-pill-container">
      <button
        type="button"
        className={`update-pill-label ${isDownloading ? 'downloading' : ''} ${isReady ? 'ready' : ''}`}
        onClick={handleClick}
        disabled={isDownloading}
        title={tooltip}
      >
        <span className="update-pill-circle">
          {!isDownloading && !isReady && (
            <svg
              className="update-pill-icon"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.2"
                d="M12 19V5m0 14-4-4m4 4 4-4"
              />
            </svg>
          )}
          {isDownloading && (
            <span className="update-pill-pct">{Math.round(updateProgress)}%</span>
          )}
          {isReady && (
            <svg
              className="update-pill-icon ready-icon"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          )}
          <div
            className="update-pill-progress-fill"
            style={{ height: isDownloading ? `${Math.max(10, updateProgress)}%` : '0%' }}
          />
        </span>
        <span className="update-pill-title">
          {updateStatus === 'available' && (updateError ? 'Retry Update' : (updateInfo?.version ? `Update v${updateInfo.version}` : 'Update'))}
          {isDownloading && 'Downloading...'}
          {isReady && 'Install Update'}
        </span>
      </button>

      <button
        type="button"
        className="update-pill-dismiss"
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
      >
        ×
      </button>
    </div>
  )
}
