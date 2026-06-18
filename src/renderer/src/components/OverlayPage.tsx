import React, { useState, useEffect, useCallback, useRef } from 'react'
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
    'grunt', 'groan', 'giggle', 'applause', 'cheering'
])

function isFillerOrHallucination(text: string): boolean {
    const normalized = text.toLowerCase().replace(/[.,!?;:'"()\[\]]/g, '').trim()
    if (!normalized || normalized.length < 3) return true
    if (FILLERS.has(normalized)) return true

    const words = normalized.split(/\s+/)
    
    // Check if the text is composed entirely of repeating single characters or filler words
    const uniqueWords = new Set(words)
    if (uniqueWords.size === 1 && FILLERS.has(Array.from(uniqueWords)[0])) {
        return true
    }

    // Heuristics for short transcripts (less than 5 words)
    if (words.length < 5) {
        // Strip common leading filler words
        const leadingFillers = new Set(['so', 'and', 'but', 'okay', 'ok', 'now', 'well', 'actually', 'basically', 'like'])
        let startIndex = 0
        while (startIndex < words.length && leadingFillers.has(words[startIndex])) {
            startIndex++
        }
        
        // If we stripped all words, it's a filler
        if (startIndex >= words.length) return true
        
        const firstRealWord = words[startIndex]
        
        // Check if the first real word is a valid question/action word
        const VALID_STARTERS = new Set([
            'what', 'how', 'why', 'can', 'could', 'tell', 'explain', 'describe',
            'write', 'code', 'implement', 'give', 'show', 'where', 'when', 'which',
            'who', 'whose', 'whom', 'define', 'introduce', 'design', 'discuss',
            'create', 'act', 'suppose', 'elaborate', 'analyze', 'solve', 'state',
            'compare', 'difference', 'diff'
        ])
        
        if (!VALID_STARTERS.has(firstRealWord)) {
            console.log(`[Filter] Filtered short non-question: "${normalized}" (first word: "${firstRealWord}")`)
            return true
        }
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

    const [isCopied, setIsCopied] = useState(false)
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




    // Keep ref in sync
    useEffect(() => {
        pendingTranscriptRef.current = pendingTranscript
        // Sync target for crawl loop
        targetTranscriptRef.current = pendingTranscript
    }, [pendingTranscript])

    // ── Typewriter / word-crawl loop ──────────────────────────
    // Persistent word-by-word crawl loop (Stable Token version)
    useEffect(() => {
        const interval = setInterval(() => {
            const target = targetTranscriptRef.current
            if (!target) {
                if (displayedWords.length > 0) {
                    setDisplayedWords([])
                }
                return
            }

            const targetWords = target.trim().split(/\s+/).filter(w => w.length > 0)
            
            setDisplayedWords((prev) => {
                // If the first word has completely changed (not just casing), reset the crawl
                if (prev.length > 0 && targetWords.length > 0) {
                    const firstPrev = prev[0].text.toLowerCase().replace(/[.,!?;:'"]/g, '')
                    const firstTarget = targetWords[0].toLowerCase().replace(/[.,!?;:'"]/g, '')
                    if (firstPrev !== firstTarget) {
                        return []
                    }
                }

                const next = [...prev]
                let changed = false

                // 1. Sync existing words (handle corrections/autocorrect from Whisper)
                for (let i = 0; i < Math.min(next.length, targetWords.length); i++) {
                    if (next[i].text !== targetWords[i]) {
                        next[i] = { ...next[i], text: targetWords[i] }
                        changed = true
                    }
                }

                // 2. Add NEXT word (crawl forward one word at a time)
                if (next.length < targetWords.length) {
                    next.push({
                        id: ++wordIdCounterRef.current,
                        text: targetWords[next.length]
                    })
                    changed = true
                }

                // 3. Trim trailing words if target shrank significantly
                if (next.length > targetWords.length + 1) {
                    next.splice(targetWords.length)
                    changed = true
                }

                return changed ? next : prev
            })
        }, 40) // Faster cadence for smoother real-time feel

        return () => clearInterval(interval)
    }, [])

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

    const contentRef = useRef<HTMLDivElement>(null)
    const [autoAnswer, setAutoAnswer] = useState(false)
    const [isManualListening, setIsManualListening] = useState(false)
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

            const isOverInteractive = (e.clientY < 120) || !!el?.closest(INTERACTIVE_SELECTOR)

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
        const LONG_PAUSE_SEC = 1.8
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
                    setStatusText('Generating Answer...')
                    const answer = await generateInterviewAnswer(purifiedQuestion)
                    
                    if (!answer) {
                        console.error('[AI-Train] Generation returned nothing.')
                        setStatusText('Generation Failed.')
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
                    setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
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
                    vadSpeechActiveRef.current = data as boolean
                    // NOTE: do NOT clear the transcript on speech_active=false.
                    // The transcript should persist and stay visible across natural
                    // speech breaks. Only finalizeQuestion() clears it after generating
                    // an answer, or handleToggleManual clears it on a fresh start.
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
                        // Bound the local buffer to last 10 seconds to avoid growing forever
                        const maxChunks = Math.ceil(vadSampleRateRef.current * 10 / 4096)
                        if (vadBufferRef.current.length > maxChunks) {
                            vadBufferRef.current = vadBufferRef.current.slice(-maxChunks)
                        }
                        // Only show partial text when real speech is happening
                        if (vadSpeechActiveRef.current) {
                            schedulePartial()
                        }
                    } else {
                        // Clear the local buffer during silence to prevent Whisper from transcribing noise
                        if (vadBufferRef.current.length > 0) {
                            vadBufferRef.current = []
                        }
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
            if (!enabled && manualListenRef.current) {
                manualListenRef.current = false
                setIsManualListening(false)
            }
            setStatusText(enabled ? 'Ready (Auto)' : 'Manual Mode')
        })
        const c2 = window.api.onToggleListening(() => {
            if (!autoAnswerRef.current) handleToggleManual()
        })
        const c3 = window.api.onTriggerScreenScan(() => {
            handleAnalyzeScreen()
        })
        return () => {
            c1()
            c2()
            c3()
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
        if (!next && manualListenRef.current) {
            manualListenRef.current = false
            setIsManualListening(false)
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

    const handleChatSubmit = async () => {
        const query = chatInput.trim()
        if (!query || isGenerating || isGeneratingRef.current) return
        
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
                <div className="header-row-top">
                    <div className="overlay-drag-handle">
                        <div className="header-left-group">
                            <div className="status-indicator">
                                <span className="pulse-dot"></span>
                                <span className="status-text">{statusText}</span>
                            </div>
                            <div className="header-main-actions no-drag">
                                <button
                                    className={`header-action-btn no-drag ${isManualListening ? 'listening' : ''}`}
                                    onClick={handleToggleManual}
                                    disabled={autoAnswer || isGenerating}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /></svg>
                                    <span>{isManualListening ? 'Stop' : 'Listen'}</span>
                                </button>
                                <button
                                    className="header-action-btn no-drag"
                                    onClick={handleAnalyzeScreen}
                                    disabled={isGenerating}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 12h10" /><path d="M12 7v10" /></svg>
                                    <span>Analyze screen</span>
                                </button>

                                <div 
                                    className={`header-auto-toggle no-drag ${autoAnswer ? 'active' : ''}`}
                                    onClick={toggleAuto}
                                >
                                    <div className="toggle-label">Auto</div>
                                    <div className="mini-switch">
                                        <div className="mini-knob" />
                                    </div>
                                </div>

                                {!autoAnswer && (
                                    <input
                                        type="text"
                                        className="header-chat-input no-drag"
                                        placeholder="Ask AI..."
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleChatSubmit()
                                        }}
                                        disabled={isGenerating}
                                    />
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="overlay-actions no-drag">
                        {/* Trial / Balance Info */}
                        <div
                            className={`trial-timer-badge no-drag ${!isPremium && trialSecondsRemaining < 60 ? 'danger' : !isPremium && trialSecondsRemaining < 180 ? 'warning' : ''
                                }`}
                        >
                            {isPremium ? (
                                <div className="flex items-center gap-1.5">
                                    <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6] animate-pulse" />
                                    <span>{sessionBalance} Sessions</span>
                                </div>
                            ) : (
                                <span>{trialLabel}</span>
                            )}
                        </div>

                        <button
                            className={`ov-action-btn minimize no-drag ${minimized ? 'active' : ''}`}
                            onClick={() => setMinimized(!minimized)}
                        >
                            {minimized ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 15 6 6m-6-6v6m0-6h6M9 9 3 3m6 6V3m0 6H3" /></svg>
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5" /></svg>
                            )}
                        </button>
                        <button className="ov-action-btn close no-drag" onClick={handleEndInterview}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                    </div>
                </div>

                <div className="header-row-bottom">
                    {/* Live transcript area — always shows accumulated text, no placeholder label */}
                    <div className="header-transcript-area" ref={transcriptContainerRef}>
                        {displayedWords.length > 0 ? (
                            <>
                                <AnimatePresence mode="popLayout">
                                    {displayedWords.slice(-30).map((wordObj, idx, arr) => {
                                        const age = arr.length - 1 - idx // 0 = newest
                                        const wordClass = age === 0 ? 'latest' : age <= 4 ? 'recent' : age <= 12 ? 'previous' : 'old'
                                        
                                        return (
                                            <motion.span
                                                key={`word-${wordObj.id}`}
                                                initial={{ opacity: 0, x: 15 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                exit={{ opacity: 0, x: -15 }}
                                                transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
                                                className={`transcript-word ${wordClass}`}
                                            >
                                                {wordObj.text}{' '}
                                            </motion.span>
                                        )
                                    })}
                                </AnimatePresence>
                                <span className="typewriter-cursor" />
                            </>
                        ) : null}
                    </div>
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
                                                <button
                                                    className={`copy-btn ${isCopied ? 'copied' : ''}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (currentQA) {
                                                            navigator.clipboard.writeText(currentQA.answer);
                                                            setIsCopied(true);
                                                            setTimeout(() => setIsCopied(false), 2000);
                                                        }
                                                    }}
                                                    title="Copy answer"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                                    </svg>
                                                </button>
                                            
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
                                        <div className="sonar-effect">
                                            <div className="sonar-ring" />
                                            <div className="sonar-ring" />
                                            <div className="sonar-ring" />
                                            <div className="radar-sweep" />
                                            <div className="sonar-center">
                                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                                    <line x1="12" x2="12" y1="19" y2="22" />
                                                </svg>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>

            {/* Footer Removed */}

            <ResizeHandles />
        </div >
    )
}
