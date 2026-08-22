import React, { useState } from 'react'
import {
  Send,
  Info,
  AlertTriangle,
  Mail,
  RefreshCw,
  Eye,
  EyeOff,
  Zap
} from 'lucide-react'
import { supabase } from '../lib/supabase'

export const BroadcastSection: React.FC = (): React.ReactElement => {
  const [subject, setSubject] = useState('')
  const [htmlContent, setHtmlContent] = useState('')
  const [testEmail, setTestEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isTestOnly, setIsTestOnly] = useState(true)
  const [showPreview, setShowPreview] = useState(false)
  const [toast, setToast] = useState<{ type: string; text: string } | null>(null)

  const showToast = (type: string, text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3500)
  }

  const handleSend = async (): Promise<void> => {
    if (!subject.trim() || !htmlContent.trim()) {
      showToast('error', 'Subject and HTML content are required')
      return
    }
    if (isTestOnly && !testEmail.trim()) {
      showToast('error', 'Test email is required for sandbox mode')
      return
    }

    const confirmed = !isTestOnly
      ? window.confirm('⚠️ You are about to send to ALL registered users. Are you sure?')
      : true

    if (!confirmed) return

    setIsLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('send-broadcast', {
        body: {
          subject,
          html: htmlContent,
          testEmail: isTestOnly ? testEmail : undefined
        }
      })

      if (error) throw error
      showToast('success', data?.message || 'Broadcast complete!')
    } catch (err: any) {
      console.error(err)
      showToast('error', err.message || 'Failed to send broadcast')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed',
          top: '24px',
          right: '24px',
          zIndex: 200,
          background: toast.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
          border: `1px solid ${toast.type === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
          borderRadius: '10px',
          padding: '12px 18px',
          color: toast.type === 'success' ? '#34d399' : '#f87171',
          fontSize: '13px',
          fontWeight: 600,
          backdropFilter: 'blur(12px)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          animation: 'fade-in-toast 0.3s ease-out'
        }}>
          {toast.type === 'success' ? <Zap size={14} /> : <AlertTriangle size={14} />}
          {toast.text}
        </div>
      )}

      {/* Stat Cards Row */}
      <div className="stat-grid mb-6">
        {/* Status Card */}
        <div className="stat-card-enhanced">
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label">Email Provider</p>
            <div className="coupon-icon-box" style={{ width: '24px', height: '24px', borderRadius: '4px', color: '#34d399' }}>
              <Mail size={14} />
            </div>
          </div>
          <div className="layout-col z-10 mt-1">
            <h3 className="stat-value">Resend</h3>
            <div className="mt-1" style={{ fontSize: '11px', color: '#64748b' }}>hello@zyro-ai.in</div>
          </div>
        </div>

        {/* Mode Card */}
        <div className="stat-card-enhanced">
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label">Delivery Mode</p>
            <div className="coupon-icon-box" style={{
              width: '24px', height: '24px', borderRadius: '4px',
              color: isTestOnly ? '#60a5fa' : '#f59e0b'
            }}>
              {isTestOnly ? <Info size={14} /> : <AlertTriangle size={14} />}
            </div>
          </div>
          <div className="layout-col z-10 mt-1">
            <h3 className="stat-value">{isTestOnly ? 'Sandbox' : 'Live'}</h3>
            <div className="mt-1" style={{ fontSize: '11px', color: '#64748b' }}>
              {isTestOnly ? 'Single test recipient' : 'Sends to all users'}
            </div>
          </div>
        </div>

        {/* Toggle Card */}
        <div className="stat-card-enhanced">
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label">Broadcast Settings</p>
            <div className="coupon-icon-box" style={{ width: '24px', height: '24px', borderRadius: '4px', color: '#a78bfa' }}>
              <Zap size={14} />
            </div>
          </div>
          <div className="layout-col z-10" style={{ marginTop: '14px', gap: '8px' }}>
            <button
              onClick={() => setIsTestOnly(v => !v)}
              className={`filter-btn-mini ${!isTestOnly ? 'active' : ''}`}
              style={{ textAlign: 'center', width: '100%' }}
            >
              {isTestOnly ? '⚡ Switch to Live Mode' : '🧪 Switch to Test Mode'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Form + Preview Area */}
      <div className="layout-row items-start" style={{ gap: '20px', alignItems: 'stretch' }}>

        {/* Left: Compose Form */}
        <div style={{
          flex: 1,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Form Header */}
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255,255,255,0.01)'
          }}>
            <div className="layout-row" style={{ gap: '10px' }}>
              <div className="coupon-icon-box" style={{
                width: '28px', height: '28px', borderRadius: '6px',
                background: 'rgba(139,92,246,0.15)', color: '#a78bfa'
              }}>
                <Send size={14} />
              </div>
              <div className="layout-col" style={{ gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'white' }}>Campaign Composer</span>
                <span style={{ fontSize: '11px', color: '#64748b' }}>Compose your broadcast email</span>
              </div>
            </div>

            <button
              onClick={() => setShowPreview(v => !v)}
              className="icon-btn-refined"
              style={{ gap: '6px', padding: '6px 12px', width: 'auto', color: showPreview ? '#a78bfa' : '#94a3b8' }}
              title="Toggle Preview"
            >
              {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
              <span style={{ fontSize: '11px', fontWeight: 600 }}>{showPreview ? 'Hide Preview' : 'Preview'}</span>
            </button>
          </div>

          {/* Form Body */}
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', flex: 1 }}>

            {/* Subject */}
            <div className="form-field">
              <label style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.05em' }}>
                Subject Line <span style={{ color: '#a78bfa' }}>*</span>
              </label>
              <div className="input-with-icon">
                <Mail size={14} className="input-icon-left" />
                <input
                  type="text"
                  className="input-box input-box-padding-left"
                  placeholder="e.g. Exciting news from Zyro AI 🎉"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                />
              </div>
            </div>

            {/* HTML Content */}
            <div className="form-field" style={{ flex: 1 }}>
              <div className="layout-row justify-between">
                <label style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8', letterSpacing: '0.05em' }}>
                  HTML Content <span style={{ color: '#a78bfa' }}>*</span>
                </label>
                <span style={{ fontSize: '10px', color: '#475569' }}>{htmlContent.length} chars</span>
              </div>
              <textarea
                value={htmlContent}
                onChange={e => setHtmlContent(e.target.value)}
                placeholder={'<h1>Hello {{name}},</h1>\n<p>Your email content goes here...</p>'}
                style={{
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  padding: '12px',
                  color: 'white',
                  fontSize: '12px',
                  outline: 'none',
                  width: '100%',
                  minHeight: '220px',
                  resize: 'vertical',
                  fontFamily: "'JetBrains Mono', monospace",
                  lineHeight: 1.6,
                  transition: 'border-color 0.2s'
                }}
                onFocus={e => (e.target.style.borderColor = 'rgba(168,85,247,0.5)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
              />
            </div>

            {/* Test Email (sandbox mode) */}
            {isTestOnly && (
              <div style={{
                padding: '16px',
                background: 'rgba(96, 165, 250, 0.05)',
                border: '1px solid rgba(96,165,250,0.15)',
                borderRadius: '10px'
              }}>
                <div className="form-field">
                  <label style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#60a5fa', letterSpacing: '0.05em' }}>
                    Test Recipient <span style={{ color: '#60a5fa' }}>*</span>
                  </label>
                  <div className="input-with-icon">
                    <Mail size={14} className="input-icon-left" style={{ color: '#60a5fa' }} />
                    <input
                      type="email"
                      className="input-box input-box-padding-left"
                      placeholder="your@email.com"
                      value={testEmail}
                      onChange={e => setTestEmail(e.target.value)}
                      style={{ borderColor: 'rgba(96,165,250,0.2)' }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Live Mode Warning */}
            {!isTestOnly && (
              <div style={{
                padding: '14px 16px',
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px'
              }}>
                <AlertTriangle size={16} style={{ color: '#f87171', flexShrink: 0, marginTop: '1px' }} />
                <div>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
                    Live Broadcast Warning
                  </p>
                  <p style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>
                    This will send to <strong style={{ color: '#f87171' }}>ALL registered users</strong>. Double-check your content before sending.
                  </p>
                </div>
              </div>
            )}

            {/* Send Button */}
            <div className="layout-row" style={{ justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                onClick={handleSend}
                disabled={isLoading}
                className="primary-btn"
                style={{
                  background: !isTestOnly
                    ? 'linear-gradient(to right, #dc2626, #b91c1c)'
                    : 'linear-gradient(to right, #9333ea, #4f46e5)',
                  borderColor: !isTestOnly ? 'rgba(239,68,68,0.3)' : 'rgba(168,85,247,0.2)',
                  boxShadow: !isTestOnly
                    ? '0 4px 20px rgba(239, 68, 68, 0.25)'
                    : '0 4px 12px rgba(124, 58, 237, 0.25)',
                  padding: '0 28px',
                  height: '42px',
                  borderRadius: '10px',
                  opacity: isLoading ? 0.7 : 1,
                  cursor: isLoading ? 'not-allowed' : 'pointer'
                }}
              >
                {isLoading ? (
                  <><RefreshCw size={16} className="animate-spin" /></>
                ) : (
                  <>
                    <Send size={15} />
                    <span>{isTestOnly ? 'Send Test Email' : 'Broadcast to All Users'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Live Preview Panel */}
        {showPreview && (
          <div style={{
            width: '380px',
            flexShrink: 0,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }}>
            {/* Preview Header */}
            <div style={{
              padding: '14px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255,255,255,0.01)'
            }}>
              <div className="layout-row" style={{ gap: '8px' }}>
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(239,68,68,0.5)' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(245,158,11,0.5)' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(16,185,129,0.5)' }} />
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Live Preview
                </span>
              </div>
              <span style={{ fontSize: '10px', color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>
                {subject || 'No subject'}
              </span>
            </div>

            {/* Preview Rendered Content */}
            <div style={{ flex: 1, overflow: 'auto', background: '#ffffff', minHeight: '300px' }}>
              {htmlContent ? (
                <div
                  style={{ padding: '24px', color: '#111', fontSize: '14px', lineHeight: 1.7 }}
                  dangerouslySetInnerHTML={{
                    __html: (window as any).DOMPurify ? (window as any).DOMPurify.sanitize(htmlContent) : htmlContent.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                  }}
                />
              ) : (
                <div style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '48px',
                  textAlign: 'center',
                  gap: '12px'
                }}>
                  <Eye size={32} style={{ color: '#cbd5e1', opacity: 0.6 }} />
                  <p style={{ color: '#94a3b8', fontSize: '13px' }}>
                    Enter HTML content to see the live preview
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
