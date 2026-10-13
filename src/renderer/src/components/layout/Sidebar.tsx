import React from 'react'
import ZyroMascot from '../ZyroMascot'
import MinimalUpdateButton from '../MinimalUpdateButton'

type StepId = 1 | 2 | 3 | 'knowledge_base' | 'ai_source'

interface NavItem {
  id: StepId
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 1, label: 'Profile Setup', icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.79,40.31,185.67,25.08,212a8,8,0,1,0,13.85,8c18.84-32.56,52.14-52,89.07-52s70.23,19.44,89.07,52a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z" /></svg> },
  { id: 2, label: 'Resume Library', icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" /></svg> },
  { id: 'knowledge_base', label: 'Interview Content', icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm0,144H32V64H224V192ZM80,120a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,120Zm0,32a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,152Z" /></svg> },
  { id: 'ai_source', label: 'AI Source', icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M232,112a56.06,56.06,0,0,0-56-56H136V40a16,16,0,0,0-16-16H72A16,16,0,0,0,56,40V72H32A16,16,0,0,0,16,88v80a16,16,0,0,0,16,16H56v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V184h40A56.06,56.06,0,0,0,232,112Z" /></svg> },
  { id: 3, label: 'Final Check', icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M225.4,92.84l-96-72a8,8,0,0,0-9.6,0l-96,72A8,8,0,0,0,24,104v96a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V104A8,8,0,0,0,225.4,92.84ZM216,200H40V108l88-66,88,66Z" /></svg> },
]

interface SidebarProps {
  step: StepId
  onStepChange: (id: StepId) => void
  hasNameAndRole: boolean
  hasSelectedResume: boolean
  chatgptConnected: boolean
  claudeConnected: boolean
  geminiConnected: boolean
  userProfile: { email?: string; full_name?: string; sessions_balance?: number; trial_seconds_used?: number; unlimited_expires_at?: string } | null
  unlimitedDaysLeft: number
  sessionsBalance: number
  trialRemainingSeconds: number
  formatTime: (s: number) => string
  onLogout?: () => void
  showEmail: boolean
  onToggleEmail: () => void
  isSidebarMenuOpen: boolean
  onToggleSidebarMenu: () => void
  menuContainerRef: React.RefObject<HTMLDivElement>
  updateStatus: 'idle' | 'available' | 'downloading' | 'ready'
  updateInfo: { version: string } | null
  updateProgress: number
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onDismissUpdate: () => void
  AnimatedHamburgerButton: React.ComponentType<{ active: boolean; onClick: (e: React.MouseEvent) => void }>
}

function isPast(current: StepId, id: StepId): boolean {
  const order: StepId[] = [1, 2, 'knowledge_base', 'ai_source', 3]
  return order.indexOf(id) < order.indexOf(current)
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  const {
    step, onStepChange, hasNameAndRole, hasSelectedResume,
    chatgptConnected, claudeConnected, geminiConnected,
    userProfile, unlimitedDaysLeft, sessionsBalance, trialRemainingSeconds,
    formatTime, onLogout, showEmail, onToggleEmail,
    isSidebarMenuOpen, onToggleSidebarMenu, menuContainerRef,
    updateStatus, updateInfo, updateProgress, onDownloadUpdate, onInstallUpdate, onDismissUpdate,
    AnimatedHamburgerButton
  } = props

  return (
    <aside
      className="setup-sidebar"
      style={{
        width: 224,
        minWidth: 224,
        display: 'flex',
        flexDirection: 'column',
        background: 'hsl(var(--sidebar))',
        borderRight: '1px solid hsl(var(--border))',
        overflow: 'hidden',
        flexShrink: 0
      }}
    >
      <div className="sidebar-logo" style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 16px', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div className="logo-box" style={{ width: 42, height: 42, flexShrink: 0 }}>
            <ZyroMascot size={42} strokeColor="#a78bfa" />
          </div>
          <span className="logo-text" style={{ fontSize: 15, fontWeight: 800, color: '#fff', letterSpacing: '-0.3px', whiteSpace: 'nowrap' }}>Zyro AI</span>
        </div>
        <div ref={menuContainerRef} className="no-drag" style={{ position: 'relative', display: 'inline-flex', zIndex: 999999 }}>
          <AnimatedHamburgerButton active={isSidebarMenuOpen} onClick={(e) => { e.stopPropagation(); onToggleSidebarMenu() }} />
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((t) => {
          const isCurrent = step === t.id
          const past = isPast(step, t.id)
          const canClick = t.id === 1 || ((t.id === 2 || t.id === 'knowledge_base' || t.id === 'ai_source') && hasNameAndRole) || (t.id === 3 && hasSelectedResume)
          const showDot = t.id === 'ai_source' && (chatgptConnected || claudeConnected || geminiConnected)
          return (
            <button
              key={String(t.id)}
              className={`nav-item ${isCurrent ? 'active' : ''} ${past ? 'past' : ''} ${!canClick ? 'locked' : ''}`}
              onClick={() => { if (canClick) onStepChange(t.id) }}
            >
              <span className="nav-icon">{past ? <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#22c55e" viewBox="0 0 256 256"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" /></svg> : t.icon}</span>
              <span className="nav-text">{t.label}</span>
              {showDot && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />}
              {isCurrent && <div className="nav-active-glow" />}
            </button>
          )
        })}
      </nav>

      <MinimalUpdateButton updateStatus={updateStatus} updateInfo={updateInfo} updateProgress={updateProgress} onDownload={onDownloadUpdate} onInstall={onInstallUpdate} onDismiss={onDismissUpdate} />

      <footer className="sidebar-footer-enhanced">
        <div className="user-brief clickable" onClick={onToggleEmail}>
          <div className="ub-left">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" className="text-secondary"><path d="M234.38,210a123.36,123.36,0,0,0-60.78-53.23,72,72,0,1,0-91.2,0A123.36,123.36,0,0,0,21.62,210a8,8,0,1,0,13.85,8C49.13,193.53,77.37,180,109,177.8l12.16,30.4a8,8,0,0,0,14.8,0L148.12,177.8c31.63,2.2,59.87,15.73,73.53,40.2a8,8,0,1,0,13.73-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Zm56,88.65L120.35,168h15.3ZM136,160h0Z" /></svg>
            <span className="user-email-truncate">{showEmail ? (userProfile?.email || 'Guest User') : ((userProfile as any)?.full_name || userProfile?.email?.split('@')[0] || 'Guest User')}</span>
          </div>
          <button className="sidebar-logout-icon" onClick={async (e) => { e.stopPropagation(); await (window as any).api.supabaseLogout(); onLogout?.() }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M120,216a8,8,0,0,1-8,8H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h64a8,8,0,0,1,0,16H48V208h64A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z" /></svg>
          </button>
        </div>
        <div className="sidebar-stat-grid">
          {unlimitedDaysLeft > 0 ? (
            <div className="stat-pill-modern" style={{ background: 'linear-gradient(135deg, rgba(234,179,8,0.15), rgba(202,138,4,0.1))', border: '1px solid rgba(234,179,8,0.3)' }}>
              <div className="spm-label" style={{ color: '#fef08a' }}><span>Unlimited</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}><span className="spm-value" style={{ color: '#fef08a', fontSize: 15 }}>{unlimitedDaysLeft} Days</span><span style={{ fontSize: 9, color: '#a1a1aa' }}>({sessionsBalance} credits paused)</span></div>
            </div>
          ) : (
            <div className="stat-pill-modern"><div className="spm-label"><span>Sessions</span></div><span className="spm-value">{sessionsBalance}</span></div>
          )}
          <div className="stat-pill-modern"><div className="spm-label"><span>Free Trial</span></div><span className="spm-value">{formatTime(trialRemainingSeconds)}</span></div>
        </div>
      </footer>
    </aside>
  )
}
