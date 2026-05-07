import React, { useState, useCallback, useEffect } from 'react'
import { parseResumePDF, refineResumeWithAI, initAI, SessionData } from '../services/aiService'
import ZyroMascot from './ZyroMascot'
// Lucide imports removed as we use raw SVGs for exact reference matching

const STORAGE_KEY = 'interview_assistant_session'

const LANGUAGES = [
  { code: 'en-US', label: '🇺🇸 English (US)' },
  { code: 'en-GB', label: '🇬🇧 English (UK)' },
  { code: 'hi-IN', label: '🇮🇳 Hindi' },
  { code: 'es-ES', label: '🇪🇸 Spanish' },
  { code: 'fr-FR', label: '🇫🇷 French' },
  { code: 'de-DE', label: '🇩🇪 German' },
  { code: 'ja-JP', label: '🇯🇵 Japanese' },
  { code: 'zh-CN', label: '🇨🇳 Chinese' },
  { code: 'ar-SA', label: '🇸🇦 Arabic' },
  { code: 'pt-BR', label: '🇧🇷 Portuguese' }
]

const CODING_LANGUAGES = [
  'Python',
  'Java',
  'C++',
  'JavaScript',
  'TypeScript',
  'Go',
  'C#',
  'Swift',
  'Kotlin',
  'Rust',
  'PHP',
  'Ruby'
]

interface Resume {
  id: string
  name: string
  text: string
}

interface SavedData {
  name: string
  role: string
  company: string
  language: string
  resumes: Resume[]
  selectedResumeId: string
  autoAnswer: boolean
  experienceLevel: 'fresher' | 'experienced'
  experienceDuration?: string
  workHistory?: string
  codingLanguage?: string
}

interface UserProfile {
  id?: string
  email?: string
  sessions_balance?: number
  trial_seconds_used?: number
  [key: string]: unknown
}

export default function SetupPage({
  userProfile,
  onLogout
}: {
  userProfile?: UserProfile | null
  onLogout?: () => void
}): React.ReactElement {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [company, setCompany] = useState('')
  const [language, setLanguage] = useState(LANGUAGES[0].code)
  const [resumeFile, setResumeFile] = useState<{ name: string; data: string } | null>(null)
  const [resumes, setResumes] = useState<Resume[]>([])
  const [selectedResumeId, setSelectedResumeId] = useState('')
  const [isParsing, setIsParsing] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [error, setError] = useState('')
  const [autoAnswer, setAutoAnswer] = useState(true)
  const [experienceLevel, setExperienceLevel] = useState<'fresher' | 'experienced'>('fresher')
  const [experienceDuration, setExperienceDuration] = useState('')
  const [workHistory, setWorkHistory] = useState('')
  const [codingLanguage, setCodingLanguage] = useState('Python')
  const [showPaywall, setShowPaywall] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'success'>('idle')

  // ── Auto-Update state ───────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null)
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'available' | 'downloading' | 'ready'>('idle')

  const sessionsBalance = userProfile?.sessions_balance ?? 0
  const trialUsed = userProfile?.trial_seconds_used ?? 0
  const TRIAL_LIMIT = 600
  const trialRemainingSeconds = Math.max(0, TRIAL_LIMIT - trialUsed)

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  useEffect(() => {
    const cleanup = window.api.onInterviewEnd(() => {
      setStep(3)
      setError('')
      // Small delay to ensure Supabase update is fully processed
      setTimeout(() => {
        window.api.supabaseGetProfile()
      }, 500)
    })
    return () => {
      if (cleanup) cleanup()
    }
  }, [])

  // ── Wire up auto-update events ──────────────────────────────
  useEffect(() => {
    const unsubAvailable = window.api.onUpdateAvailable((info) => {
      const typed = info as { version: string }
      setUpdateInfo(typed)
      setUpdateStatus('available')
    })
    const unsubProgress = window.api.onUpdateProgress((p) => {
      const typed = p as { percent: number }
      setUpdateProgress(Math.floor(typed.percent))
      setUpdateStatus('downloading')
    })
    const unsubReady = window.api.onUpdateReady((info) => {
      const typed = info as { version: string }
      setUpdateInfo(typed)
      setUpdateProgress(100)
      setUpdateStatus('ready')
    })
    const unsubError = window.api.onUpdateError(() => {
      setUpdateStatus('idle')
    })
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubReady()
      unsubError()
    }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved: SavedData = JSON.parse(raw)
      setName(saved.name || '')
      setRole(saved.role || '')
      if (saved) {
        if (saved.name) setName(saved.name)
        if (saved.role) setRole(saved.role)
        if (saved.company) setCompany(saved.company)
        if (saved.language) setLanguage(saved.language)
        setAutoAnswer(saved.autoAnswer ?? true)
        setExperienceLevel(saved.experienceLevel || 'fresher')
        setExperienceDuration(saved.experienceDuration || '')
        setWorkHistory(saved.workHistory || '')
        setCodingLanguage(saved.codingLanguage || 'Python')
        setResumes(saved.resumes || [])
        setSelectedResumeId(saved.selectedResumeId || '')
        if (saved.selectedResumeId && saved.resumes?.length > 0) {
          setStep(3)
        } else if (saved.resumes?.length > 0) {
          setStep(2)
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  const saveData = useCallback(
    (overrides: Partial<SavedData> = {}): void => {
      const data: SavedData = {
        name,
        role,
        company,
        language,
        resumes,
        selectedResumeId,
        autoAnswer,
        experienceLevel,
        experienceDuration,
        workHistory,
        codingLanguage,
        ...overrides
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    [name, role, company, language, resumes, selectedResumeId, autoAnswer, experienceLevel, experienceDuration, workHistory, codingLanguage]
  )

  const handlePickResume = useCallback(async () => {
    const file = await window.api.pickResume()
    if (!file) return
    setResumeFile({ name: file.name || 'resume', data: file.data })
    setError('')
  }, [])

  const handleParseResume = useCallback(async () => {
    if (!resumeFile) {
      setError('Please select a resume first.')
      return
    }
    setIsParsing(true)
    setError('')
    try {
      initAI({
        name: name || 'Candidate',
        role,
        company,
        language,
        resumeText: '',
        autoAnswer,
        experienceLevel,
        experienceDuration: experienceLevel === 'experienced' ? experienceDuration : undefined,
        workHistory: experienceLevel === 'experienced' ? workHistory : undefined,
        codingLanguage
      })
      const rawText = await parseResumePDF(resumeFile.data)
      const refinedText = await refineResumeWithAI(rawText)
      const newResume: Resume = {
        id: Date.now().toString(),
        name: resumeFile.name || 'Resume',
        text: refinedText
      }
      const updatedResumes = [...resumes, newResume]
      setResumes(updatedResumes)
      setSelectedResumeId(newResume.id)
      setResumeFile(null)
      saveData({ resumes: updatedResumes, selectedResumeId: newResume.id })
      setError('')
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setError(`Failed to parse resume: ${message}`)
    } finally {
      setIsParsing(false)
    }
  }, [resumeFile, name, role, company, language, autoAnswer, resumes, saveData])

  const handleStartInterview = useCallback(() => {
    if (!name || !role) {
      setError('Please fill in your name and role.')
      setStep(1)
      return
    }
    const selectedResume = resumes.find((r) => r.id === selectedResumeId)
    if (!selectedResume) {
      setError('Please select a resume or upload one.')
      setStep(2)
      return
    }

    if (sessionsBalance <= 0 && trialRemainingSeconds <= 0) {
      setShowPaywall(true)
      return
    }

    setError('')
    const sessionData: SessionData = {
      name,
      role,
      company,
      language,
      resumeText: selectedResume.text || '',
      autoAnswer,
      experienceLevel,
      experienceDuration: experienceLevel === 'experienced' ? experienceDuration : undefined,
      workHistory: experienceLevel === 'experienced' && workHistory.trim() ? workHistory.trim() : undefined,
      codingLanguage
    }

    console.log('[Setup] Starting Interview with Context:', {
      name: sessionData.name,
      role: sessionData.role,
      resumeLength: sessionData.resumeText?.length
    })

    if (!sessionData.resumeText || sessionData.resumeText.trim().length < 10) {
      setError('The selected resume appears to be empty. Please try uploading it again.')
      setStep(2)
      return
    }

    saveData(sessionData)
    window.api.startInterview(sessionData).then((res: { allowed: boolean } | null) => {
      if (res && !res.allowed) {
        setShowPaywall(true)
      }
    })
  }, [
    name,
    role,
    company,
    language,
    resumes,
    selectedResumeId,
    autoAnswer,
    sessionsBalance,
    trialRemainingSeconds,
    saveData
  ])

  const handleDeleteResume = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const updated = resumes.filter((r) => r.id !== id)
      setResumes(updated)
      if (selectedResumeId === id) setSelectedResumeId(updated[0]?.id || '')
      saveData({ resumes: updated })
    },
    [resumes, selectedResumeId, saveData]
  )


  return (
    <div className="setup-page relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-[120px] mix-blend-screen animate-pulse-glow" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[100px] mix-blend-screen animate-pulse-glow" style={{ animationDelay: '2s' }} />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMSIgY3k9IjEiIHI9IjEiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiLz48L3N2Zz4=')`,
            maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)'
          }}
        />
      </div>

      <div className="setup-container relative z-10">
        {/* Sidebar */}
        <aside className="setup-sidebar">
          {/* Logo Area */}
          <div className="sidebar-logo">
            <div className="logo-box">
              <ZyroMascot size={52} strokeColor="#a78bfa" />
            </div>
            <span className="logo-text">Zyro AI</span>
          </div>

          <nav className="sidebar-nav">
            {[
              {
                id: 1,
                label: 'Profile Setup',
                icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.79,40.31,185.67,25.08,212a8,8,0,1,0,13.85,8c18.84-32.56,52.14-52,89.07-52s70.23,19.44,89.07,52a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z" />
                </svg>
              },
              {
                id: 2,
                label: 'Resume Library',
                icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                </svg>
              },
              {
                id: 3,
                label: 'Final Check',
                icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M225.4,92.84l-96-72a8,8,0,0,0-9.6,0l-96,72A8,8,0,0,0,24,104v96a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V104A8,8,0,0,0,225.4,92.84ZM216,200H40V108l88-66,88,66Z" />
                </svg>
              }
            ].map((t) => {
              const isCurrent = step === t.id
              const isPast = step > t.id
              const canClick = t.id <= step || (t.id === 2 && name && role) || (t.id === 3 && selectedResumeId)

              return (
                <button
                  key={t.id}
                  className={`nav-item ${isCurrent ? 'active' : ''} ${isPast ? 'past' : ''} ${!canClick ? 'locked' : ''}`}
                  onClick={() => canClick && setStep(t.id as 1 | 2 | 3)}
                >
                  <span className="nav-icon">{isPast ? '✓' : t.icon}</span>
                  <span className="nav-text">{t.label}</span>
                  {isCurrent && <div className="nav-active-glow" />}
                </button>
              )
            })}
          </nav>

          {/* ── Update Notification Card (Premium UI) ── */}
          {(updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'ready') && (
            <div className="update-card-premium" style={{
              margin: '16px 12px',
              padding: '16px',
              background: 'linear-gradient(135deg, rgba(88, 28, 135, 0.1), rgba(67, 56, 202, 0.05))',
              backdropFilter: 'blur(16px) saturate(180%)',
              WebkitBackdropFilter: 'blur(16px) saturate(180%)',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              borderRadius: '16px',
              boxShadow: updateStatus === 'available' ? '0 0 20px rgba(139, 92, 246, 0.1)' : 'none',
              animation: updateStatus === 'available' ? 'upd-pulse 3s infinite ease-in-out' : 'none',
              position: 'relative',
              overflow: 'hidden'
            }}>
              {/* Animated Background Glow */}
              <div style={{
                position: 'absolute', top: '-50%', left: '-50%', width: '200%', height: '200%',
                background: 'radial-gradient(circle, rgba(139, 92, 246, 0.05) 0%, transparent 70%)',
                animation: 'upd-rotate 10s linear infinite', zIndex: 0, pointerEvents: 'none'
              }} />

              {/* Content Wrapper */}
              <div style={{ position: 'relative', zIndex: 1 }}>
                {/* Dismiss Button */}
                <button
                  onClick={() => setUpdateStatus('idle')}
                  style={{
                    position: 'absolute',
                    top: -8,
                    right: -8,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#94a3b8',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                    e.currentTarget.style.color = '#f1f5f9'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    e.currentTarget.style.color = '#94a3b8'
                  }}
                >
                  ×
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  {/* Icon Container */}
                  <div style={{
                    width: 36, height: 36, borderRadius: '10px', flexShrink: 0,
                    background: 'rgba(139, 92, 246, 0.1)',
                    border: '1px solid rgba(139, 92, 246, 0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: 'inset 0 0 10px rgba(139, 92, 246, 0.1)'
                  }}>
                    {updateStatus === 'ready' ? (
                      <svg width="18" height="18" viewBox="0 0 256 256" fill="#a78bfa">
                        <path d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z" opacity="0.2"/><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/>
                      </svg>
                    ) : (updateStatus === 'downloading' || updateStatus === 'available') ? (
                      <svg width="18" height="18" viewBox="0 0 256 256" fill="#a78bfa" style={{ animation: updateStatus === 'downloading' ? 'upd-bounce 1.5s infinite ease-in-out' : 'none' }}>
                        <path d="M208,120H136V40a8,8,0,0,0-16,0v80H48a8,8,0,0,0-5.66,13.66l80,80a8,8,0,0,0,11.32,0l80-80A8,8,0,0,0,208,120Z" opacity="0.2"/><path d="M213.66,122.34l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,48,112H120V40a8,8,0,0,1,16,0v72h72a8,8,0,0,1,5.66,14.34ZM128,188.69,192.69,124H63.31Z"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 256 256" fill="#a78bfa">
                        <path d="M128,32a96,96,0,1,0,96,96A96.11,96.11,0,0,0,128,32Z" opacity="0.2"/><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm45.66-93.66a8,8,0,0,1,0,11.32l-40,40a8,8,0,0,1-11.32,0l-40-40a8,8,0,0,1,11.32-11.32L120,152.69V88a8,8,0,0,1,16,0v64.69l26.34-26.35A8,8,0,0,1,173.66,122.34Z"/>
                      </svg>
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, color: '#f1f5f9', fontSize: '13px', lineHeight: 1.2, letterSpacing: '-0.01em' }}>
                      {updateStatus === 'downloading' && 'Fetching...'}
                      {updateStatus === 'ready' && 'Update Available'}
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '11px', marginTop: '2px', fontWeight: 500 }}>
                      Version {updateInfo?.version || '...'}
                    </div>
                  </div>
                </div>

                {/* Progress Visual (only during download) */}
                {updateStatus === 'downloading' && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ height: 6, background: 'rgba(255, 255, 255, 0.05)', borderRadius: 99, overflow: 'hidden', border: '1px solid rgba(255, 255, 255, 0.03)' }}>
                      <div style={{
                        height: '100%',
                        width: `${updateProgress}%`,
                        background: 'linear-gradient(90deg, #6366f1, #a855f7)',
                        boxShadow: '0 0 10px rgba(168, 85, 247, 0.5)',
                        borderRadius: 99,
                        transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                      <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>
                        Downloading
                      </span>
                      <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 800 }}>
                        {updateProgress}%
                      </span>
                    </div>
                  </div>
                )}

                {/* Buttons with Premium Styling */}
                {updateStatus === 'available' && (
                  <button
                    onClick={() => {
                      setUpdateStatus('downloading')
                      window.api.downloadUpdate()
                    }}
                    className="upd-action-btn"
                    style={{
                      width: '100%', height: 34, borderRadius: '10px',
                      background: 'rgba(139, 92, 246, 0.15)',
                      border: '1px solid rgba(139, 92, 246, 0.3)',
                      color: '#c4b5fd', fontWeight: 700, fontSize: '12px',
                      cursor: 'pointer', transition: 'all 0.3s ease',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                    }}
                  >
                    <span>Fetch Now</span>
                    <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm45.66-93.66a8,8,0,0,1,0,11.32l-40,40a8,8,0,0,1-11.32,0l-40-40a8,8,0,0,1,11.32-11.32L120,152.69V88a8,8,0,0,1,16,0v64.69l26.34-26.35A8,8,0,0,1,173.66,122.34Z"/></svg>
                  </button>
                )}

                {updateStatus === 'ready' && (
                  <button
                    onClick={() => window.api.installUpdate()}
                    className="upd-action-btn-ready"
                    style={{
                      width: '100%', height: 36, borderRadius: '10px',
                      background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
                      border: 'none', color: '#fff', fontWeight: 800,
                      fontSize: '12px', cursor: 'pointer', transition: 'all 0.3s ease',
                      boxShadow: '0 4px 15px rgba(124, 58, 237, 0.3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      marginTop: 8
                    }}
                  >
                    <span>Install & Restart</span>
                    <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M216,128a8,8,0,0,1-8,8H56a8,8,0,0,1,0-16H208A8,8,0,0,1,216,128Zm-88,56H56a8,8,0,0,0,0,16h72a8,8,0,0,0,0-16Zm72-112H56a8,8,0,0,0,0,16H200a8,8,0,0,0,0-16Z"/></svg>
                  </button>
                )}
                
              </div>

              <style>{`
                @keyframes upd-pulse {
                  0%, 100% { border-color: rgba(139, 92, 246, 0.25); box-shadow: 0 0 20px rgba(139, 92, 246, 0.05); }
                  50% { border-color: rgba(139, 92, 246, 0.5); box-shadow: 0 0 25px rgba(139, 92, 246, 0.15); }
                }
                @keyframes upd-rotate {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
                @keyframes upd-bounce {
                  0%, 100% { transform: translateY(0); }
                  50% { transform: translateY(3px); }
                }
                .upd-action-btn:hover {
                  background: rgba(139, 92, 246, 0.25) !important;
                  transform: translateY(-1px);
                }
                .upd-action-btn-ready:hover {
                  filter: brightness(1.1);
                  transform: translateY(-1px);
                  box-shadow: 0 6px 20px rgba(124, 58, 237, 0.4) !important;
                }
              `}</style>
            </div>
          )}

          <footer className="sidebar-footer-enhanced">
            <div 
              className="user-brief clickable" 
              onClick={() => setShowEmail(!showEmail)}
              title={showEmail ? "Click to show Name" : "Click to show Email"}
            >
              <div className="ub-left">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" className="text-secondary">
                  <path d="M234.38,210a123.36,123.36,0,0,0-60.78-53.23,72,72,0,1,0-91.2,0A123.36,123.36,0,0,0,21.62,210a8,8,0,1,0,13.85,8C49.13,193.53,77.37,180,109,177.8l12.16,30.4a8,8,0,0,0,14.8,0L148.12,177.8c31.63,2.2,59.87,15.73,73.53,40.2a8,8,0,1,0,13.73-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Zm56,88.65L120.35,168h15.3ZM136,160h0Z" />
                </svg>
                <span className="user-email-truncate">
                  {showEmail 
                    ? (userProfile?.email || 'Guest User')
                    : ((userProfile as any)?.full_name || userProfile?.email?.split('@')[0] || 'Guest User')
                  }
                </span>
              </div>
              <button
                className="sidebar-logout-icon"
                onClick={async () => {
                  await window.api.supabaseLogout()
                  onLogout?.()
                }}
                title="Log Out"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M120,216a8,8,0,0,1-8,8H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h64a8,8,0,0,1,0,16H48V208h64A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z" />
                </svg>
              </button>
            </div>

            <div className="sidebar-stat-grid">
              <div className="stat-pill-modern">
                <div className="spm-label">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#8B5CF6" viewBox="0 0 256 256">
                    <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm0,144H32V64H224V192ZM64,128a8,8,0,0,1,8-8H96a8,8,0,0,1,0,16H72A8,8,0,0,1,64,128Zm48,0a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H120A8,8,0,0,1,112,128Z" />
                  </svg>
                  <span>Sessions</span>
                </div>
                <span className="spm-value">{sessionsBalance}</span>
              </div>
              <div className="stat-pill-modern">
                <div className="spm-label">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#F59E0B" viewBox="0 0 256 256">
                    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z" />
                  </svg>
                  <span>Trial</span>
                </div>
                <span className="spm-value">{formatTime(trialRemainingSeconds)}</span>
              </div>
            </div>
          </footer>
        </aside>

        <section className="setup-main-content">
          <header className="step-header-refined">
            <div className="shr-left">
              <h1 className="shr-title">
                {step === 1 && 'Tell us about you'}
                {step === 2 && 'Resume Library'}
                {step === 3 && 'Final Check'}
              </h1>
              <p className="shr-desc">
                {step === 1 && "Personalize your AI assistant's background context."}
                {step === 2 && 'Manage and select the resume for this session.'}
                {step === 3 && 'Review your configuration before starting.'}
              </p>
            </div>
            <div className="shr-right">
              <button 
                className="ov-action-btn refresh no-drag" 
                title="Refresh Stats" 
                onClick={async () => {
                  if (refreshState !== 'idle') return;
                  setRefreshState('refreshing');
                  try {
                    const profile = await window.api.supabaseGetProfile();
                    if (profile) {
                      window.dispatchEvent(new CustomEvent('force-profile-refresh', { detail: profile }));
                    }
                  } finally {
                    setTimeout(() => {
                      setRefreshState('success');
                      setTimeout(() => setRefreshState('idle'), 2000);
                    }, 1000);
                  }
                }}
              >
                <div style={{ position: 'relative', width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {/* Spinner Icon */}
                  <div className={`refresh-wrapper ${refreshState === 'success' ? 'refresh-out' : 'refresh-in'}`}>
                    <svg 
                      className={refreshState === 'refreshing' ? 'refresh-spin' : ''}
                      xmlns="http://www.w3.org/2000/svg" 
                      width="15" height="15" viewBox="0 0 24 24" 
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                      <path d="M3 3v5h5"/>
                    </svg>
                  </div>
                  {/* Success Icon */}
                  <div className={`refresh-wrapper refresh-icon-check ${refreshState === 'success' ? 'refresh-in' : 'refresh-out'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                </div>
              </button>
              <button className="ov-action-btn close no-drag" title="Close" onClick={() => window.api.quitApp()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </header>

          <div className="content-scrollable">
            {step === 1 && (
              <div className="setup-step fade-in">

                <div className="step-body">
                  <div
                    className={`toggle-card-modern ${autoAnswer ? 'active' : ''}`}
                    onClick={() => {
                      const newVal = !autoAnswer
                      setAutoAnswer(newVal)
                      saveData({ autoAnswer: newVal })
                    }}
                  >
                    <div className="tc-info">
                      <div className="tc-title-row">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256" className="text-purple-400">
                          <path d="M200,48H136V16a8,8,0,0,0-16,0V48H56A32,32,0,0,0,24,80V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V80A32,32,0,0,0,200,48ZM152,176a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,176Zm16-40a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Z" opacity="0.2" /><path d="M200,40H136V16a8,8,0,0,0-16,0V40H56A32,32,0,0,0,24,72V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V72A32,32,0,0,0,200,40Zm16,152a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V72A16,16,0,0,1,56,56H200a16,16,0,0,1,16,16ZM80,108a12,12,0,1,1,12,12A12,12,0,0,1,80,108Zm72,0a12,12,0,1,1,12,12A12,12,0,0,1,152,108Z" />
                        </svg>
                        <span className="tc-title">Auto-Answer Mode</span>
                        <span className="tc-badge">BETA</span>
                      </div>
                      <p className="tc-desc">
                        AI operates continuously, automatically answering every 5 seconds.
                      </p>
                    </div>
                    <div className="tc-switch"><div className="tc-knob" /></div>
                  </div>

                  <div className="field-group-modern">
                    <label>Your Full Name *</label>
                    <div className="input-with-icon">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                        <path d="M234.38,210a123.36,123.36,0,0,0-60.78-53.23,72,72,0,1,0-91.2,0A123.36,123.36,0,0,0,21.62,210a8,8,0,1,0,13.85,8C49.13,193.53,77.37,180,109,177.8l12.16,30.4a8,8,0,0,0,14.8,0L148.12,177.8c31.63,2.2,59.87,15.73,73.53,40.2a8,8,0,1,0,13.73-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z" />
                      </svg>
                      <input
                        placeholder="e.g. Rahul Sharma"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value)
                          saveData({ name: e.target.value })
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="field-group-modern">
                      <label>Applying for Role *</label>
                      <div className="input-with-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                          <path d="M216,56H176V48a24,24,0,0,0-24-24H104A24,24,0,0,0,80,48v8H40A16,16,0,0,0,24,72V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V72A16,16,0,0,0,216,56ZM96,48a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96ZM216,200H40V72H216V200Z" />
                        </svg>
                        <input
                          placeholder="e.g. Software Engineer"
                          value={role}
                          onChange={(e) => {
                            setRole(e.target.value)
                            saveData({ role: e.target.value })
                          }}
                        />
                      </div>
                    </div>
                    <div className="field-group-modern">
                      <label>Company (Interviewing For)</label>
                      <div className="input-with-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                          <path d="M240,208H224V96a16,16,0,0,0-16-16H144V48a16,16,0,0,0-24.88-13.32L39.12,82.91A16,16,0,0,0,32,96V208H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM208,96V208H144V96ZM48,96l80-48V208H48Z" />
                        </svg>
                        <input
                          placeholder="e.g. Google"
                          value={company}
                          onChange={(e) => {
                            setCompany(e.target.value)
                            saveData({ company: e.target.value })
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="field-group-modern">
                    <label>Preferred Coding Language *</label>
                    <div className="input-with-icon">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                        <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H40V56H216V200ZM184,96a8,8,0,0,1-8,8H144v24a8,8,0,0,1-16,0V104H88a8,8,0,0,1,0-16h40V64a8,8,0,0,1,16,0V88h32A8,8,0,0,1,184,96Z" />
                      </svg>
                      <select
                        value={codingLanguage}
                        onChange={(e) => {
                          setCodingLanguage(e.target.value)
                          saveData({ codingLanguage: e.target.value })
                        }}
                        style={{
                          width: '100%',
                          background: 'transparent',
                          border: 'none',
                          color: '#e2e8f0',
                          padding: '10px 12px 10px 42px',
                          fontSize: '14px',
                          outline: 'none',
                          cursor: 'pointer',
                          appearance: 'none',
                          fontWeight: 500
                        }}
                      >
                        {CODING_LANGUAGES.map(lang => (
                          <option key={lang} value={lang} style={{ background: '#1e1b4b', color: '#fff' }}>
                            {lang}
                          </option>
                        ))}
                      </select>
                      <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#64748b' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  <div className="field-group-modern">
                    <label>Experience Level *</label>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                      <button
                        type="button"
                        onClick={() => { setExperienceLevel('fresher'); saveData({ experienceLevel: 'fresher' }) }}
                        style={{
                          flex: 1, padding: '10px 0', borderRadius: '10px', fontWeight: 700, fontSize: '13px',
                          cursor: 'pointer', transition: 'all 0.2s ease',
                          background: experienceLevel === 'fresher' ? 'linear-gradient(135deg, rgba(139,92,246,0.3), rgba(99,102,241,0.2))' : 'rgba(255,255,255,0.04)',
                          border: experienceLevel === 'fresher' ? '1.5px solid rgba(139,92,246,0.6)' : '1.5px solid rgba(255,255,255,0.08)',
                          color: experienceLevel === 'fresher' ? '#c4b5fd' : '#64748b'
                        }}
                      >
                        🎓 Fresher
                      </button>
                      <button
                        type="button"
                        onClick={() => { setExperienceLevel('experienced'); saveData({ experienceLevel: 'experienced' }) }}
                        style={{
                          flex: 1, padding: '10px 0', borderRadius: '10px', fontWeight: 700, fontSize: '13px',
                          cursor: 'pointer', transition: 'all 0.2s ease',
                          background: experienceLevel === 'experienced' ? 'linear-gradient(135deg, rgba(139,92,246,0.3), rgba(99,102,241,0.2))' : 'rgba(255,255,255,0.04)',
                          border: experienceLevel === 'experienced' ? '1.5px solid rgba(139,92,246,0.6)' : '1.5px solid rgba(255,255,255,0.08)',
                          color: experienceLevel === 'experienced' ? '#c4b5fd' : '#64748b'
                        }}
                      >
                        💼 Experienced
                      </button>
                    </div>
                    {experienceLevel === 'experienced' && (
                      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div className="input-with-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                            <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z" />
                          </svg>
                          <input
                            placeholder="How long? e.g. 6 months, 1 year, 2.5 years"
                            value={experienceDuration}
                            onChange={(e) => {
                              setExperienceDuration(e.target.value)
                              saveData({ experienceDuration: e.target.value })
                            }}
                          />
                        </div>
                        <textarea
                          placeholder="(Optional) Past work details — e.g. Worked at TechCorp as a React developer for 1 year, built an e-commerce platform."
                          value={workHistory}
                          rows={3}
                          onChange={(e) => {
                            setWorkHistory(e.target.value)
                            saveData({ workHistory: e.target.value })
                          }}
                          style={{
                            width: '100%',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1.5px solid rgba(255,255,255,0.08)',
                            borderRadius: '10px',
                            color: '#e2e8f0',
                            padding: '10px 12px',
                            fontSize: '13px',
                            resize: 'vertical',
                            outline: 'none',
                            fontFamily: 'inherit',
                            lineHeight: 1.5
                          }}
                        />
                        <p style={{ fontSize: '11px', color: '#475569', margin: 0 }}>If left blank, AI will only mention your experience duration without any past work details.</p>
                      </div>
                    )}
                  </div>

                  <div className="field-group-modern">
                    <label>Interview Language</label>
                    <div className="input-with-icon">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                        <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm87.63,96H175.8c-1.42-28.28-10.29-55.74-25.65-78.1A88.2,88.2,0,0,1,215.63,120ZM128,215.89C109,193.14,97.15,162.06,96.12,128h63.76C158.85,162.06,147,193.14,128,215.89Zm0-103.78C109,89.06,120.85,58,128,40.11,147,62.86,158.85,93.94,159.88,112ZM105.85,41.9C90.49,64.26,81.62,91.72,80.2,120H40.37A88.2,88.2,0,0,1,105.85,41.9ZM40.37,136H80.2c1.42,28.28,10.29,55.74,25.65,78.1A88.2,88.2,0,0,1,40.37,136Zm109.78,78.1c15.36-22.36,24.23-49.82,25.65-78.1h39.83A88.2,88.2,0,0,1,150.15,214.1Z" />
                      </svg>
                      <select
                        value={language}
                        onChange={(e) => {
                          setLanguage(e.target.value)
                          saveData({ language: e.target.value })
                        }}
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}

            {step === 2 && (
              <div className="setup-step fade-in">

                <div className="step-body">
                  <button className="add-resume-btn-large" onClick={handlePickResume}>
                    <div className="plus-icon">+</div>
                    <div className="btn-text">
                      <p className="title">Upload New Resume</p>
                      <p className="subtitle">PDF format recommended</p>
                    </div>
                  </button>

                  <div className="resume-list-modern">
                    {resumes.map((r) => (
                      <div
                        key={r.id}
                        className={`resume-item-modern ${selectedResumeId === r.id ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedResumeId(r.id)
                          saveData({ selectedResumeId: r.id })
                        }}
                      >
                        <div className="ri-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                            <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                          </svg>
                        </div>
                        <div className="ri-info">
                          <p className="ri-name">{r.name}</p>
                          <p className="ri-meta">ID: {r.id.substring(r.id.length - 4)}</p>
                        </div>
                        {selectedResumeId === r.id && <div className="ri-active-dot" />}
                        <button className="ri-delete" onClick={(e) => handleDeleteResume(r.id, e)}>×</button>
                      </div>
                    ))}
                    {resumes.length === 0 && !resumeFile && (
                      <div className="empty-state-modern">
                        <p>No resumes uploaded yet.</p>
                      </div>
                    )}
                  </div>

                  {resumeFile && (
                    <div className="parsing-status-modern">
                      <div className="ps-info">
                        <span className="ps-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                            <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                          </svg>
                        </span>
                        <span className="ps-name">{resumeFile.name}</span>
                      </div>
                      <div className="ps-actions">
                        <button className="secondary-btn btn-sm" onClick={() => setResumeFile(null)}>
                          Cancel
                        </button>
                        <button className="parse-btn-modern" onClick={handleParseResume} disabled={isParsing}>
                          {isParsing ? 'Processing...' : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M215.79,121.79l-45.17,14.65a8,8,0,0,0-5.22,5.22l-14.65,45.17a8,8,0,0,1-15.2,0L121,141.66A8,8,0,0,0,114.34,135L69.17,120.35a8,8,0,0,1,0-15.2l45.17-14.65a8,8,0,0,0,5.22-5.22L134.21,40.11a8,8,0,0,1,15.2,0L164.06,85.28a8,8,0,0,0,5.22,5.22l45.17,14.65a8,8,0,0,1,1.34,16.64Z" />
                              </svg>
                              <span>Parse</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}

            {step === 3 && (
              <div className="setup-step fade-in">

                <div className="step-body">
                  <div className="dashboard-summary-grid">
                    <div className="summary-card">
                      <p className="card-label">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="opacity-70">
                          <path d="M234.38,210a123.36,123.36,0,0,0-60.78-53.23,72,72,0,1,0-91.2,0A123.36,123.36,0,0,0,21.62,210a8,8,0,1,0,13.85,8C49.13,193.53,77.37,180,109,177.8l12.16,30.4a8,8,0,0,0,14.8,0L148.12,177.8c31.63,2.2,59.87,15.73,73.53,40.2a8,8,0,1,0,13.73-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Zm56,88.65L120.35,168h15.3ZM136,160h0Z" />
                        </svg>
                        <span>Profile</span>
                      </p>
                      <p className="card-val">{name}</p>
                      <p className="card-sub">{role} @ {company || 'N/A'}</p>
                    </div>
                    <div className="summary-card">
                      <p className="card-label">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="opacity-70">
                          <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm87.63,96H175.8c-1.42-28.28-10.29-55.74-25.65-78.1A88.2,88.2,0,0,1,215.63,120ZM128,215.89C109,193.14,97.15,162.06,96.12,128h63.76C158.85,162.06,147,193.14,128,215.89Zm0-103.78C109,89.06,120.85,58,128,40.11,147,62.86,158.85,93.94,159.88,112ZM105.85,41.9C90.49,64.26,81.62,91.72,80.2,120H40.37A88.2,88.2,0,0,1,105.85,41.9ZM40.37,136H80.2c1.42,28.28,10.29,55.74,25.65,78.1A88.2,88.2,0,0,1,40.37,136Zm109.78,78.1c15.36-22.36,24.23-49.82,25.65-78.1h39.83A88.2,88.2,0,0,1,150.15,214.1Z" />
                        </svg>
                        <span>Settings</span>
                      </p>
                      <p className="card-val">{LANGUAGES.find((l) => l.code === language)?.label}</p>
                      <p className="card-sub">{autoAnswer ? 'Auto Answer' : 'Manual Mode'}</p>
                    </div>
                    <div className="summary-card">
                      <p className="card-label">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="opacity-70">
                          <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z" />
                        </svg>
                        <span>Selected Resume</span>
                      </p>
                      <p className="card-val">
                        {resumes.find((r) => r.id === selectedResumeId)?.name || 'None'}
                      </p>
                      <p className="card-sub">
                        ID: {selectedResumeId ? selectedResumeId.substring(selectedResumeId.length - 4) : 'N/A'}
                      </p>
                    </div>
                    <div className="summary-card">
                      <p className="card-label">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" className="opacity-70">
                          <path d="M216,48V208a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V48A16,16,0,0,1,56,32h16V24a8,8,0,0,1,16,0v8h80V24a8,8,0,0,1,16,0v8h16A16,16,0,0,1,216,48ZM176,120a12,12,0,1,0-12,12A12,12,0,0,0,176,120ZM92,120a12,12,0,1,0,12-12A12,12,0,0,0,92,120Zm44,40a28,28,0,0,1,28,28,8,8,0,0,1-16,0,12,12,0,0,0-24,0,8,8,0,0,1-16,0A28,28,0,0,1,136,160Z" />
                        </svg>
                        <span>Account Status</span>
                      </p>
                      <p className="card-val">
                        {sessionsBalance > 0 ? `${sessionsBalance} Sessions` : 'Interview Trial'}
                      </p>
                      <p className="card-sub">
                        {sessionsBalance > 0 ? 'Full Access' : `${formatTime(trialRemainingSeconds)} Remaining`}
                      </p>
                    </div>
                  </div>

                  <div className="shortcut-guide-modern">
                    <p className="guide-title">Interview Panel Controls</p>
                    <div className="guide-items">
                      <div className="gi-item">
                        <div className="gi-label">
                          <span className="gi-icon">🎙️</span>
                          <span>Run / Stop</span>
                        </div>
                        <kbd>Alt + Space</kbd>
                      </div>
                      <div className="gi-item">
                        <div className="gi-label">
                          <span className="gi-icon">🔍</span>
                          <span>Screen Scan</span>
                        </div>
                        <kbd>Alt + S</kbd>
                      </div>
                      <div className="gi-item">
                        <div className="gi-label">
                          <span className="gi-icon">↕️</span>
                          <span>Scroll Up/Down</span>
                        </div>
                        <kbd>Num 8 / 2</kbd>
                      </div>
                      <div className="gi-item">
                        <div className="gi-label">
                          <span className="gi-icon">📍</span>
                          <span>Move Overlay</span>
                        </div>
                        <kbd>Ctrl + Arrows</kbd>
                      </div>
                    </div>
                  </div>
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}
            {showPaywall && (
              <div className="paywall-overlay fade-in">
                <div className="card paywall-card relative">
                  {/* Decorative background glow */}
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-32 bg-indigo-500/20 blur-[50px] pointer-events-none" />
                  
                  <div className="paywall-badge">🚀 PREMIUM UPGRADE</div>
                  
                  <div className="paywall-benefits">
                    <div className="benefit-item">
                      <div className="benefit-icon-wrapper">✨</div>
                      <span><strong>Unlimited</strong> Session Time</span>
                    </div>
                    <div className="benefit-item">
                      <div className="benefit-icon-wrapper">🧠</div>
                      <span><strong>AI Models</strong> (GPT-5 & Claude Support)</span>
                    </div>
                    <div className="benefit-item">
                      <div className="benefit-icon-wrapper">⚡</div>
                      <span><strong>Real-time</strong> Fast Answers</span>
                    </div>
                    <div className="benefit-item">
                      <div className="benefit-icon-wrapper">🛠️</div>
                      <span><strong>24/7</strong> Priority Support</span>
                    </div>
                  </div>

                  <div className="btn-row vertical">
                    <button
                      className="primary-action-btn shimmer-btn"
                      onClick={() =>
                        window.api.openExternal('https://zyro-interview-website.vercel.app/#/dashboard/billing')
                      }
                    >
                      <div className="btn-shine" />
                      🎯 Choose Your Plan
                    </button>
                    <button className="secondary-btn-flat" onClick={() => setShowPaywall(false)}>
                      Maybe later, continue exploring
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="content-footer-enhanced">
            {step === 1 && (
              <div className="footer-btn-row">
                <div /> {/* Spacer to push button to the right */}
                <button
                  className="primary-action-btn shimmer-btn"
                  onClick={() => {
                    if (!name || !role) {
                      setError('Name and Role are required.')
                      return
                    }
                    setError('')
                    setStep(2)
                  }}
                >
                  <div className="btn-shine" />
                  <span>{resumes.length > 0 ? '✓ View My Library' : 'Submit'}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
                  </svg>
                </button>
              </div>
            )}
            {step === 2 && (
              <div className="footer-btn-row">
                <button className="secondary-btn" onClick={() => setStep(1)}>
                  ← Back
                </button>
                <button
                  className="primary-action-btn shimmer-btn"
                  onClick={() => setStep(3)}
                  disabled={!selectedResumeId}
                >
                  <div className="btn-shine" />
                  <span>{selectedResumeId ? 'Review & Start' : 'Select Resume'}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
                  </svg>
                </button>
              </div>
            )}
            {step === 3 && (
              <div className="footer-btn-row">
                <button className="secondary-btn" onClick={() => setStep(2)}>
                  ← Back
                </button>
                <button
                  className="primary-action-btn success shimmer-btn"
                  onClick={handleStartInterview}
                >
                  <div className="btn-shine" />
                  <span>Start Interview Session</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
                  </svg>
                </button>
              </div>
            )}
          </footer>
        </section>
      </div>
    </div>
  )
}
