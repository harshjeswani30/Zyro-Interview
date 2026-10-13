import React from 'react'

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const isOverlay = typeof window !== 'undefined' && window.location.hash === '#overlay'
  if (isOverlay) return <>{children}</>
  return (
    <div
      className="app-shell"
      style={{
        display: 'flex',
        width: '100vw',
        height: '100vh',
        minHeight: 0,
        overflow: 'hidden',
        background: 'hsl(var(--background))'
      }}
    >
      {children}
    </div>
  )
}
