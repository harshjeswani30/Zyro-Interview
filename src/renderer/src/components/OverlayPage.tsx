import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    initAI,
    generateInterviewAnswer,
    transcribeAudioOnly,
    analyzeScreen,
    SessionData
} from '../services/aiService'
import 'highlight.js/styles/github-dark.css'
import { ResizeHandles } from './ResizeHandles'
import { motion, AnimatePresence } from 'framer-motion'
import { AnimatedAnswer } from './AnimatedAnswer'

interface CurrentQA {
    question: string
    answer: string
    timestamp: Date
}

interface WordToken {
    id: number
    text: string
    timestamp: number
}

interface TranscriptPacket {
    id: string
    text: string
}

function computePacketsFromWords(words: WordToken[]): TranscriptPacket[] {
    if (!words || words.length === 0) return []

    const packets: TranscriptPacket[] = []
    let currentWords: WordToken[] = []

    for (let i = 0; i < words.length; i++) {
        const w = words[i]

        if (currentWords.length > 0) {
            const timeDiff = w.timestamp - currentWords[currentWords.length - 1].timestamp
            if (timeDiff >= 500) {
                packets.push({
                    id: `pkt-chunk-${currentWords[0].id}`,
                    text: currentWords.map(item => item.text).join(' ')
                })
                currentWords = []
            }
        }

        currentWords.push(w)
    }

    if (currentWords.length > 0) {
        packets.push({
            id: `pkt-chunk-${currentWords[0].id}`,
            text: currentWords.map(item => item.text).join(' ')
        })
    }

    return packets
}

// ── WAV encoder: Float32Array PCM chunks → WAV Blob ──────────────────────────
function encodeWAV(chunks: Float32Array[], originalSampleRate: number): Blob {
    const targetSampleRate = 16000
    const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0)
    const merged = new Float32Array(totalSamples)
    let pos = 0
    for (const c of chunks) {
        merged.set(c, pos)
        pos += c.length
    }

    // Downsample if original rate is different from target rate
    let downsampled = merged
    if (originalSampleRate !== targetSampleRate) {
        const ratio = originalSampleRate / targetSampleRate
        const newLength = Math.round(merged.length / ratio)
        downsampled = new Float32Array(newLength)
        for (let i = 0; i < newLength; i++) {
            const start = Math.round(i * ratio)
            const end = Math.round((i + 1) * ratio)
            let sum = 0
            let count = 0
            for (let j = start; j < end && j < merged.length; j++) {
                sum += merged[j]
                count++
            }
            downsampled[i] = count > 0 ? sum / count : 0
        }
    }

    const int16 = new Int16Array(downsampled.length)
    for (let i = 0; i < downsampled.length; i++) {
        const s = Math.max(-1, Math.min(1, downsampled[i]))
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    const buf = new ArrayBuffer(44 + int16.byteLength)
    const view = new DataView(buf)
    const w = (off: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
    }
    w(0, 'RIFF')
    view.setUint32(4, 36 + int16.byteLength, true)
    w(8, 'WAVE')
    w(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, targetSampleRate, true)
    view.setUint32(28, targetSampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    w(36, 'data')
    view.setUint32(40, int16.byteLength, true)
    new Int16Array(buf, 44).set(int16)
    return new Blob([buf], { type: 'audio/wav' })
}

function computeRMS(buffer: Float32Array): number {
    let sum = 0
    for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i]
    }
    return Math.sqrt(sum / buffer.length)
}

const FILLERS = new Set([
    'thank you', 'thanks', 'thanks for watching', 'thanks for',
    'bye', 'goodbye', 'good bye', 'see you', 'see you later',
    'hello', 'hi', 'hey', 'okay', 'ok', 'alright', 'right',
    'hmm', 'hm', 'uh', 'um', 'ah', 'oh', 'yeah', 'yes', 'no',
    'sure', 'sure sure', 'you', 'u', 'please subscribe', 'subscribe',
    'subtitle by', 'subtitles by', 'captions by', 'the end',
    'so', 'well', 'and', 'but', 'because', 'translated by',
    'transcript by', 'thank you very much', 'thank you for watching',
    'what is audio listening', 'audio listening', 'is audio listening',
    'what is the audio listening', 'the audio listening',
    'music', 'wind', 'laughter', 'cough', 'sigh', 'throat clearing', 'snort',
    'coughing', 'gasp', 'whispering', 'silence', 'background noise',
    'humming', 'bell', 'chime', 'ring', 'beep', 'click', 'shh', 'hiss',
    'grunt', 'groan', 'giggle', 'applause', 'cheering',
    // ── Amara.org / YouTube / subtitle watermarks ──────────────────────────
    'subtitles by the amara org community',
    'subtitles by amara org',
    'amara org community',
    'by the amara community',
    'community subtitles',
    'auto-generated by youtube',
    'auto generated subtitles',
    'closed captions provided by',
    'captions provided by',
    'subtitled by',
    'captioned by',
    'transcript provided by',
    'this video has closed captions',
    'cc by',
])

// Substring patterns for subtitle noise that may appear mid-transcript
const SUBTITLE_NOISE_PATTERNS: RegExp[] = [
    /amara\.?org/i,
    /by the amara/i,
    /community subtitle/i,
    /auto.?generated (subtitle|caption)/i,
    /closed caption/i,
    /\[music\]/i,
    /\[applause\]/i,
    /\[laughter\]/i,
    /\[inaudible\]/i,
    /\[background noise\]/i,
    /\[silence\]/i,
    /subtitles? (by|from|provided)/i,
    /captions? (by|from|provided)/i,
    /transcript (by|from|provided)/i,
    /preserve hindi/i,
    /ignore background/i,
    /do not hallucinate/i,
    /multilingual speech/i,
    /speech detection/i,
    /verbatim in their/i,
    /without translating/i,
]

function isFillerOrHallucination(text: string): boolean {
    if (!text || !text.trim()) return true

    // ── Allow Devanagari (Hindi) text through without strict filtering ──
    // Hindi words are often short and would be falsely caught by the single-word filter
    const hasDevanagari = /[\u0900-\u097F]/.test(text)
    if (hasDevanagari) {
        // Only discard if it's basically empty after cleanup
        const cleaned = text.trim().replace(/[.,!?;:'"()\[\]]/g, '').trim()
        return !cleaned || cleaned.length < 2
    }

    // ── Raw subtitle/caption watermark check (before bracket stripping) ──
    if (SUBTITLE_NOISE_PATTERNS.some(p => p.test(text))) {
        console.log('[Filter] Subtitle/caption noise discarded:', text)
        return true
    }

    const normalized = text.toLowerCase().replace(/[.,!?;:'"()\[\]]/g, '').trim()
    if (!normalized || normalized.length < 3) return true
    if (FILLERS.has(normalized)) return true

    // Common system chime / Windows notification / microphone click artifacts
    const notificationPatterns = [
        /\b(notification|alert|incoming call|ding|ping|chime|ringtone|windows notification|system sound|bell sound|call incoming)\b/i,
        /^(yeah|yes|no|ok|okay|right|cool|sure|great|awesome|fine|got it|understood|hello|hi|hey|bye|thanks|thank you|goodbye|so yeah)\b/i
    ]
    if (normalized.length < 18 && notificationPatterns.some(p => p.test(normalized))) {
        console.log('[Filter] Notification/acknowledgment noise discarded:', text)
        return true
    }

    const words = normalized.split(/\s+/).filter(Boolean)
    // Discard single word non-questions unless it's a recognised technical keyword
    if (words.length <= 1 && normalized.length < 12) {
        const allowedTechKeywords = [
            'polymorphism', 'inheritance', 'encapsulation', 'abstraction', 'closure', 'hoisting',
            'deadlock', 'mutex', 'semaphore', 'indexing', 'sharding', 'normalization', 'denormalization',
            'concurrency', 'multithreading', 'asynchronous', 'synchronous', 'eventloop', 'microservices',
            'kubernetes', 'docker', 'graphql', 'rest', 'grpc', 'websocket', 'btree', 'hashmap',
            'recursion', 'backtracking', 'memoization'
        ]
        if (!allowedTechKeywords.includes(normalized)) {
            console.log('[Filter] Discarded non-technical single word fragment:', text)
            return true
        }
    }
    
    // Check if the text is composed entirely of repeating single characters or filler words
    const uniqueWords = new Set(words)
    if (uniqueWords.size === 1 && FILLERS.has(Array.from(uniqueWords)[0])) {
        return true
    }

    return false
}


export default function OverlayPage(): React.ReactElement {
    const [session, setSession] = useState<SessionData | null>(null)
    const [currentQA, setCurrentQA] = useState<CurrentQA | null>(null)
    const [isGenerating, setIsGenerating] = useState(false)
    const [minimized, setMinimized] = useState(false)
    const [chatInput, setChatInput] = useState('')
    const [errorMsg, setErrorMsg] = useState('')
    const [statusText, setStatusText] = useState('Initializing...')
    const [overlayOpacity] = useState(0.65)
    // isResizing moved to hooks logic, but we might want a local one for UI effects


    const [isThinking, setIsThinking] = useState(false)
    const [pendingTranscript, setPendingTranscript] = useState('')
    const pendingTranscriptRef = useRef('')
    const [displayedWords, setDisplayedWords] = useState<WordToken[]>([])
    const wordIdCounterRef = useRef(0)
    const targetTranscriptRef = useRef('')
    const transcriptContainerRef = useRef<HTMLDivElement>(null)
    const displayHistoryRef = useRef('') // Store previous questions in this session
    const rawSessionHistoryRef = useRef('') // NEW: Continuous raw transcription history

    // ── Session balance + trial timer ────────────────────────
    const TRIAL_LIMIT = 600 // 10 minutes in seconds
    const [sessionBalance, setSessionBalance] = useState<number>(-1) // -1 = unknown/loading
    const [trialSecondsUsed, setTrialSecondsUsed] = useState(0)
    const [sessionDeducted, setSessionDeducted] = useState(false)
    const deductionFiredRef = useRef(false)
    const sessionStartTimeRef = useRef<number | null>(null)
    const trialIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const trialUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const trialTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const fetchIdRef = useRef<number>(0)
    const initialTrialUsedRef = useRef<number>(0)



    const handleEndInterview = useCallback(async () => {
        // 1. Hide the overlay window immediately so the user/interviewer doesn't see it
        window.api.endInterview()

        // 2. Perform background session logging and trial update
        if (sessionStartTimeRef.current) {
            const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
            const startedAt = new Date(sessionStartTimeRef.current).toISOString()
            const sessionType = session?.name || 'Interview'

            // Final trial update if not premium
            if (!deductionFiredRef.current) {
                const finalUsed = Math.min(TRIAL_LIMIT, initialTrialUsedRef.current + elapsed)
                await window.api.supabaseUpdateTrial(finalUsed).catch(console.error)
            }

            // Log session duration with metadata
            await window.api.supabaseLogSession(elapsed, startedAt, sessionType).catch(console.error)
        }

        // Clear timers immediately to prevent leak while hidden
        if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
        if (trialUpdateIntervalRef.current) clearInterval(trialUpdateIntervalRef.current)
        if (trialTimeoutRef.current) clearTimeout(trialTimeoutRef.current)
        fetchIdRef.current += 1 // Invalidate any pending timer initializations

        // 3. Exit the application completely
        window.api.quitApp()
    }, [session])

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const refreshProfileAndStartTimers = useCallback(() => {
        // Clear existing intervals if any (to prevent duplicates on resume)
        if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
        if (trialUpdateIntervalRef.current) clearInterval(trialUpdateIntervalRef.current)
        if (trialTimeoutRef.current) clearTimeout(trialTimeoutRef.current)

        const currentFetchId = ++fetchIdRef.current

        // Priority 1: Use trial info already in the session object (passes from start-interview)
        if (session?.trial_seconds_used !== undefined && session?.sessions_balance !== undefined) {
            const balance = session.sessions_balance
            const usedSeconds = session.trial_seconds_used
            setSessionBalance(balance)
            setTrialSecondsUsed(usedSeconds)
            initialTrialUsedRef.current = usedSeconds
            sessionStartTimeRef.current = Date.now()
            startTimers(balance, usedSeconds)
            return
        }

        // Priority 2: Fetch fresh from DB (fallback)
        window.api
            .supabaseGetProfile()
            .then((profile: { sessions_balance?: number; trial_seconds_used?: number } | null) => {
                if (currentFetchId !== fetchIdRef.current) return // Aborted

                const balance = profile?.sessions_balance ?? 0
                const usedSeconds = profile?.trial_seconds_used ?? 0
                setSessionBalance(balance)
                setTrialSecondsUsed(usedSeconds)
                initialTrialUsedRef.current = usedSeconds
                sessionStartTimeRef.current = Date.now()

                startTimers(balance, usedSeconds)
            })
            .catch(() => {
                setSessionBalance(0)
                sessionStartTimeRef.current = Date.now()
            })
    }, [session, handleEndInterview])

    const startTimers = (balance: number, usedSeconds: number) => {
        if (balance > 0) {
            // Paid user: deduct one session when interview starts
            if (!deductionFiredRef.current) {
                deductionFiredRef.current = true
                setSessionDeducted(true)
                window.api
                    .supabaseDeductSession()
                    .then((r: { newBalance?: number }) => {
                        setSessionBalance(r?.newBalance ?? balance - 1)
                    })
                    .catch(console.error)
            }
        } else {
            // Free trial user: check if trial is already exhausted
            if (usedSeconds >= TRIAL_LIMIT) {
                // Already exhausted — exit app immediately
                trialTimeoutRef.current = setTimeout(() => window.api.quitApp(), 2000)
            } else {
                // Start countdown from where they left off
                const secondsRemaining = TRIAL_LIMIT - usedSeconds

                // UI tick every second
                trialIntervalRef.current = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current!) / 1000)
                    const nowUsed = usedSeconds + elapsed
                    setTrialSecondsUsed(nowUsed)
                    if (nowUsed >= TRIAL_LIMIT) {
                        if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
                        handleEndInterview() // End with logging
                    }
                }, 1000)

                // Auto-end based on remaining time
                if (trialTimeoutRef.current) clearTimeout(trialTimeoutRef.current)
                trialTimeoutRef.current = setTimeout(() => {
                    if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
                    handleEndInterview() // End with logging
                }, secondsRemaining * 1000)

                // Persist trial_seconds_used to Supabase every 15 seconds
                trialUpdateIntervalRef.current = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current!) / 1000)
                    window.api
                        .supabaseUpdateTrial(Math.min(TRIAL_LIMIT, usedSeconds + elapsed))
                        .catch(console.error)
                }, 15000)
            }
        }
    }

    const isPremium = sessionBalance > 0 || sessionDeducted
    const trialSecondsRemaining = Math.max(0, TRIAL_LIMIT - trialSecondsUsed)
    const trialLabel = `${Math.floor(trialSecondsRemaining / 60)}:${(trialSecondsRemaining % 60)
        .toString()
        .padStart(2, '0')}`

    // Initial load
    useEffect(() => {
        refreshProfileAndStartTimers()
        document.documentElement.classList.add('overlay-mode')
        document.body.classList.add('overlay-mode')
        return () => {
            document.documentElement.classList.remove('overlay-mode')
            document.body.classList.remove('overlay-mode')
            if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
            if (trialUpdateIntervalRef.current) clearInterval(trialUpdateIntervalRef.current)
            if (trialTimeoutRef.current) clearTimeout(trialTimeoutRef.current)
            fetchIdRef.current += 1
        }
    }, [refreshProfileAndStartTimers])

    // Handle resume (init-session event)
    useEffect(() => {
        if (!window.api.onInitSession) return
        const unlisten = window.api.onInitSession((data: any) => {
            setSession(data as SessionData)
            refreshProfileAndStartTimers()
        })
        return () => unlisten()
    }, [refreshProfileAndStartTimers])

    // Listen to global scroll shortcuts from main process (Up, Down, Numpad keys)
    useEffect(() => {
        if (!window.api.onScrollOverlay) return
        const unlisten = window.api.onScrollOverlay((direction) => {
            const el = contentRef.current
            if (el) {
                const scrollAmount = direction === 'up' ? -150 : 150
                el.scrollBy({ top: scrollAmount, behavior: 'smooth' })
            }
        })
        return () => unlisten()
    }, [])




    // ── Instant Word Update (True Real-Time Flow) ──────────
    useEffect(() => {
        const target = pendingTranscript
        if (!target || !target.trim()) {
            if (displayedWords.length > 0) {
                setDisplayedWords([])
            }
            return
        }

        const targetWords = target.trim().split(/\s+/).filter(w => w.length > 0)
        if (targetWords.length === 0) return

        setDisplayedWords((prev) => {
            const next = [...prev]
            let changed = false

            // 1. Sync existing words (handle corrections/punctuation changes from Whisper without resetting)
            for (let i = 0; i < Math.min(next.length, targetWords.length); i++) {
                if (next[i].text !== targetWords[i]) {
                    next[i] = { ...next[i], text: targetWords[i] }
                    changed = true
                }
            }

            // 2. Instantly add ALL NEW words for zero-latency feel
            if (next.length < targetWords.length) {
                const newWords = targetWords.slice(next.length)
                const now = Date.now()
                newWords.forEach(word => {
                    next.push({
                        id: ++wordIdCounterRef.current,
                        text: word,
                        timestamp: now
                    })
                })
                changed = true
            }

            // 3. If target shrank (e.g. fresh question started), trim gently
            if (next.length > targetWords.length) {
                next.splice(targetWords.length)
                changed = true
            }

            return changed ? next : prev
        })
    }, [pendingTranscript])

    // Scroll transcript container to the rightmost edge so latest text is visible
    useEffect(() => {
        const el = transcriptContainerRef.current
        if (el) {
            el.scrollLeft = el.scrollWidth
            
            // Toggle mask visibility based on whether we're actually overflowing
            const isOverflow = el.scrollWidth > el.clientWidth
            if (isOverflow) {
                el.classList.add('is-overflowing')
            } else {
                el.classList.remove('is-overflowing')
            }
        }
    }, [displayedWords])
    
    // Auto-scroll to TOP when a new answer starts (as requested)
    useEffect(() => {
        if (currentQA && contentRef.current) {
            contentRef.current.scrollTop = 0
        }
    }, [currentQA])

    const displayedPackets = useMemo(() => computePacketsFromWords(displayedWords), [displayedWords])

    const handleClearTranscript = useCallback(() => {
        setPendingTranscript('')
        setDisplayedWords([])
        rawSessionHistoryRef.current = ''
        masterQuestionRef.current = ''
    }, [])

    const contentRef = useRef<HTMLDivElement>(null)
    const bottomChatInputRef = useRef<HTMLInputElement>(null)
    const [autoAnswer, setAutoAnswer] = useState(true)
    const [isManualListening, setIsManualListening] = useState(false)
    const [isAudioSpeaking, setIsAudioSpeaking] = useState(false)
    const [screenProtection, setScreenProtection] = useState(true)
    const lastActiveSpeechRef = useRef<number>(Date.now())
    const [, setZoomLevel] = useState(0)
    // zoomLevel is used via setZoomLevel(prev => ...) and its current value is tracked locally

    // ── VAD / audio pipeline refs ─────────────────────────────
    const audioContextRef = useRef<AudioContext | null>(null)
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
    const audioStreamRef = useRef<MediaStream | null>(null)
    const vadBufferRef = useRef<Float32Array[]>([]) // accumulated PCM
    const vadSampleRateRef = useRef(48000)
    const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isFinalizingRef = useRef(false)
    const manualListenRef = useRef(false)
    const isPartialTranscriptionInFlightRef = useRef(false)
    // Expose finalizeQuestion to handleToggleManual (set inside startCapture)
    const finalizeQuestionRef = useRef<(() => void) | null>(null)
    const isGeneratingRef = useRef(false)
    const handleAnalyzeScreenRef = useRef<(() => void) | null>(null)
    const handleToggleAutoRef = useRef<(() => void) | null>(null)
    const handleToggleManualRef = useRef<(() => void) | null>(null)
    const vadWorkerRef = useRef<Worker | null>(null)
    const vadSpeechActiveRef = useRef(false) // true when worker detects real speech

    const masterQuestionRef = useRef('') // full growing question
    const continuationCountRef = useRef(0) // how many appends so far
    const lastAnswerTimeRef = useRef<number | null>(null) // epoch-sec of last answer
    const lastSpeechEndRef = useRef<number | null>(null) // epoch-sec when speech last ended
    const GRACE_WINDOW_SEC = 12.0 // window after last SPEECH END to treat as continuation
    const MAX_CONTINUATIONS = 6 // safety cap
    useEffect(() => {
        document.documentElement.classList.add('overlay-mode')
        document.body.classList.add('overlay-mode')

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

            if (isInput) {
                if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
                    // Allow zoom hotkeys to fall through
                } else {
                    return
                }
            }

            if (e.ctrlKey) {
                if (e.key === '=' || e.key === '+') {
                    e.preventDefault()
                    setZoomLevel((prev) => {
                        const next = Math.min(prev + 0.5, 4)
                        window.api.setZoom(next)
                        return next
                    })
                } else if (e.key === '-') {
                    e.preventDefault()
                    setZoomLevel((prev) => {
                        const next = Math.max(prev - 0.5, -2)
                        window.api.setZoom(next)
                        return next
                    })
                } else if (e.key === '0') {
                    e.preventDefault()
                    setZoomLevel(0)
                    window.api.setZoom(0)
                } else if (e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    handleAnalyzeScreenRef.current?.()
                } else if (e.key.toLowerCase() === 'a') {
                    e.preventDefault()
                    handleToggleAutoRef.current?.()
                } else if (e.key === 'Backspace') {
                    e.preventDefault()
                    handleClearTranscript()
                } else if (e.code === 'Space') {
                    e.preventDefault()
                    handleToggleManualRef.current?.()
                }
            } else {
                if (e.key === 'ArrowUp') {
                    const el = contentRef.current
                    if (el) {
                        e.preventDefault()
                        el.scrollBy({ top: -140, behavior: 'smooth' })
                    }
                } else if (e.key === 'ArrowDown') {
                    const el = contentRef.current
                    if (el) {
                        e.preventDefault()
                        el.scrollBy({ top: 140, behavior: 'smooth' })
                    }
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => {
            document.documentElement.classList.remove('overlay-mode')
            document.body.classList.remove('overlay-mode')
            window.removeEventListener('keydown', handleKeyDown)
        }
    }, [])

    // ── Resizing & Interactivity Logic ──────────────────────────

    // Optimized Interactivity (Click-through)
    useEffect(() => {
        let currentIgnore = false

        const INTERACTIVE_SELECTOR =
            '.overlay-header-static, .no-drag, button, input, a, select, textarea, .resize-handle-adv'

        const handleMouseMove = (e: MouseEvent) => {
            // Use elementFromPoint on the overlay's own DOM — this is reliable even
            // when the window is in pass-through (forward:true) mode, because e.target
            // can reference the underlying window's element in that state.
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

            // Also check header bounding rect — needed when mouse enters from outside
            // (pass-through mode), as elementFromPoint may return null over transparent areas
            const headerEl = document.querySelector('.overlay-header-static') as HTMLElement | null
            const headerRect = headerEl?.getBoundingClientRect()
            const isOverHeaderRect = headerRect
                ? (e.clientX >= headerRect.left && e.clientX <= headerRect.right &&
                   e.clientY >= headerRect.top && e.clientY <= headerRect.bottom + 24)
                : false

            const isOverInteractive = isOverHeaderRect || !!el?.closest('.overlay-header-static') || !!el?.closest(INTERACTIVE_SELECTOR)

            if (isOverInteractive && currentIgnore) {
                currentIgnore = false
                window.api.setIgnoreMouseEvents(false)
            } else if (!isOverInteractive && !currentIgnore) {
                currentIgnore = true
                window.api.setIgnoreMouseEvents(true, { forward: true })
            }
        }

        window.addEventListener('mousemove', handleMouseMove, { passive: true })
        // Start in pass-through so answer panel doesn't block underlying window
        window.api.setIgnoreMouseEvents(true, { forward: true })
        currentIgnore = true

        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.api.setIgnoreMouseEvents(false)
        }
    }, [])


    // Legacy resizing logic removed (replaced by useResize and ResizeHandles)

    // Volume / Activity tracking
    const analyserRef = useRef<AnalyserNode | null>(null)
    const maxVolumeRef = useRef(0)

    // ── Audio Quality / Activity Monitor ──────────────────────
    const setupAnalyser = (stream: MediaStream) => {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        analyserRef.current = analyser

        const bufferLength = analyser.frequencyBinCount
        const dataArray = new Uint8Array(bufferLength)

        const checkVolume = () => {
            if (!analyserRef.current) return
            analyserRef.current.getByteFrequencyData(dataArray)
            let sum = 0
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i]
            }
            const avg = sum / bufferLength
            if (avg > maxVolumeRef.current) maxVolumeRef.current = avg
            // Track last activity: update timestamp if volume is above a threshold
            // Increased from 5 to 15 to ignore background hum
            if (avg > 15) {
                lastActiveSpeechRef.current = Date.now()
            }
            requestAnimationFrame(checkVolume)
        }
        checkVolume()
    }

    // ── VAD + Audio Capture (ParakeetAI-style state machine) ────
    const startCapture = useCallback(async (sessionDataOverride?: SessionData) => {
        const sData = sessionDataOverride || sessionRef.current || session
        if (!sData) return

        // ── VAD Tuning (matches ParakeetAI config) ───────────────
        const LONG_PAUSE_SEC = 2.4
        const PARTIAL_MS = 300
        const MIN_SEC = 0.5

        // Initialize VAD Worker
        const worker = new Worker(new URL('../services/vadWorker.ts', import.meta.url))
        vadWorkerRef.current = worker

        try {
            setStatusText('Finding Audio Source...')
            const sources = await window.api.getDesktopSources()
            const source = sources.find((s) => s.id.startsWith('screen:')) || sources[0]
            if (!source) throw new Error('No audio source found')

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id }
                } as any,
                video: {
                    mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id }
                } as any
            })
            const audioTrack = stream.getAudioTracks()[0]
            if (!audioTrack)
                throw new Error('System audio missing. Ensure "Share system audio" is checked.')
            stream.getVideoTracks().forEach((t) => t.stop())

            audioStreamRef.current = new MediaStream([audioTrack])
            setupAnalyser(audioStreamRef.current)

            const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
            audioContextRef.current = audioCtx
            vadSampleRateRef.current = audioCtx.sampleRate

            const sourceNode = audioCtx.createMediaStreamSource(audioStreamRef.current)
            // bufferSize=4096 @ 48kHz ≈ 85ms per chunk (close to ParakeetAI's 100ms)
            const processor = audioCtx.createScriptProcessor(4096, 1, 1) as ScriptProcessorNode
            scriptProcessorRef.current = processor
            sourceNode.connect(processor)
            processor.connect(audioCtx.destination)



            // ── Step 4: encode buffered PCM chunks → WAV → base64 → Whisper ──
            const transcribeBuffer = async (chunks: Float32Array[]): Promise<string> => {
                if (!chunks.length) return ''
                const sr = vadSampleRateRef.current
                const totalSamples = chunks.reduce((s, c) => s + c.length, 0)
                if (totalSamples < sr * MIN_SEC) return ''
                const blob = encodeWAV(chunks, sr)
                const base64 = await new Promise<string>((resolve) => {
                    const r = new FileReader()
                    r.onloadend = () => resolve((r.result as string).split(',')[1])
                    r.readAsDataURL(blob)
                })
                // Use master history + some generic interview context to guide Whisper away from hallucinations
                const promptContext = (masterQuestionRef.current || displayHistoryRef.current || 'Technical interview question.').slice(-200)
                return await transcribeAudioOnly(base64, 'audio/wav', promptContext)
            }

            // ── Step 5: finalize question → run final Whisper → call LLM ─────
            // ── Step 5: finalize question → run final Whisper → call LLM ─────
            const finalizeQuestion = async (providedChunks?: Float32Array[]) => {
                if (isFinalizingRef.current || isGeneratingRef.current) return
                
                const chunksSnap = providedChunks || [...vadBufferRef.current]
                vadBufferRef.current = []
                manualListenRef.current = false
                if (partialTimerRef.current) {
                    clearTimeout(partialTimerRef.current)
                    partialTimerRef.current = null
                }

                if (!chunksSnap.length) {
                    setIsManualListening(false)
                    setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                    return
                }

                isFinalizingRef.current = true
                setIsManualListening(false)

                try {
                    isGeneratingRef.current = true
                    setStatusText('Transcribing...')
                    const finalText = (await transcribeBuffer(chunksSnap))?.trim() ?? ''
                    console.log('[VAD] Final Transcript:', finalText)

                    // ── Background & Intent Analysis (Filler Check) ───
                    if (isFillerOrHallucination(finalText)) {
                        console.log('[VAD] Silent background discard (Noise/Filler/Hallucination)')
                        isGeneratingRef.current = false
                        isFinalizingRef.current = false
                        setIsGenerating(false)
                        setIsThinking(false)
                        setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                        return
                    }

                    // ── Visual Display Phase (Filtered & Valid Transcript) ───
                    // Immediately append to history so the user sees EXACTLY what Whisper said
                    rawSessionHistoryRef.current += (rawSessionHistoryRef.current ? ' ' : '') + finalText
                    setPendingTranscript(rawSessionHistoryRef.current)
                    const nowSec = Date.now() / 1000
                    const prevSpeechEnd = lastSpeechEndRef.current
                    const timeSinceLastSpeech = prevSpeechEnd !== null ? nowSec - prevSpeechEnd : Infinity
                    const isWithinSpeechGrace = timeSinceLastSpeech < GRACE_WINDOW_SEC
                    const hasMaster = masterQuestionRef.current.trim().length > 0

                    // Record when this speech segment ended
                    lastSpeechEndRef.current = nowSec

                    const underCap = continuationCountRef.current < MAX_CONTINUATIONS

                    if (hasMaster && isWithinSpeechGrace && underCap) {
                        // APPEND — interviewer resumed after a pause
                        masterQuestionRef.current += ' ' + finalText
                        continuationCountRef.current += 1
                        console.log(
                            `[VAD] Continuation #${continuationCountRef.current} (${timeSinceLastSpeech.toFixed(1)}s gap): '${masterQuestionRef.current}'`
                        )
                    } else {
                        // RESET — new question (gap too long or no prior question)
                        masterQuestionRef.current = finalText
                        continuationCountRef.current = 0
                        console.log(`[VAD] New question (${timeSinceLastSpeech.toFixed(1)}s since last speech): '${masterQuestionRef.current}'`)
                    }

                    const rawCombined = masterQuestionRef.current
                    
                    // ── Phase 3: Bypassed Cleaning (Temporarily) ─────────────
                    let purifiedQuestion = rawCombined
                    console.log('[AI-Extraction] Bypassed cleaning, using raw text:', purifiedQuestion)

                    if (!purifiedQuestion || isFillerOrHallucination(purifiedQuestion)) {
                        console.log('[VAD] Skipped generation for empty or filler question:', purifiedQuestion)
                        isGeneratingRef.current = false
                        isFinalizingRef.current = false
                        setIsGenerating(false)
                        setIsThinking(false)
                        setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                        return
                    }

                    // Immediately show the question in the UI
                    setCurrentQA((prev) => ({
                        question: purifiedQuestion,
                        answer: prev?.answer || '',
                        timestamp: new Date()
                    }))

                    // Proceed with AI processing for the Answer Panel...
                    setIsThinking(true)
                    setIsGenerating(true)
                    setStatusText('Thinking...')
                    console.log('[VAD] Pipeline Triggered: Processing Question...')

                    // CLEAR visual transcript immediately so next question starts from empty bar
                    rawSessionHistoryRef.current = ''
                    setPendingTranscript('')
                    setDisplayedWords([])

                    console.log('[AI-Train] Requesting answer for:', purifiedQuestion)
                    setStatusText('Writing...')
                    const answer = await generateInterviewAnswer(purifiedQuestion)
                    
                    if (!answer) {
                        console.error('[AI-Train] Generation returned nothing.')
                        setStatusText('Failed')
                        return
                    }
                    console.log('[AI-Train] Answer received length:', answer.length)

                    // ON SUCCESS: Add the finalized question to session history
                    displayHistoryRef.current += (displayHistoryRef.current ? ' ' : '') + purifiedQuestion

                    setCurrentQA({ question: purifiedQuestion, answer, timestamp: new Date() })
                    lastAnswerTimeRef.current = Date.now() / 1000

                } catch (err: any) {
                    setErrorMsg(`Error: ${err.message?.substring(0, 100)}`)
                } finally {
                    isGeneratingRef.current = false
                    isFinalizingRef.current = false
                    setIsGenerating(false)
                    setIsThinking(false)
                    setStatusText(autoAnswerRef.current ? 'Auto Mode' : 'Manual')
                }
            }

            // Expose to handleToggleManual (which lives outside this closure)
            finalizeQuestionRef.current = finalizeQuestion

            // ── Step 4a: partial transcription — shows live text while speaking ─
            // Only runs when there is buffered audio AND we are actively listening.
            const schedulePartial = () => {
                if (partialTimerRef.current || isPartialTranscriptionInFlightRef.current) return
                
                partialTimerRef.current = setTimeout(async () => {
                    partialTimerRef.current = null
                    
                    // Don't fire if the main pipeline has taken over
                    if (isFinalizingRef.current || isGeneratingRef.current) {
                        return
                    }

                    const snap = [...vadBufferRef.current]
                    if (snap.length < 3) {
                        // Not enough data, don't even try transcribing (avoids hallucinating silence)
                        // Reschedule if still listening
                        if (manualListenRef.current) schedulePartial()
                        return
                    }

                    isPartialTranscriptionInFlightRef.current = true
                    try {
                        const partial = (await transcribeBuffer(snap))?.trim() ?? ''
                        
                        // Safety: If finalization started while we were transcribing, discard
                        if (isFinalizingRef.current || isGeneratingRef.current) return

                        // Filter out fillers and hallucinations from real-time display
                        if (isFillerOrHallucination(partial)) {
                            return
                        }

                        // Valid partial — show ONLY the current active speech partial
                        setPendingTranscript(partial)

                        // Fast-path: detect question starters
                        const pLower = partial.toLowerCase()
                        const isTriggerWord = /^(what|how|why|can|could|tell|explain|describe|suppose|discuss|write|code|implement|show|if)/.test(pLower)
                        if (isTriggerWord && autoAnswerRef.current && !isThinking) {
                            setStatusText('Question Detected...')
                        }
                    } catch {
                        /* partial failure is non-fatal */
                    } finally {
                        isPartialTranscriptionInFlightRef.current = false
                    }
                    
                    // Reschedule if manual mode is still active
                    if (manualListenRef.current) {
                        schedulePartial()
                    }
                }, PARTIAL_MS)
            }

            // ── Step 2+3: VAD state machine — runs every ~85ms on raw PCM ───────
            worker.onmessage = (e) => {
                const { type, data } = e.data
                if (type === 'finalize') {
                    finalizeQuestion(data)
                } else if (type === 'status') {
                    setStatusText(data)
                } else if (type === 'speech_active') {
                    const isSpeaking = data as boolean
                    vadSpeechActiveRef.current = isSpeaking
                    if (autoAnswerRef.current) {
                        setIsAudioSpeaking(isSpeaking)
                    } else {
                        setIsAudioSpeaking(false)
                    }
                }
            }

            // Sync initial config to worker
            worker.postMessage({
                type: 'config',
                data: {
                    LONG_PAUSE_SEC,
                    MIN_SEC,
                    sampleRate: audioCtx.sampleRate,
                    isAuto: autoAnswerRef.current,
                    isManual: manualListenRef.current
                }
            })

            // ── Step 2+3: Audio Capture Loop — Streaming to Worker ──────────
            processor.onaudioprocess = (e: AudioProcessingEvent) => {
                if (isFinalizingRef.current) return

                const raw = e.inputBuffer.getChannelData(0)
                const chunk = new Float32Array(raw)
                
                // Offload VAD logic to the parallel thread
                worker.postMessage({ type: 'audio', data: chunk })
                
                // Only accumulate a local buffer for partial transcription when listening
                // In auto mode, only push when speech is likely active (the worker tells us via status)
                // In manual mode, always accumulate
                if (manualListenRef.current) {
                    vadBufferRef.current.push(chunk)
                    schedulePartial()
                } else if (autoAnswerRef.current) {
                    const rms = computeRMS(chunk)
                    const isSpeechPresent = rms >= 0.018 || vadSpeechActiveRef.current
                    if (isSpeechPresent) {
                        vadBufferRef.current.push(chunk)
                        // Bound the local buffer to last 35 seconds to avoid growing forever
                        const maxChunks = Math.ceil(vadSampleRateRef.current * 35 / 4096)
                        if (vadBufferRef.current.length > maxChunks) {
                            vadBufferRef.current = vadBufferRef.current.slice(-maxChunks)
                        }
                        schedulePartial()
                    }
                }
            }

            setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
        } catch (err: any) {
            setErrorMsg(err.message || 'Capture failed')
            setStatusText('Error')
        }
    }, [])

    const sessionRef = useRef<SessionData | null>(null)

    useEffect(() => {
        let sc = false
        window.api.getSession().then(async (data) => {
            if (sc || !data) return
            const sData = data as SessionData
            setSession(sData)
            sessionRef.current = sData
            setAutoAnswer(!!sData.autoAnswer)
            autoAnswerRef.current = !!sData.autoAnswer

            initAI(sData)
            startCapture(sData)
        })
        return () => {
            sc = true
            if (partialTimerRef.current) clearTimeout(partialTimerRef.current)
            scriptProcessorRef.current?.disconnect()
            audioContextRef.current?.close()
            audioStreamRef.current?.getTracks().forEach((t) => t.stop())
            vadWorkerRef.current?.terminate()
        }
    }, [startCapture])

    useEffect(() => {
        if (window.api?.toggleCompact) {
            window.api.toggleCompact(minimized)
        }
    }, [minimized])



    const autoAnswerRef = useRef(autoAnswer)
    useEffect(() => {
        autoAnswerRef.current = autoAnswer
    }, [autoAnswer])

    // ── Mode Control Listeners ─────────────────────────────────
    useEffect(() => {
        const c1 = window.api.onSetAutoAnswer((enabled) => {
            setAutoAnswer(enabled)
            autoAnswerRef.current = enabled
            if (!enabled) {
                setIsAudioSpeaking(false)
                if (manualListenRef.current) {
                    manualListenRef.current = false
                    setIsManualListening(false)
                }
            }
            setStatusText(enabled ? 'Ready (Auto)' : 'Manual Mode')
            vadWorkerRef.current?.postMessage({
                type: 'config',
                data: { isAuto: enabled, isManual: manualListenRef.current }
            })
        })
        const c2 = window.api.onToggleListening(() => {
            if (!autoAnswerRef.current) handleToggleManual()
        })
        const c3 = window.api.onTriggerScreenScan(() => {
            handleAnalyzeScreen()
        })
        const c4 = window.api.onScreenProtectionToggle((enabled) => {
            setScreenProtection(enabled)
        })
        return () => {
            c1()
            c2()
            c3()
            c4()
        }
    }, [])

    const handleToggleManual = () => {
        if (isFinalizingRef.current || isGeneratingRef.current) return

        if (manualListenRef.current) {
            // STOP
            setIsManualListening(false)
            manualListenRef.current = false
            setStatusText('Processing Manual Stop...')
            vadWorkerRef.current?.postMessage({ type: 'manual_stop' })
        } else {
            // START
            setIsManualListening(true)
            manualListenRef.current = true

            // Clear history for a fresh start when manually clicking 'Listen'
            rawSessionHistoryRef.current = ''
            setPendingTranscript('')
            setDisplayedWords([])
            vadBufferRef.current = []

            // Reset continuation state on manual start
            masterQuestionRef.current = ''
            lastSpeechEndRef.current = null
            continuationCountRef.current = 0

            // Sync to worker
            vadWorkerRef.current?.postMessage({
                type: 'config',
                data: { isAuto: false, isManual: true }
            })
            vadWorkerRef.current?.postMessage({ type: 'reset' })
            setStatusText('Listening...')
        }
    }

    useEffect(() => {
        handleToggleManualRef.current = handleToggleManual
    }, [handleToggleManual])

    const toggleAuto = useCallback(() => {
        const next = !autoAnswer
        setAutoAnswer(next)
        setStatusText(next ? 'Ready (Auto)' : 'Manual Mode')
        if (!next) {
            setIsAudioSpeaking(false)
            if (manualListenRef.current) {
                manualListenRef.current = false
                setIsManualListening(false)
            }
        }
        
        // When switching to Manual Mode, focus the bottom chat input box automatically
        if (!next) {
            setTimeout(() => {
                bottomChatInputRef.current?.focus()
            }, 100)
        }

        // Sync to worker
        vadWorkerRef.current?.postMessage({
            type: 'config',
            data: { isAuto: next, isManual: manualListenRef.current }
        })
    }, [autoAnswer])

    useEffect(() => {
        handleToggleAutoRef.current = toggleAuto
    }, [toggleAuto])

    const handleAnalyzeScreen = async (): Promise<void> => {
        setMinimized(false) // Auto-expand when starting scan
        setIsGenerating(true)
        setStatusText('Analyzing Screen...')
        setErrorMsg('')
        try {
            const result = await analyzeScreen()
            setCurrentQA({
                question: 'Screen Analysis Request',
                answer: result,
                timestamp: new Date()
            })
            setMinimized(false) // Ensure it's expanded once result is back

            // Reset continuation state for screen analysis
            masterQuestionRef.current = ''
            lastSpeechEndRef.current = null
            continuationCountRef.current = 0
        } catch (err: any) {
            setErrorMsg(err.message || 'Failed to analyze screen')
        } finally {
            setIsGenerating(false)
            setStatusText(autoAnswer ? 'Ready (Auto)' : 'Manual Mode')
        }
    }

    useEffect(() => {
        handleAnalyzeScreenRef.current = handleAnalyzeScreen
    }, [handleAnalyzeScreen, autoAnswer])

    // ── Filler / Hallucinated Query Detection ────────────────────────────────
    const isFillerQuery = (text: string): boolean => {
        const normalized = text.trim().toLowerCase().replace(/[!?.,'"-]/g, '')

        // Too short to be a real question (≤ 3 chars)
        if (normalized.length <= 3) return true

        // Pure greeting / acknowledgement filler words
        const fillerPatterns = [
            /^(hi|hii|hiii|hey|hello|helo|helo|heya|howdy|sup|yo|hola|namaste|greetings)(\s+there)?$/,
            /^(ok|okay|okk|okkk|k|kk|kkk|alr|alright|sure|yep|yeah|yup|nope|nah|hmm|hm|uh|um|ah|oh|mhm|mm)$/,
            /^(lol|lmao|haha|hehe|xd|xdd|😂|😅|👍|👎|✅|❌)$/,
            /^(bye|goodbye|cya|see ya|later|ttyl|good night|gn|goodnight)$/,
            /^(thanks|thank you|ty|thx|thankyou|thnx|thnks)[\s!.]*$/,
            /^(nice|good|great|cool|awesome|wow|amazing|perfect|excellent|brilliant|fantastic)[\s!.]*$/,
            /^(test|testing|check|ping|hello world|hi there|hey there)[\s!.]*$/,
            /^[\s.!?,]+$/, // only punctuation/whitespace
        ]

        return fillerPatterns.some(p => p.test(normalized))
    }

    const handleChatSubmit = async () => {
        const query = chatInput.trim()
        if (!query || isGenerating || isGeneratingRef.current) return

        // Block filler / non-question inputs silently — no feedback
        if (isFillerQuery(query)) {
            setChatInput('')
            return
        }
        
        setMinimized(false)
        setIsGenerating(true)
        isGeneratingRef.current = true
        setIsThinking(true)
        setStatusText('Analyzing Query...')
        setErrorMsg('')
        setChatInput('')
        
        try {
            const answer = await generateInterviewAnswer(query)
            if (answer) {
                displayHistoryRef.current += (displayHistoryRef.current ? ' ' : '') + query
                rawSessionHistoryRef.current += (rawSessionHistoryRef.current ? ' ' : '') + query
                setPendingTranscript(rawSessionHistoryRef.current)
                setCurrentQA({ question: query, answer, timestamp: new Date() })

                // Reset continuation state for manual chat query
                masterQuestionRef.current = ''
                lastSpeechEndRef.current = null
                continuationCountRef.current = 0
            }
            isGeneratingRef.current = false
            setIsGenerating(false)
            setIsThinking(false)
            setStatusText(autoAnswer ? 'Ready (Auto)' : 'Manual Mode')
        } catch (err: any) {
            setErrorMsg(err.message || 'Failed to generate answer')
            isGeneratingRef.current = false
            setIsGenerating(false)
            setIsThinking(false)
            setStatusText(autoAnswer ? 'Ready (Auto)' : 'Manual Mode')
        }
    }

    if (!session)
        return (
            <div className="overlay-loading">
                <div className="spinner-large" />
                <p>Loading session…</p>
            </div>
        )

    return (
        <div
            className={`overlay-root ${minimized ? 'is-minimized' : ''}`}
            style={{ '--overlay-opacity': overlayOpacity } as React.CSSProperties}
        >
            {/* Resize Handles (8 directions) */}
            <ResizeHandles />

            {/* Header / Grabbable bar */}
            <div className="overlay-header-static">
                {/* Floating Timer Badge (Top Right) */}
                {!minimized && (
                    <div
                        className={`trial-timer-badge floating-timer no-drag ${trialSecondsRemaining < 60 ? 'danger' : trialSecondsRemaining < 180 ? 'warning' : ''}`}
                    >
                        <span>{trialLabel}</span>
                    </div>
                )}
                
                <div className="header-row-top">
                    <div className="overlay-drag-handle">
                        <div className="header-left-group">
                            <div className={`status-chip ${
                                statusText.includes('Auto') ? 'chip-auto' :
                                statusText.includes('Manual') ? 'chip-manual' :
                                statusText.includes('Listen') ? 'chip-listening' :
                                statusText.includes('Thinking') || statusText.includes('Generating') || statusText.includes('Transcrib') || statusText.includes('Analyzing') || statusText.includes('Processing') ? 'chip-active' :
                                statusText.includes('Error') || statusText.includes('Failed') ? 'chip-error' :
                                'chip-idle'
                            }`}>
                                <span className="status-chip-inner">
                                    <span className="status-chip-glow"></span>
                                    <span className="chip-dot"></span>
                                    <span className="chip-label">{statusText}</span>
                                </span>
                            </div>
                            <div className="header-main-actions no-drag">
                                <button
                                    className={`header-pill-btn no-drag ${isManualListening ? 'listening pulse-red-ring' : ''}`}
                                    onClick={handleToggleManual}
                                    disabled={autoAnswer || isGenerating}
                                    title="Listen & Answer (Ctrl + Space)"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" x2="12" y1="19" y2="22" />
                                    </svg>
                                    <span className="btn-label">{isManualListening ? 'Stop' : 'Answer'}</span>
                                    <span className="btn-shortcut-badge">Ctrl Space</span>
                                </button>

                                <button
                                    className="header-pill-btn btn-screenshot no-drag"
                                    onClick={handleAnalyzeScreen}
                                    disabled={isGenerating}
                                    title="Screenshot & Analyze (Ctrl + S)"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                        <circle cx="12" cy="13" r="4" />
                                    </svg>
                                    <span className="btn-label">Screenshot</span>
                                    <span className="btn-shortcut-badge">Ctrl S</span>
                                </button>

                                <button
                                    className={`header-pill-btn btn-auto-mode no-drag ${autoAnswer ? 'auto-on' : 'auto-off'}`}
                                    onClick={toggleAuto}
                                    title="Auto Mode (Ctrl + A)"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2v4" />
                                        <path d="m4.93 10.93 2.83 2.83" />
                                        <path d="M2 18h4" />
                                        <path d="M20 18h2" />
                                        <path d="m19.07 10.93-2.83 2.83" />
                                        <path d="M22 22H2" />
                                        <path d="m16 6-4 4-4-4" />
                                    </svg>
                                    <span className="btn-label">Auto</span>
                                    <span className="btn-shortcut-badge">Ctrl A</span>
                                </button>

                                <button
                                    className={`header-pill-btn btn-stealth-mode no-drag ${screenProtection ? 'stealth-on' : 'stealth-off'}`}
                                    onClick={() => {
                                        const nextState = !screenProtection
                                        setScreenProtection(nextState)
                                        window.api.toggleScreenProtection(nextState)
                                    }}
                                    title="Stealth Mode (Ctrl + B)"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        {screenProtection ? (
                                            <>
                                                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                                                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                                                <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                                                <line x1="2" x2="22" y1="2" y2="22" />
                                            </>
                                        ) : (
                                            <>
                                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                                <circle cx="12" cy="12" r="3" />
                                            </>
                                        )}
                                    </svg>
                                    <span className="btn-label">Stealth</span>
                                    <span className="btn-shortcut-badge">Ctrl B</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="overlay-actions no-drag">
                        {/* Trial / Balance Info removed from here */}

                        <button
                            className={`ov-action-btn minimize no-drag ${minimized ? 'active' : ''}`}
                            onClick={() => setMinimized(!minimized)}
                            title={minimized ? "Expand Overlay" : "Minimize Overlay"}
                        >
                            {minimized ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 15 6 6m-6-6v6m0-6h6M9 9 3 3m6 6V3m0 6H3" /></svg>
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5" /></svg>
                            )}
                        </button>
                        <button
                            className="header-end-btn no-drag"
                            onClick={handleEndInterview}
                            title="End Interview"
                        >
                            <span>End</span>
                        </button>
                    </div>
                </div>

                <div className="header-row-bottom">
                    {/* Separate Square Audio Visualizer Box */}
                    <div className={`transcript-audio-square-box ${autoAnswer ? (isAudioSpeaking ? 'is-active' : '') : (isManualListening ? 'is-active' : '')}`}>
                        <span className="audio-bar bar-1"></span>
                        <span className="audio-bar bar-2"></span>
                        <span className="audio-bar bar-3"></span>
                    </div>

                    {/* Live Speech Packet Capsule Bar */}
                    <div className="transcript-capsule-bar">
                        <div className="header-transcript-area" ref={transcriptContainerRef}>
                            {displayedPackets.length > 0 && (
                                <AnimatePresence mode="popLayout">
                                    {displayedPackets.map((packet) => (
                                        <motion.span
                                            layout
                                            key={packet.id}
                                            initial={{ opacity: 0, scale: 0.95, x: 10 }}
                                            animate={{ opacity: 1, scale: 1, x: 0 }}
                                            exit={{ opacity: 0, scale: 0.9, x: -10 }}
                                            transition={{ duration: 0.05, ease: 'easeOut' }}
                                            className="transcript-packet-pill"
                                        >
                                            {packet.text}
                                        </motion.span>
                                    ))}
                                </AnimatePresence>
                            )}
                        </div>
                    </div>

                    {/* Vertical Divider & Clear Button on Right */}
                    <div className="transcript-divider"></div>
                    <button
                        className="transcript-clear-btn no-drag"
                        onClick={handleClearTranscript}
                        title="Clear Transcript (Ctrl + Backspace)"
                    >
                        <span className="clear-label">Clear</span>
                        <span className="clear-shortcut">Ctrl ⌫</span>
                    </button>
                </div>
            </div>

            {/* Main Content Area — always mounted so AnimatedAnswer state is preserved.
                Hidden via display:none when minimized to prevent animation restart. */}
            <div
                className="overlay-content"
                ref={contentRef}
                style={minimized ? { display: 'none' } : undefined}
            >
                        {errorMsg && <div className="error-banner">⚠️ {errorMsg}</div>}

                        <div className="qa-list flex-1 flex flex-col gap-4">
                            <AnimatePresence mode="wait">
                                {(isThinking || currentQA) ? (
                                    <motion.div
                                        className="qa-card"
                                        key="current"
                                        initial={{ opacity: 0, y: 15, scale: 0.98 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.95 }}
                                        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                                    >
                                        <div className="qa-question">
                                            <span className="qa-section-label">Question</span>
                                            <p className="qa-question-text">
                                                {currentQA?.question || (isThinking ? "Capturing question..." : "No question detected")}
                                            </p>
                                        </div>

                                        <div className="qa-answer-container mt-2">
                                            <span className="qa-section-label">Answer</span>
                                            <div className="qa-answer-wrapper">
                                                <div className="qa-answer markdown-content">
                                                    <AnimatedAnswer
                                                        answer={currentQA?.answer || ''}
                                                        isThinking={isThinking}
                                                    />
                                                </div>

                                                {!isThinking && currentQA && (
                                                    <div className="qa-footer">
                                                        <span className="qa-time">
                                                            {currentQA.timestamp.toLocaleTimeString([], {
                                                                hour: '2-digit',
                                                                minute: '2-digit'
                                                            })}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                ) : (
                                    <motion.div 
                                        className="empty-state"
                                        key="empty"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                    >
                                        <div className="radar-empty-state">
                                            <div className="radar-loader">
                                                <span></span>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Floating Chat Input Box over Answer Panel at the Bottom */}
                        <AnimatePresence>
                            {!minimized && !autoAnswer && (
                                <motion.div
                                    className="overlay-chat-footer no-drag"
                                    initial={{ opacity: 0, y: 15, scale: 0.96 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 15, scale: 0.96 }}
                                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                                >
                                    <div className="chat-input-wrapper">
                                        <div className="chat-input-prefix">
                                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
                                            </svg>
                                        </div>
                                        <input
                                            ref={bottomChatInputRef}
                                            type="text"
                                            className="chat-input-field"
                                            placeholder="Ask custom question or type..."
                                            value={chatInput}
                                            onChange={(e) => setChatInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                    e.preventDefault()
                                                    handleChatSubmit()
                                                }
                                            }}
                                            disabled={isGenerating}
                                        />
                                        <div className="chat-input-suffix">
                                            <button
                                                className="chat-send-btn"
                                                onClick={handleChatSubmit}
                                                disabled={!chatInput.trim() || isGenerating}
                                            >
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="22" y1="2" x2="11" y2="13" />
                                                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
            </div>

            <ResizeHandles />
        </div >
    )
}
