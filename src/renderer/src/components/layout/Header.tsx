import React from 'react'
import TeleprompterText from '../TeleprompterText'
import CloudSyncButton from '../CloudSyncButton'
import Tooltip from '../Tooltip'

type StepId = 1 | 2 | 3 | 'knowledge_base' | 'ai_source'

const TITLES: Record<string, string> = {
  '1': 'Tell us about you',
  '2': 'Resume Library',
  'knowledge_base': 'Interview Content',
  'ai_source': 'AI Source',
  '3': 'Final Check'
}

const DESCS: Record<string, string> = {
  '1': 'Configure your profile, target role, and interview preferences.',
  '2': 'Upload, manage, and select your target resume for this session.',
  'knowledge_base': 'Upload company documents, preparation notes, and cheat sheets.',
  'ai_source': 'Select Zyro AI Gateway or link your own account to provide GPT-5 & Sonnet 5 (based on your subscription).',
  '3': 'Verify your interview configuration before launching the assistant.'
}

export function Header({ step }: { step: StepId }): React.ReactElement {
  const id = String(step)
  return (
    <header
      className="step-header-refined"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 28px',
        borderBottom: '1px solid hsl(var(--border))',
        flexShrink: 0,
        background: 'transparent'
      }}
    >
      <div className="shr-left" style={{ minWidth: 0 }}>
        <h1 className="shr-title" style={{ fontFamily: 'Striper, Inter, sans-serif', fontSize: 24, textTransform: 'uppercase', letterSpacing: '-0.5px', color: '#fff', margin: 0 }}>{TITLES[id]}</h1>
        <TeleprompterText text={DESCS[id]} />
      </div>
      <div className="shr-right" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Tooltip content="Real-time Cloud Sync Active" position="bottom-left">
          <CloudSyncButton onClick={async () => { try { const p = await (window as any).api.supabaseGetProfile(); if (p) window.dispatchEvent(new CustomEvent('force-profile-refresh', { detail: p })) } catch {} }} />
        </Tooltip>
        <Tooltip content="Minimize" position="bottom-left">
          <button className="ov-action-btn minimize no-drag" onClick={() => (window as any).api.minimizeWindow()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
        </Tooltip>
        <Tooltip content="Close App" position="bottom-left">
          <button className="ov-action-btn close no-drag" onClick={() => (window as any).api.quitApp()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
