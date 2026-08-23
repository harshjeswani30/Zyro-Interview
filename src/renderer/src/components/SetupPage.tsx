import React, { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { parseResumePDF, refineResumeWithAI, initAI, SessionData } from '../services/aiService'
import ZyroMascot from './ZyroMascot'
import Tooltip from './Tooltip'
import CloudSyncButton from './CloudSyncButton'
import MinimalUpdateButton from './MinimalUpdateButton'
import TeleprompterText from './TeleprompterText'

const HAMBURGER_VARIANTS = {
  top: {
    open: {
      rotate: ['0deg', '0deg', '45deg'],
      top: ['28%', '50%', '50%']
    },
    closed: {
      rotate: ['45deg', '0deg', '0deg'],
      top: ['50%', '50%', '28%']
    }
  },
  middle: {
    open: {
      rotate: ['0deg', '0deg', '-45deg']
    },
    closed: {
      rotate: ['-45deg', '0deg', '0deg']
    }
  },
  bottom: {
    open: {
      rotate: ['0deg', '0deg', '45deg'],
      top: ['72%', '50%', '50%'],
      left: '50%',
      opacity: [1, 0.4, 0],
      scaleX: [1, 0.4, 0]
    },
    closed: {
      rotate: ['45deg', '0deg', '0deg'],
      top: ['50%', '50%', '72%'],
      left: 'calc(50% + 4px)',
      opacity: [0, 0.4, 1],
      scaleX: [0, 0.4, 1]
    }
  }
}

function AnimatedHamburgerButton({
  active,
  onClick
}: {
  active: boolean
  onClick: (e: React.MouseEvent) => void
}): React.ReactElement {
  return (
    <MotionConfig
      transition={{
        duration: 0.35,
        ease: 'easeInOut'
      }}
    >
      <motion.button
        type="button"
        initial={false}
        animate={active ? 'open' : 'closed'}
        onClick={onClick}
        className="no-drag"
        style={{
          position: 'relative',
          width: '34px',
          height: '34px',
          borderRadius: '9px',
          background: active ? 'rgba(139, 92, 246, 0.25)' : 'rgba(255, 255, 255, 0.04)',
          border: active ? '1px solid rgba(167, 139, 250, 0.5)' : '1px solid rgba(255, 255, 255, 0.08)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
          padding: 0,
          boxShadow: active ? '0 0 14px rgba(139, 92, 246, 0.35)' : 'none',
          transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
          marginLeft: 'auto',
          flexShrink: 0
        }}
      >
        <motion.span
          variants={HAMBURGER_VARIANTS.top}
          style={{
            position: 'absolute',
            height: '2px',
            width: '18px',
            background: active ? '#c4b5fd' : '#ffffff',
            borderRadius: '2px',
            left: '50%',
            top: '28%',
            x: '-50%',
            y: '-50%'
          }}
        />
        <motion.span
          variants={HAMBURGER_VARIANTS.middle}
          style={{
            position: 'absolute',
            height: '2px',
            width: '18px',
            background: active ? '#c4b5fd' : '#ffffff',
            borderRadius: '2px',
            left: '50%',
            top: '50%',
            x: '-50%',
            y: '-50%'
          }}
        />
        <motion.span
          variants={HAMBURGER_VARIANTS.bottom}
          style={{
            position: 'absolute',
            height: '2px',
            width: '10px',
            background: active ? '#c4b5fd' : '#ffffff',
            borderRadius: '2px',
            top: '72%',
            left: 'calc(50% + 4px)',
            x: '-50%',
            y: '-50%',
            transformOrigin: 'center right'
          }}
        />
      </motion.button>
    </MotionConfig>
  )
}
// supabase.ts still used by ragService, not needed directly here
// ragService functions (chunkText, EmbeddingProvider) now run in main process — no renderer import needed
// Lucide imports removed as we use raw SVGs for exact reference matching

const STORAGE_KEY = 'interview_assistant_session'

const LANGUAGES = [
  // 'auto' lets Whisper detect the language per utterance, which is the only way
  // to handle a Hindi/English code-switched interview — pinning en-US made Whisper
  // translate Hindi speech into garbled English. Kept first so it is the default.
  { code: 'auto', label: '🌐 Hinglish / Auto-detect' },
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

interface CodingLanguageOption {
  id: string
  name: string
  icon: string
  tag: string
}

const CODING_LANGUAGES: CodingLanguageOption[] = [
  { id: 'Python', name: 'Python', icon: '🐍', tag: 'AI & Data / Scripting' },
  { id: 'JavaScript', name: 'JavaScript', icon: '🟨', tag: 'Web & Fullstack' },
  { id: 'TypeScript', name: 'TypeScript', icon: '🔷', tag: 'Frontend & Node' },
  { id: 'Java', name: 'Java', icon: '☕', tag: 'Enterprise & Android' },
  { id: 'C++', name: 'C++', icon: '⚡', tag: 'DSA & Systems' },
  { id: 'SQL', name: 'SQL', icon: '🗄️', tag: 'Database & Analytics' },
  { id: 'C#', name: 'C#', icon: '🟣', tag: '.NET & Game Dev' },
  { id: 'Go', name: 'Go (Golang)', icon: '🐹', tag: 'Cloud & Microservices' },
  { id: 'Rust', name: 'Rust', icon: '🦀', tag: 'High-Performance' },
  { id: 'Kotlin', name: 'Kotlin', icon: '🎯', tag: 'Android & Server' },
  { id: 'Swift', name: 'Swift', icon: '🍎', tag: 'iOS & macOS' },
  { id: 'PHP', name: 'PHP', icon: '🐘', tag: 'Backend Web' },
  { id: 'Ruby', name: 'Ruby', icon: '💎', tag: 'Rails & Scripting' }
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
  interviewContent?: string
  activeKbId?: string
}

interface UserProfile {
  id?: string
  email?: string
  sessions_balance?: number
  phone_sessions_balance?: number
  trial_seconds_used?: number
  [key: string]: unknown
}

interface ShortcutTeleprompterCardProps {
  icon: string
  title: string
  keyLabel: string | React.ReactNode
  keyColor: 'purple' | 'blue' | 'emerald' | 'amber' | 'pink' | 'slate'
  desc: string
}

function ShortcutTeleprompterCard({
  icon,
  title,
  keyLabel,
  keyColor,
  desc
}: ShortcutTeleprompterCardProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLParagraphElement>(null)
  const [scrollDistance, setScrollDistance] = useState<number>(0)
  const [isHovered, setIsHovered] = useState<boolean>(false)
  const [isClicked, setIsClicked] = useState<boolean>(false)

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
  }, [desc])

  const active = (isHovered || isClicked) && scrollDistance > 0
  const duration = Math.max(2.8, scrollDistance / 40)

  return (
    <div
      className={`fc-shortcut-card ${isClicked ? 'clicked-active' : ''}`}
      onClick={() => {
        measureOverflow()
        setIsClicked((prev) => !prev)
      }}
      onMouseEnter={() => {
        measureOverflow()
        setIsHovered(true)
      }}
      onMouseLeave={() => {
        setIsHovered(false)
      }}
    >
      <div className="fc-shortcut-card-header">
        <div className="fc-sc-left">
          <span className="fc-sc-icon">{icon}</span>
          <span className="fc-sc-title">{title}</span>
        </div>
        {typeof keyLabel === 'string' ? (
          <span className={`fc-sc-key ${keyColor}`}>{keyLabel}</span>
        ) : (
          keyLabel
        )}
      </div>
      <div ref={containerRef} className={`fc-sc-desc-wrapper ${active ? 'overflowing' : ''}`}>
        <p
          ref={textRef}
          className={`fc-sc-desc ${active ? 'teleprompter-active' : ''}`}
          style={
            active
              ? ({
                  '--scroll-offset': `${scrollDistance}px`,
                  '--scroll-duration': `${duration}s`
                } as React.CSSProperties)
              : undefined
          }
        >
          {desc}
        </p>
      </div>
    </div>
  )
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
  const [step, setStep] = useState<1 | 2 | 3 | 'knowledge_base'>(1)
  const [activeKbId, setActiveKbId] = useState('')
  const [kbs, setKbs] = useState<{ id: string; title: string; created_at: string }[]>([])
  const [newKbTitle, setNewKbTitle] = useState('')
  const [newKbContent, setNewKbContent] = useState('')
  const [kbLoading, setKbLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoAnswer, setAutoAnswer] = useState(true)
  const [experienceLevel, setExperienceLevel] = useState<'fresher' | 'experienced'>('fresher')
  const [experienceDuration, setExperienceDuration] = useState('')
  const [workHistory, setWorkHistory] = useState('')
  const [codingLanguage, setCodingLanguage] = useState('Python')
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const langDropdownRef = React.useRef<HTMLDivElement>(null)
  const [isSidebarMenuOpen, setIsSidebarMenuOpen] = useState(false)
  const menuContainerRef = React.useRef<HTMLDivElement>(null)
  const [interviewContent, setInterviewContent] = useState('')
  const [resumeInputMode, setResumeInputMode] = useState<'upload' | 'text'>('upload')
  const [manualResumeTitle, setManualResumeTitle] = useState('')
  const [manualResumeText, setManualResumeText] = useState('')
  const [showPaywall, setShowPaywall] = useState(false)
  const [showEmail, setShowEmail] = useState(false)

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

  useEffect(() => {
    if (isSidebarMenuOpen) {
      document.body.classList.add('quick-menu-active')
    } else {
      document.body.classList.remove('quick-menu-active')
    }
    return () => {
      document.body.classList.remove('quick-menu-active')
    }
  }, [isSidebarMenuOpen])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(event.target as Node)) {
        setIsLangDropdownOpen(false)
      }
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setIsSidebarMenuOpen(false)
      }
    }
    if (isLangDropdownOpen || isSidebarMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isLangDropdownOpen, isSidebarMenuOpen])

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
        setInterviewContent(saved.interviewContent || '')
        setActiveKbId(saved.activeKbId || '')
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
        interviewContent,
        activeKbId,
        ...overrides
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    [name, role, company, language, resumes, selectedResumeId, autoAnswer, experienceLevel, experienceDuration, workHistory, codingLanguage, interviewContent, activeKbId]
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
        codingLanguage,
        interviewContent: interviewContent.trim() ? interviewContent.trim() : undefined,
        activeKbId: activeKbId || undefined
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
  }, [resumeFile, name, role, company, language, autoAnswer, resumes, saveData, experienceLevel, experienceDuration, workHistory, codingLanguage, interviewContent, activeKbId])

  const handleSaveManualResume = useCallback(async () => {
    if (!manualResumeText.trim()) {
      setError('Please enter or paste your resume text.')
      return
    }
    const title = manualResumeTitle.trim() || `Resume ${resumes.length + 1}`
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
        codingLanguage,
        interviewContent: interviewContent.trim() ? interviewContent.trim() : undefined,
        activeKbId: activeKbId || undefined
      })
      let refinedText = ''
      try {
        refinedText = await refineResumeWithAI(manualResumeText.trim())
      } catch {
        refinedText = manualResumeText.trim()
      }
      const newResume: Resume = {
        id: Date.now().toString(),
        name: title,
        text: refinedText || manualResumeText.trim()
      }
      const updatedResumes = [...resumes, newResume]
      setResumes(updatedResumes)
      setSelectedResumeId(newResume.id)
      setManualResumeTitle('')
      setManualResumeText('')
      saveData({ resumes: updatedResumes, selectedResumeId: newResume.id })
      setError('')
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setError(`Failed to save resume: ${message}`)
    } finally {
      setIsParsing(false)
    }
  }, [manualResumeTitle, manualResumeText, name, role, company, language, autoAnswer, resumes, saveData, experienceLevel, experienceDuration, workHistory, codingLanguage, interviewContent, activeKbId])

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
      codingLanguage,
      interviewContent: interviewContent.trim() ? interviewContent.trim() : undefined,
      activeKbId: activeKbId || undefined
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
    saveData,
    experienceLevel,
    experienceDuration,
    workHistory,
    codingLanguage,
    interviewContent,
    activeKbId
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

  const fetchKbs = useCallback(async () => {
    setKbLoading(true)
    try {
      const savedKbs = localStorage.getItem('zyro_local_kbs')
      if (savedKbs) {
        setKbs(JSON.parse(savedKbs))
      } else {
        setKbs([])
      }
    } catch (err: any) {
      console.error('[KB] Failed to fetch local KBs:', err)
      setKbs([])
    } finally {
      setKbLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchKbs()
  }, [fetchKbs])

  const [showKbAddForm, setShowKbAddForm] = useState(false)

  const handleSaveAndProcessKb = useCallback(async () => {
    if (!newKbTitle.trim()) {
      setError('Please provide a title.')
      return
    }
    if (!newKbContent.trim()) {
      setError('Please paste some interview content.')
      return
    }

    setKbLoading(true)
    setError('')

    const savedId = `kb_${Date.now()}`
    const newKbItem = {
      id: savedId,
      title: newKbTitle.trim(),
      content: newKbContent.trim(),
      created_at: new Date().toISOString()
    }

    try {
      console.log('[KB] Indexing locally into localVectorDb...')
      await window.api.kbSave({
        title: newKbTitle.trim(),
        content: newKbContent.trim()
      })

      setKbs(prev => {
        const next = [newKbItem, ...prev.filter(item => item.title !== newKbTitle.trim())]
        localStorage.setItem('zyro_local_kbs', JSON.stringify(next))
        return next
      })

      setActiveKbId(savedId)
      saveData({ activeKbId: savedId })
      setNewKbTitle('')
      setNewKbContent('')
      setShowKbAddForm(false)
      console.log('[KB] Saved locally successfully:', savedId)
    } catch (err: any) {
      console.error('[KB] Save failed:', err)
      setError(`Failed to save: ${err.message}`)
    } finally {
      setKbLoading(false)
    }
  }, [newKbTitle, newKbContent, saveData])


  const handleDeleteKb = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Are you sure you want to delete this knowledge base material?')) return

    setKbLoading(true)
    setError('')
    try {
      const target = kbs.find((k) => k.id === id)
      await window.api.kbDelete(target?.title ? 'kb_' + target.title : id)

      setKbs(prev => {
        const next = prev.filter(item => item.id !== id)
        localStorage.setItem('zyro_local_kbs', JSON.stringify(next))
        return next
      })

      if (activeKbId === id) {
        setActiveKbId('')
        saveData({ activeKbId: '' })
      }
    } catch (err: any) {
      console.error('[KB] Delete failed:', err)
      setError(`Failed to delete: ${err.message}`)
    } finally {
      setKbLoading(false)
    }
  }, [activeKbId, saveData, fetchKbs])


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
          <div
            className="sidebar-logo"
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '20px 16px',
              width: '100%',
              boxSizing: 'border-box'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <div className="logo-box" style={{ width: '42px', height: '42px', flexShrink: 0 }}>
                <ZyroMascot size={42} strokeColor="#a78bfa" />
              </div>
              <span className="logo-text" style={{ fontSize: '15px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.3px', whiteSpace: 'nowrap' }}>
                Zyro AI
              </span>
            </div>

            <div ref={menuContainerRef} className="no-drag" style={{ position: 'relative', display: 'inline-flex', zIndex: 999999 }}>
              <AnimatedHamburgerButton
                active={isSidebarMenuOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  setIsSidebarMenuOpen((prev) => !prev)
                }}
              />

              {/* Quick Flyout Dropdown Menu */}
              <AnimatePresence>
                {isSidebarMenuOpen && (
                  <>
                    <div
                      className="no-drag"
                      onClick={() => setIsSidebarMenuOpen(false)}
                      style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 999990,
                        background: 'transparent',
                        cursor: 'default'
                      }}
                    />
                    <motion.div
                      className="sidebar-quick-menu no-drag"
                      initial={{ opacity: 0, y: -4, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.95 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        left: '0px',
                        width: '200px',
                        zIndex: 999999,
                        pointerEvents: 'auto'
                      }}
                    >
                  {/* 1. Terms and Conditions */}
                  <button
                    type="button"
                    className="sqm-item"
                    onClick={() => {
                      setIsSidebarMenuOpen(false)
                      window.api.openExternal('https://zyro-ai.in/#/terms')
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor">
                      <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                    </svg>
                    <span>Terms & Conditions</span>
                  </button>

                  {/* 2. Privacy Policy */}
                  <button
                    type="button"
                    className="sqm-item"
                    onClick={() => {
                      setIsSidebarMenuOpen(false)
                      window.api.openExternal('https://zyro-ai.in/#/privacy')
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor">
                      <path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Zm-80-64a20,20,0,1,0,20,20A20,20,0,0,0,128,144Z" />
                    </svg>
                    <span>Privacy Policy</span>
                  </button>

                  {/* 3. Help & Support */}
                  <button
                    type="button"
                    className="sqm-item"
                    onClick={() => {
                      setIsSidebarMenuOpen(false)
                      window.api.openExternal('https://zyro-ai.in/#/help')
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor">
                      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a16,16,0,1,1-16-16A16,16,0,0,1,144,176Zm-16-96a28,28,0,0,0-28,28,8,8,0,0,0,16,0,12,12,0,1,1,24,0c0,8-4.57,12.79-11.53,17.43C120,131,120,136,120,144a8,8,0,0,0,16,0c0-4.71.69-7.23,4.7-9.87C149,129,160,121.26,160,108A28,28,0,0,0,128,80Z" />
                    </svg>
                    <span>Help & Support</span>
                  </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
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
                id: 'knowledge_base',
                label: 'Interview Content',
                icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm0,144H32V64H224V192ZM80,120a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,120Zm0,32a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,152Z" />
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
              const isPast =
                (step === 3 && (t.id === 1 || t.id === 2 || t.id === 'knowledge_base')) ||
                (step === 'knowledge_base' && (t.id === 1 || t.id === 2)) ||
                (step === 2 && t.id === 1)
              const canClick =
                t.id === 1 ||
                (t.id === 2 && name && role) ||
                (t.id === 'knowledge_base' && name && role) ||
                (t.id === 3 && selectedResumeId)

              return (
                <button
                  key={t.id}
                  className={`nav-item ${isCurrent ? 'active' : ''} ${isPast ? 'past' : ''} ${!canClick ? 'locked' : ''}`}
                  onClick={() => {
                    if (canClick) {
                      setStep(t.id as any)
                    }
                  }}
                >
                  <span className="nav-icon">{isPast ? '✓' : t.icon}</span>
                  <span className="nav-text">{t.label}</span>
                  {isCurrent && <div className="nav-active-glow" />}
                </button>
              )
            })}
          </nav>

          {/* ── Minimal Uiverse Update Button ── */}
          <MinimalUpdateButton
            updateStatus={updateStatus}
            updateInfo={updateInfo}
            updateProgress={updateProgress}
            onDownload={() => {
              setUpdateStatus('downloading')
              window.api.downloadUpdate()
            }}
            onInstall={() => window.api.installUpdate()}
            onDismiss={() => setUpdateStatus('idle')}
          />

          <footer className="sidebar-footer-enhanced">
            <div 
              className="user-brief clickable" 
              onClick={() => setShowEmail(!showEmail)}
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
              <Tooltip content="Log Out" position="top">
                <button
                  className="sidebar-logout-icon"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await window.api.supabaseLogout()
                    onLogout?.()
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M120,216a8,8,0,0,1-8,8H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h64a8,8,0,0,1,0,16H48V208h64A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z" />
                  </svg>
                </button>
              </Tooltip>
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
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#8B5CF6" viewBox="0 0 256 256">
                    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z" />
                  </svg>
                  <span>Free Trial</span>
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
                {step === 'knowledge_base' && 'Interview Content'}
                {step === 3 && 'Final Check'}
              </h1>
              <TeleprompterText
                text={
                  step === 1
                    ? 'Configure your profile, target role, and interview preferences.'
                    : step === 2
                      ? 'Upload, manage, and select your target resume for this session.'
                      : step === 'knowledge_base'
                        ? 'Upload company documents, preparation notes, and cheat sheets.'
                        : 'Verify your interview configuration before launching the assistant.'
                }
              />
            </div>
            <div className="shr-right">
              <Tooltip content="Real-time Cloud Sync Active" position="bottom-left">
                <CloudSyncButton
                  onClick={async () => {
                    try {
                      const profile = await window.api.supabaseGetProfile();
                      if (profile) {
                        window.dispatchEvent(new CustomEvent('force-profile-refresh', { detail: profile }));
                      }
                    } catch {}
                  }}
                />
              </Tooltip>
              <Tooltip content="Minimize" position="bottom-left">
                <button className="ov-action-btn minimize no-drag" onClick={() => window.api.minimizeWindow()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip content="Close App" position="bottom-left">
                <button className="ov-action-btn close no-drag" onClick={() => window.api.quitApp()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </Tooltip>
            </div>
          </header>

          <div className="content-scrollable" style={step === 3 ? { padding: '20px 28px', display: 'flex', flexDirection: 'column' } : undefined}>
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

                  <div className="field-group-modern" ref={langDropdownRef} style={{ position: 'relative' }}>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>Preferred Coding Language *</span>
                      <span style={{ fontSize: '11px', color: '#a78bfa', fontWeight: 600, background: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '6px', border: '1px solid rgba(167,139,250,0.2)' }}>
                        {CODING_LANGUAGES.find(l => l.id === codingLanguage)?.tag || 'DSA & Code Output'}
                      </span>
                    </label>
                    
                    <div
                      className={`custom-select-trigger ${isLangDropdownOpen ? 'active' : ''}`}
                      onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '8px',
                          background: 'rgba(139, 92, 246, 0.15)',
                          border: '1px solid rgba(139, 92, 246, 0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '15px'
                        }}>
                          {CODING_LANGUAGES.find(l => l.id === codingLanguage)?.icon || '💻'}
                        </div>
                        <span style={{ color: '#f8fafc', fontWeight: 600, fontSize: '14px', letterSpacing: '0.2px' }}>
                          {CODING_LANGUAGES.find(l => l.id === codingLanguage)?.name || codingLanguage}
                        </span>
                      </div>

                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        color: isLangDropdownOpen ? '#c4b5fd' : '#64748b',
                        transform: isLangDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), color 0.2s ease'
                      }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>
                    </div>

                    {isLangDropdownOpen && (
                      <div className="custom-select-menu">
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                          {CODING_LANGUAGES.map((lang) => {
                            const isSelected = codingLanguage === lang.id
                            return (
                              <div
                                key={lang.id}
                                className={`custom-select-option ${isSelected ? 'selected' : ''}`}
                                onClick={() => {
                                  setCodingLanguage(lang.id)
                                  saveData({ codingLanguage: lang.id })
                                  setIsLangDropdownOpen(false)
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span style={{ fontSize: '15px' }}>{lang.icon}</span>
                                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontSize: '13px', fontWeight: isSelected ? 700 : 500, color: isSelected ? '#fff' : '#cbd5e1' }}>
                                      {lang.name}
                                    </span>
                                    <span style={{ fontSize: '9.5px', color: isSelected ? '#c4b5fd' : '#64748b' }}>
                                      {lang.tag}
                                    </span>
                                  </div>
                                </div>
                                {isSelected && (
                                  <div style={{ color: '#a78bfa', display: 'flex', alignItems: 'center' }}>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                                    </svg>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
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
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}

            {step === 2 && (
              <div className="setup-step fade-in">
                <div className="step-body">
                  {/* ── Mode Selection Header: Segmented Glass Switcher ── */}
                  <div style={{
                    display: 'flex',
                    background: 'rgba(255, 255, 255, 0.03)',
                    padding: '4px',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    marginBottom: '16px',
                    gap: '6px'
                  }}>
                    <button
                      type="button"
                      onClick={() => setResumeInputMode('upload')}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        padding: '10px 0',
                        borderRadius: '9px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        background: resumeInputMode === 'upload' ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.35), rgba(99, 102, 241, 0.2))' : 'transparent',
                        border: resumeInputMode === 'upload' ? '1px solid rgba(167, 139, 250, 0.5)' : '1px solid transparent',
                        color: resumeInputMode === 'upload' ? '#fff' : '#94a3b8',
                        boxShadow: resumeInputMode === 'upload' ? '0 2px 10px rgba(139, 92, 246, 0.25)' : 'none'
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                      </svg>
                      <span>Upload PDF Document</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setResumeInputMode('text')}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        padding: '10px 0',
                        borderRadius: '9px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        background: resumeInputMode === 'text' ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.35), rgba(99, 102, 241, 0.2))' : 'transparent',
                        border: resumeInputMode === 'text' ? '1px solid rgba(167, 139, 250, 0.5)' : '1px solid transparent',
                        color: resumeInputMode === 'text' ? '#fff' : '#94a3b8',
                        boxShadow: resumeInputMode === 'text' ? '0 2px 10px rgba(139, 92, 246, 0.25)' : 'none'
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M227.31,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.69,147.31,64l24-24L216,84.69Z" />
                      </svg>
                      <span>Paste Plain Text</span>
                    </button>
                  </div>

                  {/* ── Mode A: Upload PDF ── */}
                  {resumeInputMode === 'upload' && (
                    <div style={{ animation: 'fadeIn 0.2s ease' }}>
                      <button className="add-resume-btn-large" onClick={handlePickResume}>
                        <div className="plus-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                            <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                          </svg>
                        </div>
                        <div className="btn-text">
                          <p className="title">Select PDF Resume</p>
                          <p className="subtitle">Click to browse your documents (.pdf format)</p>
                        </div>
                      </button>

                      {resumeFile && (
                        <div className="parsing-status-modern" style={{ marginBottom: '16px' }}>
                          <div className="ps-info">
                            <span className="ps-icon">
                              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z" />
                              </svg>
                            </span>
                            <div className="ps-info-text">
                              <p className="ps-name">{resumeFile.name}</p>
                              <p className="ps-meta">{((resumeFile.data.length * 3) / 4 / 1024).toFixed(1)} KB</p>
                            </div>
                          </div>
                          <div className="ps-actions">
                            <button className="secondary-btn btn-sm" onClick={() => setResumeFile(null)}>
                              Cancel
                            </button>
                            <button className="parse-btn-modern" onClick={handleParseResume} disabled={isParsing}>
                              {isParsing ? (
                                <span className="laser-scan-loader">
                                  <span>Parsing...</span>
                                </span>
                              ) : (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M215.79,121.79l-45.17,14.65a8,8,0,0,0-5.22,5.22l-14.65,45.17a8,8,0,0,1-15.2,0L121,141.66A8,8,0,0,0,114.34,135L69.17,120.35a8,8,0,0,1,0-15.2l45.17-14.65a8,8,0,0,0,5.22-5.22L134.21,40.11a8,8,0,0,1,15.2,0L164.06,85.28a8,8,0,0,0,5.22,5.22l45.17,14.65a8,8,0,0,1,1.34,16.64Z" />
                                  </svg>
                                  <span>Parse & Save</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Mode B: Paste Plain Text ── */}
                  {resumeInputMode === 'text' && (
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.025)',
                        border: '1px solid rgba(139, 92, 246, 0.25)',
                        borderRadius: '16px',
                        padding: '16px',
                        marginBottom: '20px',
                        animation: 'fadeIn 0.2s ease',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px'
                      }}
                    >
                      <div className="field-group-modern">
                        <label>Resume Version / Profile Title *</label>
                        <div className="input-with-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                            <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM64,128a8,8,0,0,1,8-8H96a8,8,0,0,1,0,16H72a8,8,0,0,1,0-16Zm48,0a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H120a8,8,0,0,1,0-16Z" />
                          </svg>
                          <input
                            placeholder="e.g. Senior Frontend Resume (React & TS)"
                            value={manualResumeTitle}
                            onChange={(e) => setManualResumeTitle(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="field-group-modern">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <label style={{ margin: 0 }}>Resume Details / Experience Text *</label>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>{manualResumeText.length} chars</span>
                        </div>
                        <textarea
                          placeholder="Paste your resume content, summary, skills, past experience, projects, or education here..."
                          value={manualResumeText}
                          onChange={(e) => setManualResumeText(e.target.value)}
                          rows={5}
                          style={{
                            width: '100%',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1.5px solid rgba(255, 255, 255, 0.08)',
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
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        {manualResumeText && (
                          <button
                            type="button"
                            className="secondary-btn btn-sm"
                            onClick={() => { setManualResumeText(''); setManualResumeTitle('') }}
                          >
                            Clear
                          </button>
                        )}
                        <button
                          type="button"
                          className="parse-btn-modern"
                          onClick={handleSaveManualResume}
                          disabled={isParsing || !manualResumeText.trim()}
                          style={{ padding: '8px 16px', fontSize: '13px' }}
                        >
                          {isParsing ? (
                            <span className="laser-scan-loader">
                              <span>Refining...</span>
                            </span>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M215.79,121.79l-45.17,14.65a8,8,0,0,0-5.22,5.22l-14.65,45.17a8,8,0,0,1-15.2,0L121,141.66A8,8,0,0,0,114.34,135L69.17,120.35a8,8,0,0,1,0-15.2l45.17-14.65a8,8,0,0,0,5.22-5.22L134.21,40.11a8,8,0,0,1,15.2,0L164.06,85.28a8,8,0,0,0,5.22,5.22l45.17,14.65a8,8,0,0,1,1.34,16.64Z" />
                              </svg>
                              <span>Save & Add to Library</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── Resume Library List ── */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>
                      Saved Resumes ({resumes.length})
                    </span>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Select active resume for AI prompt context</span>
                  </div>

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
                          <p className="ri-meta">ID: {r.id.substring(r.id.length - 4)} • {r.text.length} chars</p>
                        </div>
                        {selectedResumeId === r.id && (
                          <span style={{ fontSize: '11px', color: '#a78bfa', fontWeight: 600, background: 'rgba(167,139,250,0.15)', padding: '2px 8px', borderRadius: '6px', marginRight: '4px' }}>
                            ACTIVE
                          </span>
                        )}
                        <Tooltip content="Delete Resume" position="left">
                          <button className="ri-delete" onClick={(e) => handleDeleteResume(r.id, e)}>×</button>
                        </Tooltip>
                      </div>
                    ))}
                    {resumes.length === 0 && !resumeFile && (
                      <div className="empty-state-modern">
                        <p>No resumes added yet. Upload a PDF or paste text above.</p>
                      </div>
                    )}
                  </div>
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}

            {step === 'knowledge_base' && (
              <div className="setup-step fade-in">
                {showKbAddForm ? (
                  /* ── Form View: Glassmorphic Material Creation Form ── */
                  <div className="kb-form-glass">
                    <div className="kb-form-header">
                      <div className="kb-form-header-left">
                        <div className="kb-form-header-icon">
                          📚
                        </div>
                        <div>
                          <h3 className="kb-form-header-title">Add Preparation Material</h3>
                          <p className="kb-form-header-sub">Notes, cheat sheets & QA docs for live AI matching</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="uiverse-cancel-btn"
                        style={{ height: '28px', padding: '0 12px', fontSize: '11.5px' }}
                        onClick={() => setShowKbAddForm(false)}
                      >
                        Cancel
                      </button>
                    </div>

                    <div className="field-group-modern">
                      <label>Title / Topic Name *</label>
                      <div className="input-with-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon">
                          <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM64,128a8,8,0,0,1,8-8H96a8,8,0,0,1,0,16H72a8,8,0,0,1,0-16Zm48,0a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H120a8,8,0,0,1,0-16Z" />
                        </svg>
                        <input
                          type="text"
                          placeholder="e.g. Google System Design, Behavioral QA, Cheat Sheet"
                          value={newKbTitle}
                          onChange={(e) => setNewKbTitle(e.target.value)}
                          disabled={kbLoading}
                        />
                      </div>
                    </div>

                    <div className="field-group-modern">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <label style={{ margin: 0 }}>Content (Paste Plain Text or Q&A) *</label>
                        <span style={{ fontSize: '10.5px', color: newKbContent.length > 0 ? '#a78bfa' : '#64748b', fontWeight: 600 }}>
                          {newKbContent.length.toLocaleString()} characters
                        </span>
                      </div>
                      <div className="input-with-icon" style={{ alignItems: 'flex-start' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256" className="icon" style={{ top: '14px' }}>
                          <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm-16,48H64V48H192ZM64,80H192v96H64Zm128,128H64V192H192Z" />
                        </svg>
                        <textarea
                          className="kb-textarea-modern"
                          placeholder="Paste interview questions and answers, documentation, code snippets, or cheat sheets here..."
                          value={newKbContent}
                          onChange={(e) => setNewKbContent(e.target.value)}
                          disabled={kbLoading}
                          rows={6}
                        />
                      </div>
                    </div>

                    <div className="kb-form-hint">
                      <span>💡</span>
                      <span>AI uses on-device vector indexing to instantly retrieve and prioritize this content when asked relevant interview questions.</span>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                      <div>
                        {newKbContent && (
                          <button
                            type="button"
                            className="secondary-btn btn-sm"
                            style={{ height: '28px', fontSize: '11px' }}
                            onClick={() => { setNewKbTitle(''); setNewKbContent('') }}
                            disabled={kbLoading}
                          >
                            Clear All
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="uiverse-cancel-btn"
                          onClick={() => setShowKbAddForm(false)}
                          disabled={kbLoading}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="kb-submit-btn"
                          onClick={handleSaveAndProcessKb}
                          disabled={kbLoading || !newKbTitle.trim() || !newKbContent.trim()}
                        >
                          {kbLoading ? (
                            <>
                              <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}>
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                              </svg>
                              <span>Processing Vector Index...</span>
                            </>
                          ) : (
                            <>
                              <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor">
                                <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                              </svg>
                              <span>Save & Index Material</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* ── Dashboard View: Modern Glassmorphism Material Cards Grid ── */
                  <div className="material-dashboard">
                    <div className="material-dashboard-header">
                      <span className="material-dashboard-title">Real-time Content Matching</span>
                      <Tooltip content="Add New Material" position="left">
                        <button
                          type="button"
                          className="zyro-add-material-btn no-drag"
                          onClick={() => setShowKbAddForm(true)}
                        >
                          <svg
                            className="zyro-add-material-svg"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M12 22C17.5 22 22 17.5 22 12C22 6.5 17.5 2 12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22Z"
                              strokeWidth="1.8"
                            />
                            <path d="M8 12H16" strokeWidth="2" strokeLinecap="round" />
                            <path d="M12 16V8" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </Tooltip>
                    </div>

                    <div className="material-grid">
                      {/* Default Card: None / General AI Mode */}
                      <div
                        className={`material-card ${activeKbId === '' ? 'active' : ''}`}
                        onClick={() => {
                          setActiveKbId('')
                          saveData({ activeKbId: '' })
                        }}
                      >
                        <div>
                          <div className="material-card-header">
                            <h4 className="material-card-title">General AI Mode</h4>
                            <span className={`material-card-badge ${activeKbId === '' ? 'active' : 'default'}`}>
                              {activeKbId === '' ? 'Active' : 'Default'}
                            </span>
                          </div>
                          <p className="material-card-body">Standard interview assistant mode using general knowledge & candidate resume.</p>
                        </div>
                        <div className="material-card-footer">
                          <span className="material-card-meta">Full AI Capability</span>
                          {activeKbId === '' && (
                            <span style={{ fontSize: '11px', color: '#8b5cf6', fontWeight: 600 }}>Selected</span>
                          )}
                        </div>
                      </div>

                      {/* Custom Saved Knowledge Base Cards */}
                      {kbs.map((kb) => {
                        const isActive = activeKbId === kb.id
                        return (
                          <div
                            key={kb.id}
                            className={`material-card ${isActive ? 'active' : ''}`}
                            onClick={() => {
                              setActiveKbId(kb.id)
                              saveData({ activeKbId: kb.id })
                            }}
                          >
                            <div>
                              <div className="material-card-header">
                                <h4 className="material-card-title">{kb.title}</h4>
                                <span className={`material-card-badge ${isActive ? 'active' : 'default'}`}>
                                  {isActive ? 'Active' : 'Ready'}
                                </span>
                              </div>
                              <p className="material-card-body">On-device vector indexed material for real-time interview lookup.</p>
                            </div>
                            <div className="material-card-footer">
                              <span className="material-card-meta">Local Vector Storage</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {isActive && (
                                  <span style={{ fontSize: '11px', color: '#8b5cf6', fontWeight: 600 }}>Selected</span>
                                )}
                                <Tooltip content="Delete Material" position="left">
                                  <button
                                    className="material-card-delete"
                                    onClick={(e) => handleDeleteKb(kb.id, e)}
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M18 6 6 18M6 6l12 12" />
                                    </svg>
                                  </button>
                                </Tooltip>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      {/* Empty State Add Card if No Custom Material Added */}
                      {kbs.length === 0 && (
                        <div
                          className="material-card"
                          style={{ borderStyle: 'dashed', background: 'rgba(255, 255, 255, 0.01)', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '12px' }}
                          onClick={() => setShowKbAddForm(true)}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                            <div className="zyro-add-material-btn" style={{ pointerEvents: 'none' }}>
                              <svg className="zyro-add-material-svg" style={{ width: 32, height: 32 }} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                <path d="M12 22C17.5 22 22 17.5 22 12C22 6.5 17.5 2 12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22Z" strokeWidth="1.8" />
                                <path d="M8 12H16" strokeWidth="2" strokeLinecap="round" />
                                <path d="M12 16V8" strokeWidth="2" strokeLinecap="round" />
                              </svg>
                            </div>
                            <h4 style={{ fontSize: '11.5px', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>Add Material</h4>
                            <p style={{ fontSize: '10px', color: '#64748b', margin: 0, lineHeight: 1.3 }}>Cheat sheets, notes & QA docs</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {error && <div className="error-modern" style={{ marginTop: '12px' }}>{error}</div>}
              </div>
            )}

            {step === 3 && (
              <div className="setup-step fade-in final-check-container">
                {/* Upper Section: 4 Summary Stats Cards (2x2 Grid) */}
                <div className="final-check-summary-grid">
                  {/* Card 1: Profile */}
                  <div className="final-check-card">
                    <div className="fc-card-header profile">
                      <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M234.38,210a123.36,123.36,0,0,0-60.78-53.23,72,72,0,1,0-91.2,0A123.36,123.36,0,0,0,21.62,210a8,8,0,1,0,13.85,8C49.13,193.53,77.37,180,109,177.8l12.16,30.4a8,8,0,0,0,14.8,0L148.12,177.8c31.63,2.2,59.87,15.73,73.53,40.2a8,8,0,1,0,13.73-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z" />
                      </svg>
                      <span>Profile</span>
                    </div>
                    <div className="fc-card-title">{name || 'Your Profile'}</div>
                    <div className="fc-card-sub">{role ? `${role} @ ${company || 'N/A'}` : 'Profile configured'}</div>
                  </div>

                  {/* Card 2: Attached Resume */}
                  <div className="final-check-card">
                    <div className="fc-card-header resume">
                      <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34Z" />
                      </svg>
                      <span>Resume</span>
                    </div>
                    <div className="fc-card-title">
                      {resumes.find((r) => r.id === selectedResumeId)?.name || 'Default Resume'}
                    </div>
                    <div className="fc-card-sub">
                      {selectedResumeId ? '✓ Attached & Indexed' : 'No Resume Selected'}
                    </div>
                  </div>

                  {/* Card 3: Preferred Coding Language */}
                  <div className="final-check-card">
                    <div className="fc-card-header language">
                      <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M69.66,181.66l-48-48a8,8,0,0,1,0-11.32l48-48a8,8,0,0,1,11.32,11.32L39.31,128l41.67,41.66a8,8,0,0,1-11.32,11.32Zm116.68,0a8,8,0,0,0,11.32,0l48-48a8,8,0,0,0,0-11.32l-48-48a8,8,0,0,0-11.32,11.32L216.69,128l-41.67,41.66A8,8,0,0,0,186.34,181.66Zm-54.68,13.79,32-144a8,8,0,0,0-15.32-3.4l-32,144a8,8,0,0,0,15.32,3.4Z" />
                      </svg>
                      <span>Coding Syntax</span>
                    </div>
                    <div className="fc-card-title">{codingLanguage || 'Python'}</div>
                    <div className="fc-card-sub">DSA & Solution Architecture</div>
                  </div>

                  {/* Card 4: AI Mode */}
                  <div className="final-check-card">
                    <div className="fc-card-header mode">
                      <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM128,160a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z" />
                      </svg>
                      <span>AI Mode</span>
                    </div>
                    <div className="fc-card-title">
                      {autoAnswer ? '⚡ Auto-Answer Active' : '🎯 Manual Trigger'}
                    </div>
                    <div className="fc-card-sub">
                      {autoAnswer ? 'Instant automatic responses' : 'Press hotkey for answers'}
                    </div>
                  </div>
                </div>

                {/* Lower Section: Global Hotkeys Control Panel */}
                <div className="final-check-shortcuts-panel">
                  <div className="fc-shortcuts-header">
                    <span>⚡ Overlay Shortcuts & Controls</span>
                    <span style={{ fontSize: '9.5px', color: '#64748b' }}>Active During Live Interview</span>
                  </div>

                  <div className="fc-shortcuts-grid-2col">
                    <ShortcutTeleprompterCard
                      icon="👁️"
                      title="Disappear Mode"
                      keyLabel="Ctrl+B"
                      keyColor="purple"
                      desc="Instant stealth toggle — hides overlay window from screen immediately during live camera checks & screen sharing"
                    />
                    <ShortcutTeleprompterCard
                      icon="🛡️"
                      title="Stealth Protection"
                      keyLabel="Ctrl+N"
                      keyColor="blue"
                      desc="Hardware-level screen protection shield — prevents Zoom, Teams, and Google Meet from recording or capturing this window"
                    />
                    <ShortcutTeleprompterCard
                      icon="🎙️"
                      title="Speech Audio"
                      keyLabel="Ctrl+Space"
                      keyColor="emerald"
                      desc="Real-time dual audio capture — listens to interviewer questions from system audio or microphone and automatically transcribes"
                    />
                    <ShortcutTeleprompterCard
                      icon="🔍"
                      title="Screen OCR Scan"
                      keyLabel="Ctrl+S"
                      keyColor="amber"
                      desc="AI vision screen grabber — instantly analyzes coding challenges, diagrams, and technical interview questions from your screen"
                    />
                    <ShortcutTeleprompterCard
                      icon="🤖"
                      title="Auto-Answer Mode"
                      keyLabel="Ctrl+A"
                      keyColor="pink"
                      desc="Hands-free intelligent AI engine — automatically detects completed questions and generates context-aware answers without manual keypresses"
                    />
                    <ShortcutTeleprompterCard
                      icon="↕️"
                      title="Scroll & Zoom"
                      keyLabel={
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <span className="fc-sc-key slate">↑↓</span>
                          <span className="fc-sc-key slate">Ctrl±</span>
                        </div>
                      }
                      keyColor="slate"
                      desc="Quick reading navigation — use up/down arrow keys to scroll through AI answers and Ctrl +/- to adjust font scale dynamically"
                    />
                  </div>
                </div>

                {error && <div className="error-modern">{error}</div>}
              </div>
            )}
            {showPaywall && (
              <div className="paywall-overlay fade-in">
                <div className="paywall-card glass-modal">
                  <button className="paywall-close" onClick={() => setShowPaywall(false)}>×</button>

                  <div className="paywall-badge-pill">
                    <span className="paywall-dot" />
                    <span>0 Sessions Left</span>
                  </div>

                  <h3 className="paywall-title">Refill Sessions</h3>
                  <p className="paywall-sub">Get more sessions to start live AI interviews.</p>

                  <div className="paywall-features-grid">
                    <div className="paywall-feat">⚡ Real-time AI</div>
                    <div className="paywall-feat">🔒 100% Stealth</div>
                    <div className="paywall-feat">📁 Local RAG</div>
                    <div className="paywall-feat">🗣️ Hindi & English</div>
                  </div>

                  <button
                    className="paywall-action-btn"
                    onClick={() =>
                      window.api.openExternal('https://zyro-ai.in/#/dashboard/billing')
                    }
                  >
                    <span>Get Sessions</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                  </button>

                  <button className="paywall-dismiss-btn" onClick={() => setShowPaywall(false)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}

          </div>

          <footer className="content-footer-enhanced">
            <div className="footer-btn-row">
              {step !== 1 && (
                <button
                  type="button"
                  className="secondary-btn footer-nav-btn footer-back-btn"
                  onClick={() => {
                    if (step === 2) setStep(1)
                    else if (step === 'knowledge_base') setStep(2)
                    else if (step === 3) setStep('knowledge_base')
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z" />
                  </svg>
                  <span>Back</span>
                </button>
              )}

              <button
                type="button"
                className={`primary-action-btn shimmer-btn footer-nav-btn footer-next-btn ${step === 3 ? 'success' : ''}`}
                onClick={() => {
                  if (step === 1) {
                    if (!name || !role) {
                      setError('Name and Role are required.')
                      return
                    }
                    setError('')
                    setStep(2)
                  } else if (step === 2) {
                    setStep('knowledge_base')
                  } else if (step === 'knowledge_base') {
                    setStep(3)
                  } else if (step === 3) {
                    handleStartInterview()
                  }
                }}
              >
                <div className="btn-shine" />
                <span>
                  {step === 1 && 'Next'}
                  {step === 2 && 'Next'}
                  {step === 'knowledge_base' && 'Next'}
                  {step === 3 && 'Start Interview'}
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
                </svg>
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}
