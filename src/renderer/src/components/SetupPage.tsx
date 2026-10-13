import React, { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { parseResumePDF, refineResumeWithAI, initAI, SessionData } from '../services/aiService'
import {
  coerceResponseLanguages,
  languageLabel,
  type LanguageCode
} from '../services/pipeline/languagePolicy'
import ZyroMascot from './ZyroMascot'
import Tooltip from './Tooltip'
import CloudSyncButton from './CloudSyncButton'
import MinimalUpdateButton from './MinimalUpdateButton'
import TeleprompterText from './TeleprompterText'
import openaiLogo from '../assets/logos/openai.png'
import claudeLogo from '../assets/logos/claude.png'
import geminiLogo from '../assets/logos/gemini.webp'
import zyroLogo from '../assets/logos/zyro-logo-mark.webp'
import '../assets/aiSource.css'

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
// Knowledge-base indexing and retrieval live in the main process (src/main/localVectorDb.ts)
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
  { code: 'it-IT', label: '🇮🇹 Italian' },
  { code: 'ja-JP', label: '🇯🇵 Japanese' },
  { code: 'nl-NL', label: '🇳🇱 Dutch' },
  { code: 'pt-BR', label: '🇧🇷 Portuguese' },
  { code: 'ru-RU', label: '🇷🇺 Russian' }
]

// Answer languages the copilot can be configured to REPLY in. This is separate from
// the STT `LANGUAGES` above (which only picks the transcription language). The user
// selects 1 or 2 of these; the interviewer speaking any other language falls back to
// English. Codes are LanguageCode values (see languagePolicy).
interface ResponseLanguageOption {
  id: LanguageCode
  name: string
  icon: string
  tag: string
}

// Exactly the ten languages Deepgram Nova-3 multilingual can hear on one streaming
// connection. Anything outside this set cannot be transcribed live at all -- the
// recogniser would return confident text in the nearest language it does know -- so
// offering it would be worse than leaving it out. See LanguageCode in languagePolicy.
const RESPONSE_LANGUAGES: ResponseLanguageOption[] = [
  { id: 'en', name: 'English', icon: '🇺🇸', tag: 'Default · Universal fallback' },
  { id: 'hi', name: 'Hindi', icon: '🇮🇳', tag: 'Hinglish (Roman script)' },
  { id: 'es', name: 'Spanish', icon: '🇪🇸', tag: 'Español' },
  { id: 'fr', name: 'French', icon: '🇫🇷', tag: 'Français' },
  { id: 'de', name: 'German', icon: '🇩🇪', tag: 'Deutsch' },
  { id: 'it', name: 'Italian', icon: '🇮🇹', tag: 'Italiano' },
  { id: 'ja', name: 'Japanese', icon: '🇯🇵', tag: 'Romanized' },
  { id: 'nl', name: 'Dutch', icon: '🇳🇱', tag: 'Nederlands' },
  { id: 'pt', name: 'Portuguese', icon: '🇧🇷', tag: 'Português' },
  { id: 'ru', name: 'Russian', icon: '🇷🇺', tag: 'Romanized' }
]

interface CodingLanguageOption {
  id: string
  name: string
  icon: string
  tag: string
}

const CODING_LANGUAGES: CodingLanguageOption[] = [
  { id: 'Python', name: 'Python', icon: '🐍', tag: 'AI & Data / Scripting' },
  { id: 'JavaScript', name: 'JavaScript', icon: '💛', tag: 'Web & Fullstack' },
  { id: 'TypeScript', name: 'TypeScript', icon: '💙', tag: 'Frontend & Node' },
  { id: 'Java', name: 'Java', icon: '☕', tag: 'Enterprise & Android' },
  { id: 'C++', name: 'C++', icon: '⚙️', tag: 'DSA & Systems' },
  { id: 'SQL', name: 'SQL', icon: '🗄️', tag: 'Database & Analytics' },
  { id: 'C#', name: 'C#', icon: '💠', tag: '.NET & Game Dev' },
  { id: 'Go', name: 'Go (Golang)', icon: '🐹', tag: 'Cloud & Microservices' },
  { id: 'Rust', name: 'Rust', icon: '🦀', tag: 'High-Performance' },
  { id: 'Kotlin', name: 'Kotlin', icon: '🤖', tag: 'Android & Server' },
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
  /** 1–2 answer languages the copilot replies in (English fallback otherwise). */
  responseLanguages?: string[]
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
  onLogout,
  onGoToMicTest
}: {
  userProfile?: UserProfile | null
  onLogout?: () => void
  /** Called instead of directly launching the overlay, so App can show the mic/speaker test screen */
  onGoToMicTest?: (sessionData: unknown) => void
}): React.ReactElement {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [company, setCompany] = useState('')
  const [language, setLanguage] = useState(LANGUAGES[0].code)
  const [resumeFile, setResumeFile] = useState<{ name: string; data: string } | null>(null)
  const [resumes, setResumes] = useState<Resume[]>([])
  const [selectedResumeId, setSelectedResumeId] = useState('')
  const [isParsing, setIsParsing] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3 | 'knowledge_base' | 'ai_source'>(1)
  // -- AI Source (Own Account) State --------------------------------------------
  const [aiSource, setAiSource] = useState<'gateway' | 'own_account'>(() => {
    try { return (localStorage.getItem('zyro_ai_source') as any) || 'gateway' } catch { return 'gateway' }
  })
  const [chatgptStatus, setChatgptStatus] = useState<'checking' | 'connected' | 'disconnected' | 'expired'>('checking')
  const [ownAccountSessionWarning, setOwnAccountSessionWarning] = useState<string | null>(null)
  const [claudeStatus, setClaudeStatus] = useState<'checking' | 'connected' | 'disconnected' | 'expired'>('checking')
  const [chatgptExpanded, setChatgptExpanded] = useState(false)
  const [claudeExpanded, setClaudeExpanded] = useState(false)
  const [geminiStatus, setGeminiStatus] = useState<'checking' | 'connected' | 'disconnected' | 'expired'>('checking')
  const [geminiExpanded, setGeminiExpanded] = useState(false)
  const [glmStatus, setGlmStatus] = useState<'checking' | 'connected' | 'disconnected' | 'expired'>('checking')
  const [glmExpanded, setGlmExpanded] = useState(false)
  const [providerLoading, setProviderLoading] = useState<'chatgpt' | 'claude' | 'gemini' | 'glm' | null>(null)
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
  // Answer language selection (1–2 entries; defaults to Hindi single-mode so existing
  // behavior is preserved). Mode (single vs dual) is DERIVED from the length.
  const [responseLanguages, setResponseLanguages] = useState<LanguageCode[]>(['en'])
  const [isResponseLangOpen, setIsResponseLangOpen] = useState(false)
  const responseLangDropdownRef = React.useRef<HTMLDivElement>(null)
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

  // -- Auto-Update state ---------------------------------------
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null)
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'available' | 'downloading' | 'ready'>('idle')

  const sessionsBalance = Number((userProfile?.sessions_balance ?? 0).toFixed(1))
  const trialUsed = userProfile?.trial_seconds_used ?? 0
  const TRIAL_LIMIT = 600
  const trialRemainingSeconds = Math.max(0, TRIAL_LIMIT - trialUsed)

  // -- Subscription & BYOK State ---------------------------------
  let unlimitedDaysLeft = 0
  if (userProfile?.unlimited_expires_at) {
    const expDate = new Date(userProfile.unlimited_expires_at)
    const msLeft = expDate.getTime() - Date.now()
    if (msLeft > 0) {
      unlimitedDaysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24))
    }
  }

  let hasByokAccess = false
  if (userProfile?.byok_expires_at) {
    const byokExpDate = new Date(userProfile.byok_expires_at)
    if (byokExpDate.getTime() > Date.now()) {
      hasByokAccess = true
    }
  }

  const [showByokPaywall, setShowByokPaywall] = useState(false)

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }


  useEffect(() => {
    localStorage.setItem('zyro_chatgpt_connected', String(chatgptStatus === 'connected'))
    localStorage.setItem('zyro_claude_connected', String(claudeStatus === 'connected'))
    localStorage.setItem('zyro_gemini_connected', String(geminiStatus === 'connected'))
    localStorage.setItem('zyro_glm_connected', String(glmStatus === 'connected'))
  }, [chatgptStatus, claudeStatus, geminiStatus, glmStatus])
  // Check provider connection status on mount and when ai_source tab is visited
  // On app start, validate each linked account's session for real (not just that a
  // cookie exists) so an expired/dead session shows red + a reconnect prompt BEFORE
  // the user relies on it. Runs once in the background; also pre-warms the bridges.
  useEffect(() => {
    const asStatus = (s: 'valid' | 'expired' | 'disconnected'): 'connected' | 'expired' | 'disconnected' =>
      s === 'valid' ? 'connected' : s
    const validate = async (): Promise<void> => {
      setChatgptStatus('checking'); setClaudeStatus('checking'); setGeminiStatus('checking'); setGlmStatus('checking')
      try {
        const r = await window.api.validateProviderSessions()
        setChatgptStatus(asStatus(r.chatgpt))
        setClaudeStatus(asStatus(r.claude))
        setGeminiStatus(asStatus(r.gemini))
        setGlmStatus(asStatus(r.glm))
        const names: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', glm: 'GLM' }
        const expired = Object.entries(r).filter(([, v]) => v === 'expired').map(([k]) => names[k])
        setOwnAccountSessionWarning(
          expired.length
            ? `${expired.join(', ')} ${expired.length > 1 ? 'sessions have' : 'session has'} expired. Open Setup → AI Source and reconnect.`
            : null
        )
      } catch {
        setChatgptStatus('disconnected'); setClaudeStatus('disconnected'); setGeminiStatus('disconnected'); setGlmStatus('disconnected')
      }
    }
    validate()
  }, [])
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
      if (responseLangDropdownRef.current && !responseLangDropdownRef.current.contains(event.target as Node)) {
        setIsResponseLangOpen(false)
      }
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setIsSidebarMenuOpen(false)
      }
    }
    if (isLangDropdownOpen || isResponseLangOpen || isSidebarMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isLangDropdownOpen, isResponseLangOpen, isSidebarMenuOpen])

  // -- Wire up auto-update events ------------------------------
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
        setResponseLanguages(coerceResponseLanguages(saved.responseLanguages, saved.language))
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
        responseLanguages,
        interviewContent,
        activeKbId,
        ...overrides
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    [name, role, company, language, resumes, selectedResumeId, autoAnswer, experienceLevel, experienceDuration, workHistory, codingLanguage, responseLanguages, interviewContent, activeKbId]
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
        responseLanguages,
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
  }, [resumeFile, name, role, company, language, autoAnswer, resumes, saveData, experienceLevel, experienceDuration, workHistory, codingLanguage, responseLanguages, interviewContent, activeKbId])

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
        responseLanguages,
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
  }, [manualResumeTitle, manualResumeText, name, role, company, language, autoAnswer, resumes, saveData, experienceLevel, experienceDuration, workHistory, codingLanguage, responseLanguages, interviewContent, activeKbId])

  const handleStartInterview = useCallback(async () => {
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

    if (aiSource === 'own_account') {
      try {
        const [cg, cl] = await Promise.all([
          window.api.getProviderStatus('chatgpt'),
          window.api.getProviderStatus('claude')
        ])
        const cgOk = !!cg?.connected
        const clOk = !!cl?.connected
        setChatgptStatus(cgOk ? 'connected' : 'disconnected')
        setClaudeStatus(clOk ? 'connected' : 'disconnected')
        if (!cgOk && !clOk) {
          setOwnAccountSessionWarning('Neither your ChatGPT nor Claude account session is currently connected. Please link at least one provider account in the AI Source tab, or switch to Zyro AI Gateway.')
          return
        }
      } catch (err) {
        console.warn('Failed to verify provider sessions before start:', err)
      }
    }

    if (unlimitedDaysLeft <= 0 && sessionsBalance <= 0 && trialRemainingSeconds <= 0) {
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
      responseLanguages,
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

    if (onGoToMicTest) {
      // Mic-test flow: pre-warm the gateway token quietly in the background while
      // the user is on the mic/speaker test screen. Do NOT call startInterview here
      // because that would immediately open the overlay window.
      // startInterview will be called by App.tsx once the user clicks "Proceed".
      window.api.prewarmGatewayToken?.().catch(() => {/* silent */})
      onGoToMicTest(sessionData)
    } else {
      // Original flow (scheduled sessions, etc.): call startInterview directly.
      window.api.startInterview(sessionData).then((res: { allowed: boolean } | null) => {
        if (res && !res.allowed) {
          setShowPaywall(true)
        }
      })
    }
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
    responseLanguages,
    interviewContent,
    activeKbId,
    onGoToMicTest
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
                      window.api.openExternal('https://www.zyro-ai.in/terms')
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
                      window.api.openExternal('https://www.zyro-ai.in/privacy')
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
                      // /help 301s to /contact on the site, so point straight at the target
                      window.api.openExternal('https://www.zyro-ai.in/contact')
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
                id: 'ai_source',
                label: 'AI Source',
                icon: <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M232,112a56.06,56.06,0,0,0-56-56H136V40a16,16,0,0,0-16-16H72A16,16,0,0,0,56,40V72H32A16,16,0,0,0,16,88v80a16,16,0,0,0,16,16H56v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V184h40A56.06,56.06,0,0,0,232,112Z" />
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
                (step === 3 && (t.id === 1 || t.id === 2 || t.id === 'knowledge_base' || (t.id as any) === 'ai_source')) ||
                ((step as any) === 'ai_source' && (t.id === 1 || t.id === 2 || t.id === 'knowledge_base')) ||
                (step === 'knowledge_base' && (t.id === 1 || t.id === 2)) ||
                (step === 2 && t.id === 1)
              const canClick =
                t.id === 1 ||
                (t.id === 2 && name && role) ||
                (t.id === 'knowledge_base' && name && role) ||
                ((t.id as any) === 'ai_source' && name && role) ||
                (t.id === 3 && selectedResumeId)

              return (
                <button
                  key={t.id}
                  className={`nav-item ${isCurrent ? 'active' : ''} ${isPast ? 'past' : ''} ${!canClick ? 'locked' : ''}`}
                  onClick={() => {
                    if (canClick) {
                      setStep(t.id as any)
                      setShowByokPaywall(false)
                    }
                  }}
                >
                  <span className="nav-icon">
                    {isPast ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#22c55e" viewBox="0 0 256 256">
                        <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                      </svg>
                    ) : (
                      t.icon
                    )}
                  </span>
                  <span className="nav-text">{t.label}</span>
                  {(t.id as any) === 'ai_source' && (chatgptStatus === 'connected' || claudeStatus === 'connected' || geminiStatus === 'connected') && (
                    <span style={{
                      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                      width: '7px', height: '7px', borderRadius: '50%',
                      background: '#22c55e', boxShadow: '0 0 6px #22c55e'
                    }} />
                  )}
                  {isCurrent && <div className="nav-active-glow" />}
                </button>
              )
            })}

            {/* -- Create Session — always accessible, separate from wizard flow -- */}
            {/* This closing bracket is the end of the Create Session special nav render */}
            {/* The original nav items map is split above — the extra closing below is removed */}
          </nav>

          {/* -- Minimal Uiverse Update Button -- */}
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
              {unlimitedDaysLeft > 0 ? (
                <div className="stat-pill-modern" style={{ background: 'linear-gradient(135deg, rgba(234,179,8,0.15), rgba(202,138,4,0.1))', border: '1px solid rgba(234,179,8,0.3)' }}>
                  <div className="spm-label" style={{ color: '#fef08a' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#eab308" viewBox="0 0 256 256">
                      <path d="M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17ZM109.37,214l10.47-52.38a8,8,0,0,0-5-9.06L62,132.71l84.62-90.66L136.16,94.43a8,8,0,0,0,5,9.06l52.8,19.8Z" />
                    </svg>
                    <span>Unlimited</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                    <span className="spm-value" style={{ color: '#fef08a', fontSize: '15px' }}>{unlimitedDaysLeft} Days</span>
                    <span style={{ fontSize: '9px', color: '#a1a1aa' }}>({sessionsBalance} credits paused)</span>
                  </div>
                </div>
              ) : (
                <div className="stat-pill-modern">
                  <div className="spm-label">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#8B5CF6" viewBox="0 0 256 256">
                      <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm0,144H32V64H224V192ZM64,128a8,8,0,0,1,8-8H96a8,8,0,0,1,0,16H72A8,8,0,0,1,64,128Zm48,0a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H120A8,8,0,0,1,112,128Z" />
                    </svg>
                    <span>Sessions</span>
                  </div>
                  <span className="spm-value">{sessionsBalance}</span>
                </div>
              )}
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
                {(step as any) === 'ai_source' && 'AI Source'}
              </h1>
              <TeleprompterText
                text={
                  step === 1
                    ? 'Configure your profile, target role, and interview preferences.'
                    : step === 2
                      ? 'Upload, manage, and select your target resume for this session.'
                      : step === 'knowledge_base'
                        ? 'Upload company documents, preparation notes, and cheat sheets.'
                        : (step as any) === 'ai_source'
                          ? 'Select Zyro AI Gateway or link your own account to provide GPT-5 & Sonnet 5 (based on your subscription).'
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

                  <div className="field-group-modern" ref={responseLangDropdownRef} style={{ position: 'relative' }}>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>Answer Language(s) *</span>
                      <span style={{ fontSize: '11px', color: '#a78bfa', fontWeight: 600, background: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '6px', border: '1px solid rgba(167,139,250,0.2)' }}>
                        {responseLanguages.length === 2 ? 'Dual mode' : 'Single mode'}
                      </span>
                    </label>
                    <p style={{ fontSize: '11px', color: '#64748b', margin: '2px 0 6px', lineHeight: 1.4 }}>
                      Reply in {responseLanguages.map((c) => languageLabel(c)).join(' or ')}. Any other spoken language falls back to English. (Pick up to 2.)
                    </p>

                    <div
                      className={`custom-select-trigger ${isResponseLangOpen ? 'active' : ''}`}
                      onClick={() => setIsResponseLangOpen(!isResponseLangOpen)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        {responseLanguages.map((code) => {
                          const opt = RESPONSE_LANGUAGES.find((l) => l.id === code)
                          return (
                            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '15px' }}>{opt?.icon || '🌐'}</span>
                              <span style={{ color: '#f8fafc', fontWeight: 600, fontSize: '14px', letterSpacing: '0.2px' }}>
                                {opt?.name || languageLabel(code)}
                              </span>
                            </div>
                          )
                        })}
                      </div>

                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        color: isResponseLangOpen ? '#c4b5fd' : '#64748b',
                        transform: isResponseLangOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), color 0.2s ease'
                      }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>
                    </div>
                    {isResponseLangOpen && (
                      <div className="custom-select-menu">
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                          {RESPONSE_LANGUAGES.map((lang) => {
                            const isSelected = responseLanguages.includes(lang.id)
                            const atCap = responseLanguages.length >= 2
                            const isDisabled = !isSelected && atCap
                            return (
                              <div
                                key={lang.id}
                                className={`custom-select-option ${isSelected ? 'selected' : ''}`}
                                style={isDisabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                                onClick={() => {
                                  let next: LanguageCode[]
                                  if (isSelected) {
                                    next = responseLanguages.filter((c) => c !== lang.id)
                                    if (next.length === 0) return // keep at least one
                                  } else {
                                    if (atCap) return // capped at 2
                                    next = [...responseLanguages, lang.id]
                                  }
                                  setResponseLanguages(next)
                                  saveData({ responseLanguages: next })
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
                  {/* -- Mode Selection Header: Segmented Glass Switcher -- */}
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

                  {/* -- Mode A: Upload PDF -- */}
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

                  {/* -- Mode B: Paste Plain Text -- */}
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

                  {/* -- Resume Library List -- */}
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
                  /* -- Form View: Glassmorphic Material Creation Form -- */
                  <div className="kb-form-glass">
                    <div className="kb-form-header">
                      <div className="kb-form-header-left">
                        <div className="kb-form-header-icon">
                          ??
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
                  /* -- Dashboard View: Modern Glassmorphism Material Cards Grid -- */
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
                      {selectedResumeId ? '? Attached & Indexed' : 'No Resume Selected'}
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
                      {autoAnswer ? '⚡ Auto-Answer Active' : '👆 Manual Trigger'}
                    </div>
                    <div className="fc-card-sub">
                      {autoAnswer ? 'Instant automatic responses' : 'Press hotkey for answers'}
                    </div>
                  </div>
                </div>

                {/* Lower Section: Global Hotkeys Control Panel */}
                <div className="final-check-shortcuts-panel">
                  <div className="fc-shortcuts-header">
                    <span>⌨️ Overlay Shortcuts & Controls</span>
                    <span style={{ fontSize: '9.5px', color: '#64748b' }}>Active During Live Interview</span>
                  </div>

                  <div className="fc-shortcuts-grid-2col">
                    <ShortcutTeleprompterCard
                      icon="👻"
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
                      icon="📸"
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
                      icon="🔍"
                      title="Scroll & Zoom"
                      keyLabel={
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <span className="fc-sc-key slate">⇅</span>
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

            {(step as any) === 'ai_source' && (
              <div className="setup-step fade-in">
                <div className="step-body ai-source-page">
                {/* -- 2. Mode Selection: Dual Interactive Modern Cards -- */}
                <div className="ai-modes-grid">
                  {/* Option 1: Zyro AI Gateway */}
                  <div
                    className={`ai-mode-card ${aiSource === 'gateway' ? 'selected-gateway' : ''}`}
                    onClick={() => {
                      setAiSource('gateway')
                      localStorage.setItem('zyro_ai_source', 'gateway')
                    }}
                  >
                    <div className="ai-mode-pop-badge rec">
                      <span className="ai-pop-dot" />
                      Recommended
                    </div>

                    <div className="ai-mode-top">
                      <div className="ai-mode-header-left">
                        <div className="ai-mode-icon-wrap" style={{ background: 'rgba(139,92,246,0.15)', borderColor: 'rgba(167,139,250,0.3)' }}>
                          <img src={zyroLogo} alt="Zyro Gateway" />
                        </div>
                        <div className="ai-mode-info-col">
                          <div className="ai-mode-title-row">
                            <span className="ai-mode-name">Zyro AI Gateway</span>
                          </div>
                          <p className="ai-mode-subtext">Fast cloud cluster · Instant streaming</p>
                        </div>
                      </div>
                      <div className="ai-mode-radio">
                        {aiSource === 'gateway' && (
                          <svg width="9" height="9" viewBox="0 0 256 256" fill="white">
                            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                          </svg>
                        )}
                      </div>
                    </div>

                    <div className="ai-mode-models-preview">
                      <div className="ai-stacked-avatars">
                        <div className="ai-stacked-avatar-item" style={{ background: 'linear-gradient(135deg,#06b6d4,#3b82f6)', color: '#fff', fontSize: '7px', fontWeight: 800 }} title="GLM 5.3">
                          GLM
                        </div>
                        <div className="ai-stacked-avatar-item" title="GPT 5.5">
                          <img src={openaiLogo} alt="OpenAI" />
                        </div>
                        <div className="ai-stacked-avatar-item" title="Claude Opus 4.8">
                          <img src={claudeLogo} alt="Claude" />
                        </div>
                        <div className="ai-stacked-avatar-item" title="Gemini 3.8 Flash">
                          <img src={geminiLogo} alt="Gemini" />
                        </div>
                      </div>
                      <span className="ai-models-tag-text">GLM 5.3 · GPT 5.5 · Opus 4.8 · Gemini 3.8</span>
                    </div>
                  </div>

                  {/* Option 2: Connect Personal Accounts */}
                  <div
                    className={`ai-mode-card ${aiSource === 'own_account' ? 'selected-own' : ''}`}
                    style={{ 
                      transition: 'all 0.3s ease',
                      position: 'relative'
                    }}
                    onClick={() => {
                      if (!hasByokAccess) {
                        setShowByokPaywall(true)
                        return
                      }
                      setAiSource('own_account')
                      localStorage.setItem('zyro_ai_source', 'own_account')
                    }}
                  >
                    <div className="ai-mode-pop-badge direct">
                      <span className="ai-pop-dot" />
                      Direct
                    </div>

                    {/* Locked overlay — centered lock icon + blur */}
                    {!hasByokAccess && (
                      <div style={{
                        position: 'absolute', inset: 0, zIndex: 2,
                        backdropFilter: 'blur(3px)',
                        WebkitBackdropFilter: 'blur(3px)',
                        background: 'rgba(10, 6, 20, 0.45)',
                        borderRadius: 'inherit',
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        gap: '6px',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease'
                      }}>
                        <div style={{
                          width: '36px', height: '36px',
                          borderRadius: '50%',
                          background: 'rgba(139,92,246,0.18)',
                          border: '1.5px solid rgba(139,92,246,0.45)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          boxShadow: '0 0 16px rgba(139,92,246,0.25)'
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                        </div>
                        <span style={{ fontSize: '10px', fontWeight: 700, color: '#c4b5fd', letterSpacing: '0.5px' }}>Tap to Unlock</span>
                      </div>
                    )}

                    <div className="ai-mode-top" style={{ opacity: !hasByokAccess ? 0.4 : 1 }}>
                      <div className="ai-mode-header-left">
                        <div className="ai-mode-icon-wrap" style={{ background: 'rgba(16,185,129,0.12)', borderColor: 'rgba(52,211,153,0.3)' }}>
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <img src={openaiLogo} alt="OpenAI" style={{ width: 12, height: 12, marginRight: -3 }} />
                            <img src={claudeLogo} alt="Claude" style={{ width: 12, height: 12 }} />
                          </div>
                        </div>
                        <div className="ai-mode-info-col">
                          <div className="ai-mode-title-row">
                            <span className="ai-mode-name">Use Own Accounts</span>
                          </div>
                          <p className="ai-mode-subtext">Connect ChatGPT, Claude, Gemini or GLM</p>
                        </div>
                      </div>
                      <div className="ai-mode-radio">
                        {!hasByokAccess ? null : aiSource === 'own_account' && (
                          <svg width="9" height="9" viewBox="0 0 256 256" fill="white">
                            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                          </svg>
                        )}
                      </div>
                    </div>

                    <div className="ai-mode-models-preview" style={{ opacity: !hasByokAccess ? 0.4 : 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', overflow: 'hidden' }}>
                        <span className="ai-own-status-item" style={{ color: chatgptStatus === 'connected' ? '#4ade80' : '#94a3b8' }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: chatgptStatus === 'connected' ? '#22c55e' : '#64748b' }} />
                          ChatGPT: {chatgptStatus === 'connected' ? 'Connected' : 'Not Linked'}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>·</span>
                        <span className="ai-own-status-item" style={{ color: claudeStatus === 'connected' ? '#4ade80' : '#94a3b8' }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: claudeStatus === 'connected' ? '#22c55e' : '#64748b' }} />
                          Claude: {claudeStatus === 'connected' ? 'Connected' : 'Not Linked'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* -- 3. Detail View: Gateway Active Showcase -- */}
                {aiSource === 'gateway' && (
                  <div className="ai-gateway-showcase">
                    <div className="ai-gateway-meta-bar">
                      <div className="ai-gw-meta-left">
                        <span className="ai-gw-indicator-radar" />
                        <span className="ai-gw-meta-title">Gateway Cluster Active</span>
                      </div>
                      <div className="ai-gw-latency-chip">
                        <svg width="10" height="10" fill="currentColor" viewBox="0 0 256 256">
                          <path d="M232,104H136V24a8,8,0,0,0-13.66-5.66l-96,96a8,8,0,0,0,5.66,13.66H128v80a8,8,0,0,0,13.66,5.66l96-96A8,8,0,0,0,232,104Z" />
                        </svg>
                        <span>~380ms Latency · Auto-Routing</span>
                      </div>
                    </div>

                    <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.35 }}>
                      Live interview questions & screen code are dynamically routed across 4 flagship models:
                    </div>

                    <div className="ai-gw-models-grid">
                      {/* 1. GLM 5.3 */}
                      <div className="ai-gw-model-card glm">
                        <div className="ai-gw-model-header">
                          <div className="ai-gw-model-left">
                            <div className="ai-gw-model-icon-box glm">
                              GLM
                            </div>
                            <span className="ai-gw-model-name">GLM 5.3</span>
                          </div>
                          <span className="ai-gw-model-pill cyan">Logic & Speed</span>
                        </div>
                        <p className="ai-gw-model-desc">
                          Ultra-fast reasoning engine for rapid logic evaluation & question decomposition.
                        </p>
                      </div>

                      {/* 2. GPT 5.5 */}
                      <div className="ai-gw-model-card gpt">
                        <div className="ai-gw-model-header">
                          <div className="ai-gw-model-left">
                            <div className="ai-gw-model-icon-box gpt">
                              <img src={openaiLogo} alt="OpenAI" className="ai-gw-model-img" />
                            </div>
                            <span className="ai-gw-model-name">GPT 5.5</span>
                          </div>
                          <span className="ai-gw-model-pill emerald">DSA & Design</span>
                        </div>
                        <p className="ai-gw-model-desc">
                          Deep algorithmic synthesis, data structures & system architecture generation.
                        </p>
                      </div>

                      {/* 3. Claude Opus 4.8 */}
                      <div className="ai-gw-model-card claude">
                        <div className="ai-gw-model-header">
                          <div className="ai-gw-model-left">
                            <div className="ai-gw-model-icon-box claude">
                              <img src={claudeLogo} alt="Claude" className="ai-gw-model-img" />
                            </div>
                            <span className="ai-gw-model-name">Claude Opus 4.8</span>
                          </div>
                          <span className="ai-gw-model-pill amber">Precision</span>
                        </div>
                        <p className="ai-gw-model-desc">
                          Top-tier coding accuracy, rigorous edge-case analysis & clean production code.
                        </p>
                      </div>

                      {/* 4. Gemini 3.8 Flash */}
                      <div className="ai-gw-model-card gemini">
                        <div className="ai-gw-model-header">
                          <div className="ai-gw-model-left">
                            <div className="ai-gw-model-icon-box gemini">
                              <img src={geminiLogo} alt="Gemini" className="ai-gw-model-img" />
                            </div>
                            <span className="ai-gw-model-name">Gemini 3.8 Flash</span>
                          </div>
                          <span className="ai-gw-model-pill blue">Vision & Audio</span>
                        </div>
                        <p className="ai-gw-model-desc">
                          Sub-400ms real-time vision OCR screen reading & conversational audio.
                        </p>
                      </div>
                    </div>

                    <div className="ai-gw-footer-banner">
                      <div className="ai-gw-footer-item">
                        <svg width="11" height="11" fill="#a78bfa" viewBox="0 0 256 256">
                          <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                        <span>Auto-routes between GLM 5.3, GPT 5.5, Opus 4.8 & Gemini 3.8</span>
                      </div>
                      <span style={{ fontSize: '8.5px', color: '#6ee7b7', fontWeight: 600 }}>0 Setup Required</span>
                    </div>
                  </div>
                )}

                {/* -- 4. Detail View: Own Account Provider Cards -- */}
                {aiSource === 'own_account' && (
                  <div className="ai-providers-container">
                    {/* ChatGPT Card */}
                    <div className={`ai-provider-card chatgpt ${chatgptStatus === 'connected' ? 'connected' : ''}`}>
                      <div
                        className="ai-provider-header"
                        onClick={() => setChatgptExpanded((v) => !v)}
                      >
                        <div className="ai-provider-logo-box chatgpt">
                          <img src={openaiLogo} alt="OpenAI" className="ai-provider-brand-img" />
                        </div>
                        <div className="ai-provider-details">
                          <div className="ai-provider-title-row">
                            <span className="ai-provider-name">ChatGPT</span>
                            <span className="ai-provider-model-tag">GPT-5 · GPT-4o</span>
                            <span className={`ai-status-pill-badge ${chatgptStatus}`}>
                              {chatgptStatus === 'connected' ? (
                                <>
                                  <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                                  </svg>
                                  Session Active
                                </>
                              ) : chatgptStatus === 'checking' ? (
                                <>
                                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  Validating...
                                </>
                              ) : chatgptStatus === 'expired' ? (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
                                  Session expired
                                </>
                              ) : (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#64748b' }} />
                                  Not Linked
                                </>
                              )}
                            </span>
                          </div>
                          <p className="ai-provider-sub">Provides ChatGPT responses — works with free &amp; Plus accounts.</p>
                        </div>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          fill="#94a3b8"
                          viewBox="0 0 256 256"
                          style={{
                            transform: chatgptExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.25s',
                            flexShrink: 0
                          }}
                        >
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>

                      {chatgptExpanded && (
                        <div className="ai-provider-body">
                          <div className="ai-provider-steps-box">
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">1</span>
                              <span>Click <strong>Login with ChatGPT</strong> below to open the secure native login browser window.</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">2</span>
                              <span>Sign into your OpenAI account (free or Plus account supported).</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">3</span>
                              <span>Zyro securely encrypts your session tokens locally. No passwords or credentials are ever stored remotely.</span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault()
                                window.api.openExternal('https://chatgpt.com')
                              }}
                              className="ai-external-link"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M224,104a8,8,0,0,1-16,0V79.32l-82.34,82.34a8,8,0,0,1-11.32-11.32L196.68,68H168a8,8,0,0,1,0-16h48a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z" />
                              </svg>
                              <span>Open chatgpt.com</span>
                            </a>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>Session validity: ~30 days</span>
                          </div>

                          <div className="ai-provider-actions">
                            <button
                              type="button"
                              disabled={providerLoading === 'chatgpt'}
                              onClick={async () => {
                                setProviderLoading('chatgpt')
                                setChatgptStatus('checking')
                                try {
                                  const res = await window.api.openProviderLogin('chatgpt')
                                  setChatgptStatus(res.connected ? 'connected' : 'disconnected')
                                } catch {
                                  setChatgptStatus('disconnected')
                                } finally {
                                  setProviderLoading(null)
                                }
                              }}
                              className={`ai-connect-btn chatgpt ${chatgptStatus === 'connected' ? 'reconnect' : ''}`}
                            >
                              {providerLoading === 'chatgpt' ? (
                                <>
                                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  <span>Connecting to ChatGPT...</span>
                                </>
                              ) : chatgptStatus === 'connected' ? (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M224,128a96,96,0,0,1-96,96,95.53,95.53,0,0,1-67.88-28.12,8,8,0,0,1,11.32-11.32A79.58,79.58,0,0,0,128,208a80,80,0,1,0-77.94-98.39,8,8,0,0,1-15.65-3.22A96,96,0,1,1,224,128ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Z" />
                                  </svg>
                                  <span>Reconnect / Refresh Session</span>
                                </>
                              ) : (
                                <>
                                  <img src={openaiLogo} alt="OpenAI" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                                  <span>Login with ChatGPT</span>
                                </>
                              )}
                            </button>

                            {chatgptStatus === 'connected' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.api.disconnectProvider('chatgpt')
                                  setChatgptStatus('disconnected')
                                }}
                                className="ai-disconnect-btn"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256">
                                  <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
                                </svg>
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Claude Card */}
                    <div className={`ai-provider-card claude ${claudeStatus === 'connected' ? 'connected' : ''}`}>
                      <div
                        className="ai-provider-header"
                        onClick={() => setClaudeExpanded((v) => !v)}
                      >
                        <div className="ai-provider-logo-box claude">
                          <img src={claudeLogo} alt="Claude" className="ai-provider-brand-img" />
                        </div>
                        <div className="ai-provider-details">
                          <div className="ai-provider-title-row">
                            <span className="ai-provider-name">Claude</span>
                            <span className="ai-provider-model-tag">Sonnet 5 · Sonnet 3.5</span>
                            <span className={`ai-status-pill-badge ${claudeStatus}`}>
                              {claudeStatus === 'connected' ? (
                                <>
                                  <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                                  </svg>
                                  Session Active
                                </>
                              ) : claudeStatus === 'checking' ? (
                                <>
                                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  Validating...
                                </>
                              ) : claudeStatus === 'expired' ? (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
                                  Session expired
                                </>
                              ) : (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#64748b' }} />
                                  Not Linked
                                </>
                              )}
                            </span>
                          </div>
                          <p className="ai-provider-sub">Provides Claude responses — works with free &amp; Pro accounts.</p>
                        </div>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          fill="#94a3b8"
                          viewBox="0 0 256 256"
                          style={{
                            transform: claudeExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.25s',
                            flexShrink: 0
                          }}
                        >
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>

                      {claudeExpanded && (
                        <div className="ai-provider-body">
                          <div className="ai-provider-steps-box">
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">1</span>
                              <span>Click <strong>Login with Claude</strong> to launch Anthropic authentication.</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">2</span>
                              <span>Authenticate with your Anthropic account (free or Pro account supported).</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">3</span>
                              <span>Cookies remain strictly confined to your local desktop client and auto-refresh.</span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault()
                                window.api.openExternal('https://claude.ai')
                              }}
                              className="ai-external-link"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M224,104a8,8,0,0,1-16,0V79.32l-82.34,82.34a8,8,0,0,1-11.32-11.32L196.68,68H168a8,8,0,0,1,0-16h48a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z" />
                              </svg>
                              <span>Open claude.ai</span>
                            </a>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>Session validity: ~30 days</span>
                          </div>

                          <div className="ai-provider-actions">
                            <button
                              type="button"
                              disabled={providerLoading === 'claude'}
                              onClick={async () => {
                                setProviderLoading('claude')
                                setClaudeStatus('checking')
                                try {
                                  const res = await window.api.openProviderLogin('claude')
                                  setClaudeStatus(res.connected ? 'connected' : 'disconnected')
                                } catch {
                                  setClaudeStatus('disconnected')
                                } finally {
                                  setProviderLoading(null)
                                }
                              }}
                              className={`ai-connect-btn claude ${claudeStatus === 'connected' ? 'reconnect' : ''}`}
                            >
                              {providerLoading === 'claude' ? (
                                <>
                                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  <span>Connecting to Claude...</span>
                                </>
                              ) : claudeStatus === 'connected' ? (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M224,128a96,96,0,0,1-96,96,95.53,95.53,0,0,1-67.88-28.12,8,8,0,0,1,11.32-11.32A79.58,79.58,0,0,0,128,208a80,80,0,1,0-77.94-98.39,8,8,0,0,1-15.65-3.22A96,96,0,1,1,224,128ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Z" />
                                  </svg>
                                  <span>Reconnect / Refresh Session</span>
                                </>
                              ) : (
                                <>
                                  <img src={claudeLogo} alt="Claude" style={{ width: 16, height: 16, objectFit: 'contain' }} />
                                  <span>Login with Claude</span>
                                </>
                              )}
                            </button>

                            {claudeStatus === 'connected' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.api.disconnectProvider('claude')
                                  setClaudeStatus('disconnected')
                                }}
                                className="ai-disconnect-btn"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256">
                                  <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
                                </svg>
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Gemini Card */}
                    <div className={`ai-provider-card gemini ${geminiStatus === 'connected' ? 'connected' : ''}`}>
                      <div
                        className="ai-provider-header"
                        onClick={() => setGeminiExpanded((v) => !v)}
                      >
                        <div className="ai-provider-logo-box gemini">
                          {/* Google Gemini "G" mark */}
                          <svg width="22" height="22" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M24 4C12.954 4 4 12.954 4 24s8.954 20 20 20 20-8.954 20-20S35.046 4 24 4z" fill="url(#gGradient)"/>
                            <defs>
                              <linearGradient id="gGradient" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#4285F4"/>
                                <stop offset="0.33" stopColor="#34A853"/>
                                <stop offset="0.66" stopColor="#FBBC04"/>
                                <stop offset="1" stopColor="#EA4335"/>
                              </linearGradient>
                            </defs>
                            <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="white" fontSize="20" fontWeight="700" fontFamily="Google Sans, Roboto, sans-serif">G</text>
                          </svg>
                        </div>
                        <div className="ai-provider-details">
                          <div className="ai-provider-title-row">
                            <span className="ai-provider-name">Gemini</span>
                            <span className="ai-provider-model-tag">2.0 Flash · 1.5 Pro</span>
                            <span className={`ai-status-pill-badge ${geminiStatus}`}>
                              {geminiStatus === 'connected' ? (
                                <>
                                  <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                                  </svg>
                                  Session Active
                                </>
                              ) : geminiStatus === 'checking' ? (
                                <>
                                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  Validating...
                                </>
                              ) : geminiStatus === 'expired' ? (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
                                  Session expired
                                </>
                              ) : (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#64748b' }} />
                                  Not Linked
                                </>
                              )}
                            </span>
                          </div>
                          <p className="ai-provider-sub">Provides Gemini responses — works with standard Google accounts.</p>
                        </div>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          fill="#94a3b8"
                          viewBox="0 0 256 256"
                          style={{
                            transform: geminiExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.25s',
                            flexShrink: 0
                          }}
                        >
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>

                      {geminiExpanded && (
                        <div className="ai-provider-body">
                          <div className="ai-provider-steps-box">
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">1</span>
                              <span>Click <strong>Login with Gemini</strong> to launch Google authentication.</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">2</span>
                              <span>Sign in with your Google account (works with free Google accounts).</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">3</span>
                              <span>Cookies remain strictly confined to your local desktop client and auto-refresh.</span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault()
                                window.api.openExternal('https://gemini.google.com')
                              }}
                              className="ai-external-link"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M224,104a8,8,0,0,1-16,0V79.32l-82.34,82.34a8,8,0,0,1-11.32-11.32L196.68,68H168a8,8,0,0,1,0-16h48a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z" />
                              </svg>
                              <span>Open gemini.google.com</span>
                            </a>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>Session validity: ~1–7 days (Google refreshes frequently)</span>
                          </div>

                          <div className="ai-provider-actions">
                            <button
                              type="button"
                              disabled={providerLoading === 'gemini'}
                              onClick={async () => {
                                setProviderLoading('gemini')
                                setGeminiStatus('checking')
                                try {
                                  const res = await window.api.openProviderLogin('gemini')
                                  setGeminiStatus(res.connected ? 'connected' : 'disconnected')
                                } catch {
                                  setGeminiStatus('disconnected')
                                } finally {
                                  setProviderLoading(null)
                                }
                              }}
                              className={`ai-connect-btn gemini ${geminiStatus === 'connected' ? 'reconnect' : ''}`}
                            >
                              {providerLoading === 'gemini' ? (
                                <>
                                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  <span>Connecting to Gemini...</span>
                                </>
                              ) : geminiStatus === 'connected' ? (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M224,128a96,96,0,0,1-96,96,95.53,95.53,0,0,1-67.88-28.12,8,8,0,0,1,11.32-11.32A79.58,79.58,0,0,0,128,208a80,80,0,1,0-77.94-98.39,8,8,0,0,1-15.65-3.22A96,96,0,1,1,224,128ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Z" />
                                  </svg>
                                  <span>Reconnect / Refresh Session</span>
                                </>
                              ) : (
                                <>
                                  <svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24 4C12.954 4 4 12.954 4 24s8.954 20 20 20 20-8.954 20-20S35.046 4 24 4z" fill="#4285F4"/>
                                    <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="white" fontSize="20" fontWeight="700" fontFamily="sans-serif">G</text>
                                  </svg>
                                  <span>Login with Gemini</span>
                                </>
                              )}
                            </button>

                            {geminiStatus === 'connected' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.api.disconnectProvider('gemini')
                                  setGeminiStatus('disconnected')
                                }}
                                className="ai-disconnect-btn"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256">
                                  <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
                                </svg>
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* GLM (Z.ai) Card */}
                    <div className={`ai-provider-card glm ${glmStatus === 'connected' ? 'connected' : ''}`}>
                      <div
                        className="ai-provider-header"
                        onClick={() => setGlmExpanded((v) => !v)}
                      >
                        <div className="ai-provider-logo-box glm">
                          {/* Z.ai mark */}
                          <svg width="22" height="22" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="4" y="4" width="40" height="40" rx="11" fill="url(#glmGradient)"/>
                            <defs>
                              <linearGradient id="glmGradient" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#4F7CFF"/>
                                <stop offset="1" stopColor="#9A5CFF"/>
                              </linearGradient>
                            </defs>
                            <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="white" fontSize="18" fontWeight="700" fontFamily="Inter, Roboto, sans-serif">Z</text>
                          </svg>
                        </div>
                        <div className="ai-provider-details">
                          <div className="ai-provider-title-row">
                            <span className="ai-provider-name">GLM</span>
                            <span className="ai-provider-model-tag">GLM-4.6 · 4.6V</span>
                            <span className={`ai-status-pill-badge ${glmStatus}`}>
                              {glmStatus === 'connected' ? (
                                <>
                                  <svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                                  </svg>
                                  Session Active
                                </>
                              ) : glmStatus === 'checking' ? (
                                <>
                                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  Validating...
                                </>
                              ) : glmStatus === 'expired' ? (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
                                  Session expired
                                </>
                              ) : (
                                <>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#64748b' }} />
                                  Not Linked
                                </>
                              )}
                            </span>
                          </div>
                          <p className="ai-provider-sub">Provides GLM responses — works with free &amp; paid Z.ai accounts.</p>
                        </div>
                        {/* @@GLMCARD2@@ */}
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          fill="#94a3b8"
                          viewBox="0 0 256 256"
                          style={{
                            transform: glmExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.25s',
                            flexShrink: 0
                          }}
                        >
                          <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                        </svg>
                      </div>

                      {glmExpanded && (
                        <div className="ai-provider-body">
                          <div className="ai-provider-steps-box">
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">1</span>
                              <span>Click <strong>Login with GLM</strong> to open Z.ai authentication.</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">2</span>
                              <span>Sign in with your Z.ai account (email or Google) at chat.z.ai.</span>
                            </div>
                            <div className="ai-provider-step-line">
                              <span className="ai-step-num">3</span>
                              <span>Cookies remain strictly confined to your local desktop client and auto-refresh.</span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault()
                                window.api.openExternal('https://chat.z.ai/')
                              }}
                              className="ai-external-link"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
                                <path d="M224,104a8,8,0,0,1-16,0V79.32l-82.34,82.34a8,8,0,0,1-11.32-11.32L196.68,68H168a8,8,0,0,1,0-16h48a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z" />
                              </svg>
                              <span>Open chat.z.ai</span>
                            </a>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>Session validity: ~7–30 days</span>
                          </div>
                          {/* @@GLMCARD3@@ */}
                          <div className="ai-provider-actions">
                            <button
                              type="button"
                              disabled={providerLoading === 'glm'}
                              onClick={async () => {
                                setProviderLoading('glm')
                                setGlmStatus('checking')
                                try {
                                  const res = await window.api.openProviderLogin('glm')
                                  setGlmStatus(res.connected ? 'connected' : 'disconnected')
                                } catch {
                                  setGlmStatus('disconnected')
                                } finally {
                                  setProviderLoading(null)
                                }
                              }}
                              className={`ai-connect-btn glm ${glmStatus === 'connected' ? 'reconnect' : ''}`}
                            >
                              {providerLoading === 'glm' ? (
                                <>
                                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                                  <span>Connecting to GLM...</span>
                                </>
                              ) : glmStatus === 'connected' ? (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                                    <path d="M224,128a96,96,0,0,1-96,96,95.53,95.53,0,0,1-67.88-28.12,8,8,0,0,1,11.32-11.32A79.58,79.58,0,0,0,128,208a80,80,0,1,0-77.94-98.39,8,8,0,0,1-15.65-3.22A96,96,0,1,1,224,128ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Z" />
                                  </svg>
                                  <span>Reconnect / Refresh Session</span>
                                </>
                              ) : (
                                <>
                                  <svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <rect x="4" y="4" width="40" height="40" rx="11" fill="#5B7CFA"/>
                                    <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="white" fontSize="18" fontWeight="700" fontFamily="sans-serif">Z</text>
                                  </svg>
                                  <span>Login with GLM</span>
                                </>
                              )}
                            </button>
                            {/* @@GLMCARD4@@ */}
                            {glmStatus === 'connected' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.api.disconnectProvider('glm')
                                  setGlmStatus('disconnected')
                                }}
                                className="ai-disconnect-btn"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 256 256">
                                  <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
                                </svg>
                                <span>Disconnect</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>


                    {/* Security & Token Lifespan Info */}
                    <div className="ai-security-callout">
                      <div className="ai-security-icon-wrap">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                          <path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Zm-80-64a16,16,0,0,0-16,16v16a16,16,0,0,0,32,0V160A16,16,0,0,0,128,144Z" />
                        </svg>
                      </div>
                      <div className="ai-security-content">
                        <div className="ai-security-title">Local Vault Security & Cookie Lifespan</div>
                        <p className="ai-security-text">
                          • <strong>~30-Day Auto Persistence:</strong> Web sessions remain active for roughly a month. Zyro auto-detects if a session requires re-authentication.<br />
                          • <strong>Zero Remote Storage:</strong> Session cookies are encrypted strictly in your local OS storage, never shared with Zyro servers.<br />
                          • <strong>Pre-Interview Check:</strong> Zyro verifies session readiness before starting an interview to ensure smooth, uninterrupted assistance.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                </div>
              </div>
            )}

            {ownAccountSessionWarning && (
              <div className="ai-warning-modal-backdrop">
                <div className="ai-warning-modal-card">
                  <div className="ai-warning-modal-header">
                    <div className="ai-warning-icon-box">
                      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 256 256">
                        <path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z" />
                      </svg>
                    </div>
                    <div>
                      <div className="ai-warning-title">Own Account Disconnected</div>
                      <span style={{ fontSize: '11px', color: '#94a3b8' }}>Session verification required</span>
                    </div>
                  </div>
                  <p className="ai-warning-body-text">{ownAccountSessionWarning}</p>
                  <div className="ai-warning-info-pill">
                    <svg width="14" height="14" fill="#a78bfa" viewBox="0 0 256 256">
                      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z" />
                    </svg>
                    <span>Sessions stay valid for ~30 days. Reconnect or switch to Zyro Gateway.</span>
                  </div>
                  <div className="ai-warning-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setOwnAccountSessionWarning(null)
                        setStep('ai_source' as any)
                      }}
                      className="ai-warning-btn-primary"
                    >
                      Go to AI Source Setup
                    </button>
                    <button
                      type="button"
                      onClick={() => setOwnAccountSessionWarning(null)}
                      className="ai-warning-btn-dismiss"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showByokPaywall && (
              <div className="paywall-overlay fade-in" onClick={() => setShowByokPaywall(false)}>
                <div className="paywall-card glass-modal" style={{ maxWidth: '450px' }} onClick={e => e.stopPropagation()}>
                  <button className="paywall-close" onClick={() => setShowByokPaywall(false)}>×</button>

                  <div className="paywall-badge-pill" style={{ background: 'rgba(139,92,246,0.15)', color: '#c4b5fd', border: '1px solid rgba(139,92,246,0.3)' }}>
                    <span className="paywall-dot" style={{ background: '#a78bfa', boxShadow: '0 0 8px #a78bfa' }} />
                    <span>Premium Feature</span>
                  </div>

                  <h3 className="paywall-title">Unlock Own Accounts</h3>
                  <p className="paywall-sub" style={{ fontSize: '13px', lineHeight: '1.5' }}>
                    Connect your own ChatGPT, Claude, Gemini, or GLM to bypass Zyro limits completely.
                  </p>

                  <div className="paywall-features-grid" style={{ marginBottom: '20px' }}>
                    <div className="paywall-feat">🚀 Zero rate limits from Zyro</div>
                    <div className="paywall-feat">🧠 Works with Free &amp; Paid accounts</div>
                    <div className="paywall-feat">⚡ Works with or without credits</div>
                    <div className="paywall-feat">🔒 100% Direct &amp; Private connection</div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                    <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'all 0.2s ease' }}>
                      <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>1 Month Pass</div>
                      <div style={{ fontSize: '20px', color: '#fff', fontWeight: 700, fontFamily: 'monospace' }}>₹100</div>
                      <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>No commitment</div>
                    </div>

                    <div style={{ padding: '12px', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(99,102,241,0.1))', border: '1.5px solid rgba(139,92,246,0.5)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'all 0.2s ease', position: 'relative' }}>
                      <div style={{ position: 'absolute', top: '-8px', background: 'linear-gradient(90deg, #8b5cf6, #3b82f6)', padding: '2px 8px', borderRadius: '8px', fontSize: '9px', fontWeight: 800, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Recommended</div>
                      <div style={{ fontSize: '12px', color: '#c4b5fd', marginBottom: '4px', fontWeight: 600 }}>Monthly Auto-Renew</div>
                      <div style={{ fontSize: '20px', color: '#fff', fontWeight: 700, fontFamily: 'monospace' }}>₹100<span style={{ fontSize: '12px', color: '#94a3b8' }}>/mo</span></div>
                      <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>Cancel anytime</div>
                    </div>
                  </div>

                  <button
                    className="paywall-action-btn"
                    style={{ background: 'linear-gradient(90deg, #8b5cf6, #3b82f6)' }}
                    onClick={() => {
                      window.api.openExternal('https://www.zyro-ai.in/dashboard/billing?plan=byok')
                    }}
                  >
                    <span>Proceed to Pay</span>
                    <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"/></svg>
                  </button>
                  <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '11px', color: '#64748b' }}>
                    Already paid? <span style={{ color: '#8b5cf6', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setShowByokPaywall(false)}>Refresh Status</span>
                  </div>
                </div>
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
                    <div className="paywall-feat">👻 100% Stealth</div>
                    <div className="paywall-feat">📚 Local RAG</div>
                    <div className="paywall-feat">🌐 Hindi & English</div>
                  </div>

                  <button
                    className="paywall-action-btn"
                    onClick={() =>
                      window.api.openExternal('https://www.zyro-ai.in/dashboard/billing')
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
                    else if ((step as any) === 'ai_source') setStep('knowledge_base')
                    else if (step === 3) setStep('ai_source' as any)
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
                    setStep('ai_source' as any)
                  } else if ((step as any) === 'ai_source') {
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
                  {(step as any) === 'ai_source' && 'Next'}
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
