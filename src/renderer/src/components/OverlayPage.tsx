import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    initAI,
    generateInterviewAnswer,
    transcribeAudioOnly,
    analyzeScreen,
    SessionData
} from '../services/aiService'
import 'highlight.js/styles/github-dark.css'
import { TopResizeHandles, BottomResizeHandles } from './ResizeHandles'
import { motion, AnimatePresence } from 'framer-motion'
import { AnimatedAnswer } from './AnimatedAnswer'
import { toDisplayTranscript } from '../services/pipeline/devanagariToRoman'
import { useHeaderScale } from '../hooks/useHeaderScale'
import { AudioRing } from '../services/audioRing'
import {
    diagDisplayed,
    diagDropped,
    diagEndStt,
    diagStartSession,
    diagStartStt,
    diagUtterance,
    type SttKind
} from '../services/sttDiagnostics'

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

/**
 * Whisper's non-speech annotations. It emits these as *the whole transcript* when
 * handed audio with no speech in it, so they are matched against the whole string
 * only — a sentence that happens to contain "music" is real speech.
 */
const SOUND_TAGS = new Set([
    'music', 'wind', 'laughter', 'cough', 'coughing', 'sigh', 'throat clearing',
    'snort', 'gasp', 'whispering', 'silence', 'background noise', 'humming',
    'bell', 'chime', 'ring', 'beep', 'click', 'shh', 'hiss', 'grunt', 'groan',
    'giggle', 'applause', 'cheering', 'blank audio', 'no speech'
])

/**
 * Complete utterances that are acknowledgements rather than questions, in English,
 * Roman Hinglish and Devanagari.
 *
 * Matched by whole-string equality, never as a substring. That distinction is the
 * point: the previous `/^(yeah|yes|no|ok|…)\b/` prefix test combined with a length
 * cutoff threw away real questions such as "no sql vs sql" and "right join kya hai".
 */
const ACK_PHRASES = new Set([
    'ok', 'okay', 'k', 'kk', 'alright', 'all right', 'right', 'fine', 'cool', 'nice',
    'good', 'great', 'perfect', 'sure', 'sure sure', 'yes', 'yeah', 'yep', 'yup',
    'no', 'nope', 'got it', 'understood', 'i see', 'makes sense', 'no problem',
    'hello', 'hi', 'hey', 'bye', 'goodbye', 'good bye', 'see you', 'see you later',
    'thanks', 'thank you', 'thank you very much', 'thank you so much', 'thanks for watching',
    'thank you for watching', 'please subscribe', 'subscribe', 'the end',
    'you', 'so', 'well', 'and', 'but', 'because',
    // Common Whisper hallucinations for breath/throat/fillers
    'im', 'i am', 'im high', 'i am high', 'is', 'are', 'was', 'were',
    'im sorry', 'i am sorry', 'im going to go', 'im gonna go', 'im out', 'i dont know', 'i do not know',
    // Hinglish / Devanagari acknowledgements
    'theek hai', 'thik hai', 'theek', 'thik', 'accha', 'acha', 'achha',
    'accha theek hai', 'haan', 'haan ji', 'ji', 'ji haan', 'bilkul', 'sahi hai',
    'chalo', 'chaliye', 'next', 'ha ji', 'hmm ok', 'ok ok',
    'हां', 'हाँ', 'ठीक है',
    'अच्छा', 'जी', 'जी हां', 'जी हाँ', 'ठीक', 'चलो', 'सही है',
    'बिल्कुल'
])

/**
 * Vocalised hesitations. Never content words in either language, so they are safe to
 * strip from either end of an utterance.
 */
const SOUND_FILLERS = new Set([
    'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'hmm', 'hm', 'hmmm', 'mm', 'mmm',
    'ah', 'aah', 'ahh', 'oh', 'ohh', 'er', 'err', 'erm', 'eh', 'huh', 'uhhuh',
    'arre', 'arey',
    'हम्म', 'उम्म', 'अरे',
    'अह', 'अं'
])

/**
 * Discourse lead-ins: filler when they open an utterance, content anywhere else.
 * Only ever stripped from the front, and only while at least two tokens survive —
 * that guard is what keeps "yes bank", "right join" and "so what" intact.
 *
 * Deliberately excludes `no`, `not` and `matlab`: "no sql" and "matlab kya hai"
 * need those words to keep their meaning.
 */
const LEADIN_FILLERS = new Set([
    'so', 'okay', 'ok', 'alright', 'anyway', 'basically', 'actually', 'yeah', 'yes',
    'accha', 'acha', 'achha', 'haan', 'ji',
    'अच्छा', 'हां', 'हाँ', 'तो'
])

/** Single words that are a legitimate question on their own. */
const STANDALONE_TECH_WORDS = new Set([
    'polymorphism', 'inheritance', 'encapsulation', 'abstraction', 'closure', 'hoisting',
    'deadlock', 'mutex', 'semaphore', 'indexing', 'sharding', 'normalization', 'denormalization',
    'concurrency', 'multithreading', 'asynchronous', 'synchronous', 'eventloop', 'microservices',
    'kubernetes', 'docker', 'graphql', 'rest', 'grpc', 'websocket', 'btree', 'hashmap',
    'recursion', 'backtracking', 'memoization'
])

const PUNCT_RE = /[.,!?;:'"()[\]।]/g

const DEVANAGARI_RE = /[ऀ-ॿ]/

/** True when Whisper returned Hindi in native script, i.e. it detected Hindi. */
function hasDevanagari(text: string): boolean {
    return DEVANAGARI_RE.test(text)
}

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

interface CleanedTranscript {
    /** False when the utterance carries no question worth answering. */
    keep: boolean
    /** Edge fillers removed. Never reordered, never rewritten, never translated. */
    text: string
}

/**
 * Decides whether an utterance is worth sending to the LLM, and strips the
 * hesitations at its edges.
 *
 * Language-aware by construction rather than by branching on script. Devanagari used
 * to short-circuit this function entirely ("allow Hindi through"), so a Hindi
 * hesitation reached the LLM unfiltered while an English "no sql vs sql" was thrown
 * away by a prefix match on "no" plus a length cutoff. Both scripts now go through the
 * same three checks — watermark, whole-string acknowledgement, edge-strip — so neither
 * language is held to a different bar, and no word is ever removed from the middle of
 * an utterance.
 */
function cleanTranscript(raw: string): CleanedTranscript {
    const text = (raw || '').trim()
    if (!text) return { keep: false, text: '' }

    // 1. Subtitle/caption watermarks and STT prompt echoes. Whisper produces these out
    //    of silence; they are never something a person said into the mic.
    if (SUBTITLE_NOISE_PATTERNS.some((p) => p.test(text))) return { keep: false, text: '' }

    const normalized = text.toLowerCase().replace(PUNCT_RE, '').replace(/\s+/g, ' ').trim()
    if (!normalized) return { keep: false, text: '' }

    // 2. Whole-utterance sound tags and acknowledgements.
    if (SOUND_TAGS.has(normalized) || ACK_PHRASES.has(normalized)) return { keep: false, text: '' }

    // 3. Edge fillers. Tokens come from the original text so casing and script survive;
    //    only the comparison is normalised.
    const tokens = text.split(/\s+/).filter(Boolean)
    const key = (t: string): string => t.toLowerCase().replace(PUNCT_RE, '')

    let start = 0
    let end = tokens.length
    while (start < end && SOUND_FILLERS.has(key(tokens[start]))) start++
    while (end > start && SOUND_FILLERS.has(key(tokens[end - 1]))) end--
    // Lead-ins from the front only, and only while two or more tokens remain.
    while (end - start > 2 && LEADIN_FILLERS.has(key(tokens[start]))) start++

    const kept = tokens.slice(start, end)
    if (!kept.length) return { keep: false, text: '' }

    const cleaned = kept.join(' ')
    const cleanedNorm = cleaned.toLowerCase().replace(PUNCT_RE, '').trim()
    if (!cleanedNorm) return { keep: false, text: '' }
    // Stripping can expose an acknowledgement ("umm, theek hai").
    if (SOUND_TAGS.has(cleanedNorm) || ACK_PHRASES.has(cleanedNorm)) return { keep: false, text: '' }

    // 4. A lone word is only a question if it names something specific.
    if (kept.length === 1 && !STANDALONE_TECH_WORDS.has(cleanedNorm) && cleanedNorm.length < 12) {
        return { keep: false, text: '' }
    }

    return { keep: true, text: cleaned }
}

/**
 * Loose filter for the LIVE transcript ticker.
 *
 * cleanTranscript() above is deliberately strict because it gates the LLM — it throws
 * away single words and short acknowledgements. Applying that to partials meant the
 * ticker stayed blank until a whole sentence had landed, which is exactly the opposite
 * of feeling real-time. Here we only drop things that are never real speech: subtitle
 * watermarks, prompt echoes and whole-string sound tags. Everything else is shown as it
 * arrives and is superseded by the next, more complete partial.
 */
function isTranscriptNoise(text: string): boolean {
    if (!text || !text.trim()) return true
    if (SUBTITLE_NOISE_PATTERNS.some((p) => p.test(text))) return true

    const normalized = text.toLowerCase().replace(PUNCT_RE, '').trim()
    if (!normalized) return true

    // Whole-string sound tags only ("music", "beep") — a real sentence containing one
    // of these words still shows up.
    return SOUND_TAGS.has(normalized)
}

/**
 * Question starters for the auto-answer fast path. English front-loads the
 * interrogative, so that pattern stays `^`-anchored. Hindi/Hinglish puts it
 * anywhere in the sentence ("regression testing kya hai?"), so those are matched
 * unanchored, and Devanagari spellings are listed alongside the Roman ones
 * because Whisper emits either script depending on how much of the sentence was
 * actually spoken in Hindi.
 */
const TRIGGER_WORDS_EN =
    /^(what|how|why|can|could|tell|explain|describe|suppose|discuss|write|code|implement|show|if)\b/
const TRIGGER_WORDS_HI =
    /\b(kya|kaise|kaisa|kaisi|kyun|kyu|kyon|kab|kahan|kaun|kaunsa|konsa|kitna|kitne|batao|bataiye|samjhao|samjhaiye|likho|likhiye|agar)\b|क्या|कैस|क्यों|कितन|कौन|बता(इए|ओ)|समझा(ओ|इए)/i

/**
 * Joins a newly committed segment onto the text already committed.
 *
 * Segments are cut at VAD pauses and never overlap, so this is a plain join. It
 * replaces the old suffix/prefix "stitch" heuristic, which existed only because
 * partials re-transcribed a 24s sliding window and therefore had to be spliced onto
 * what was already on screen. That splice silently duplicated text whenever Whisper
 * reworded the seam (its fallback was raw concatenation), and the window re-send was
 * itself the cause of the request amplification behind the latency regression.
 */
function joinSegments(committed: string, next: string): string {
    const a = committed.trim()
    const b = next.trim()
    if (!a) return b
    if (!b) return a
    // Don't put a space before trailing punctuation Whisper emits as its own token.
    return /^[.,!?;:।]/.test(b) ? a + b : `${a} ${b}`
}

export default function OverlayPage(): React.ReactElement {
    // Keeps --hdr-scale in sync with the window width so every header button,
    // the status chip and all spacing shrink together below the default 820px.
    useHeaderScale()

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
    const [answerCopied, setAnswerCopied] = useState(false)
    const answerCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Copy the full answer markdown to the clipboard. The button reverts to its
    // idle icon on its own so it never gets stuck reading "Copied".
    const handleCopyAnswer = useCallback((): void => {
        const text = currentQA?.answer?.trim()
        if (!text) return
        navigator.clipboard.writeText(text).catch(() => {})
        setAnswerCopied(true)
        if (answerCopyResetRef.current) clearTimeout(answerCopyResetRef.current)
        answerCopyResetRef.current = setTimeout(() => setAnswerCopied(false), 1600)
    }, [currentQA?.answer])

    // A fresh answer clears the copied state, and the pending timer is dropped
    // on unmount so it cannot fire against a torn-down component.
    useEffect(() => {
        setAnswerCopied(false)
    }, [currentQA?.answer])

    useEffect(() => {
        return () => {
            if (answerCopyResetRef.current) clearTimeout(answerCopyResetRef.current)
        }
    }, [])
    const [pendingTranscript, setPendingTranscript] = useState('')
    const [displayedWords, setDisplayedWords] = useState<WordToken[]>([])
    const wordIdCounterRef = useRef(0)
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
    const lastReportedElapsedRef = useRef<number>(0)

    const handleEndInterview = useCallback(async () => {
        // 1. Hide the overlay window immediately so the user/interviewer doesn't see it
        window.api.endInterview()

        // 2. Perform background session logging and trial update
        if (sessionStartTimeRef.current) {
            const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
            const startedAt = new Date(sessionStartTimeRef.current).toISOString()
            const sessionType = session?.name || 'Interview'

            // Final incremental trial update if not premium
            if (!deductionFiredRef.current) {
                const delta = elapsed - lastReportedElapsedRef.current
                if (delta > 0) {
                    lastReportedElapsedRef.current = elapsed
                    await window.api.supabaseUpdateTrial(delta).catch(console.error)
                }
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
            lastReportedElapsedRef.current = 0
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
                lastReportedElapsedRef.current = 0
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

                // Persist incremental trial seconds to Supabase every 15 seconds
                trialUpdateIntervalRef.current = setInterval(() => {
                    if (!sessionStartTimeRef.current) return
                    const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
                    const delta = elapsed - lastReportedElapsedRef.current
                    if (delta > 0) {
                        lastReportedElapsedRef.current = elapsed
                        window.api.supabaseUpdateTrial(delta).catch(console.error)
                    }
                }, 15000)
            }
        }
    }

    const isPremium = sessionBalance > 0 || sessionDeducted || (session?.sessions_balance !== undefined && session.sessions_balance > 0)
    const [sessionElapsedSec, setSessionElapsedSec] = useState(0)

    useEffect(() => {
        const timer = setInterval(() => {
            if (sessionStartTimeRef.current) {
                setSessionElapsedSec(Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
            }
        }, 1000)
        return () => clearInterval(timer)
    }, [])

    const formatDuration = (totalSec: number) => {
        const mins = Math.floor(totalSec / 60)
        const secs = (totalSec % 60).toString().padStart(2, '0')
        return `${mins}:${secs}`
    }

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
        // Single choke point for romanising the ticker: pendingTranscript holds the
        // raw Whisper text (Devanagari when the interviewer spoke Hindi) so the LLM
        // still receives native script, while the bar reads as Roman Hinglish.
        const target = toDisplayTranscript(pendingTranscript)
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

    // Closes the diagnostics loop: `displayedWords` is what the transcript bar actually
    // renders, so an effect on it is the earliest point at which the text is on screen.
    // This is what separates "STT is slow" from "the UI is sitting on the result", which
    // was otherwise pure guesswork.
    useEffect(() => {
        if (!pendingDisplayHandleRef.current) return
        diagDisplayed(pendingDisplayHandleRef.current)
        pendingDisplayHandleRef.current = 0
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
        continuationCountRef.current = 0
        // Retire the open utterance as well, otherwise the in-flight partial for it
        // repaints the bar the user just cleared.
        utteranceIdRef.current += 1
        resetTranscriptStateRef.current?.()
    }, [])

    const contentRef = useRef<HTMLDivElement>(null)
    const bottomChatInputRef = useRef<HTMLInputElement>(null)
    const [autoAnswer, setAutoAnswer] = useState(true)
    const [isManualListening, setIsManualListening] = useState(false)
    const [isAudioSpeaking, setIsAudioSpeaking] = useState(false)
    const [screenProtection, setScreenProtection] = useState(true)
    const [, setZoomLevel] = useState(0)
    // zoomLevel is used via setZoomLevel(prev => ...) and its current value is tracked locally

    // ── VAD / audio pipeline refs ─────────────────────────────
    const audioContextRef = useRef<AudioContext | null>(null)
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
    const audioStreamRef = useRef<MediaStream | null>(null)
    /**
     * The single source of audio truth, addressed by absolute sample offset.
     *
     * Replaces two divergent buffers (one here, one inside the VAD worker) plus the
     * "only push while speech is active" rule that made a pre-roll impossible. Audio
     * is now pushed unconditionally and sliced on demand at the offsets the worker
     * reports, so nothing can be dropped by a state flag and the first phoneme of an
     * utterance is always available.
     */
    const ringRef = useRef<AudioRing | null>(null)
    const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isFinalizingRef = useRef(false)
    const manualListenRef = useRef(false)
    /** Ring offset at which the user pressed Listen, for the manual-mode fallback. */
    const manualStartSampleRef = useRef(0)
    /** True between pressing Stop and the worker answering, so a `discard` in that
     *  window can be recovered from instead of losing the turn. */
    const manualStopPendingRef = useRef(false)

    // ── Committed-segment transcript state ────────────────────
    /** Absolute sample offset where the not-yet-committed tail begins. */
    const segmentFromRef = useRef(0)
    /** Absolute sample offset where the current utterance began (incl. pre-roll). */
    const utteranceStartRef = useRef<number | null>(null)
    /** Bumped per utterance so a response from the previous one is discarded. */
    const utteranceIdRef = useRef(0)
    /** Voiced samples seen since the last commit — gates useless STT calls. */
    const voicedSinceCommitRef = useRef(0)
    /** Total voiced samples in this utterance, for diagnostics. */
    const utteranceVoicedRef = useRef(0)
    /** How many segments this utterance committed, for diagnostics. */
    const committedCountRef = useRef(0)
    /** Serialises commits so two boundaries can never interleave their text. */
    const commitChainRef = useRef<Promise<void>>(Promise.resolve())
    /** Live tail text, shown after the committed prefix. */
    const partialTailTextRef = useRef('')
    // Partials are pipelined, not serialised: only one may be in flight, and
    // `seq`/`applied` make sure a slow response never overwrites newer ticker text.
    const partialInFlightRef = useRef(false)
    const partialSeqRef = useRef(0)
    const partialAppliedSeqRef = useRef(0)
    /** Diagnostics handle for the STT call whose text is currently on screen. */
    const pendingDisplayHandleRef = useRef(0)

    // Expose finalizeQuestion to handleToggleManual (set inside startCapture)
    const finalizeQuestionRef = useRef<(() => void) | null>(null)
    /** Clears the committed-segment state that lives inside startCapture's closure. */
    const resetTranscriptStateRef = useRef<(() => void) | null>(null)
    const isGeneratingRef = useRef(false)
    /**
     * Monotonic answer-generation counter. A finalize that lands while an answer is
     * still streaming used to be dropped on the floor; now it is queued, and this
     * sequence number is what lets the newer answer win no matter which request the
     * gateway happens to return first.
     */
    const generationSeqRef = useRef(0)
    /** A finalize that arrived mid-generation, replayed once generation ends. */
    const queuedFinalizeRef = useRef<(() => void) | null>(null)
    const handleAnalyzeScreenRef = useRef<(() => void) | null>(null)
    const handleToggleAutoRef = useRef<(() => void) | null>(null)
    const handleToggleManualRef = useRef<(() => void) | null>(null)
    const vadWorkerRef = useRef<Worker | null>(null)

    const masterQuestionRef = useRef('') // full growing question
    const continuationCountRef = useRef(0) // how many appends so far
    const lastAnswerTimeRef = useRef<number | null>(null) // epoch-sec of last answer
    /**
     * Epoch-sec when speech actually stopped, as reported by the VAD worker.
     *
     * Previously stamped with Date.now() at the moment finalize *finished*, i.e. after
     * a Whisper round trip and a full LLM generation — up to ~10s after the person
     * stopped talking. Every gap was therefore under-measured by that amount, which is
     * why unrelated questions kept being appended to the previous one as
     * "continuations".
     */
    const lastSpeechEndRef = useRef<number | null>(null)
    /**
     * Window after speech ends in which more speech is treated as the same question.
     *
     * 4s, not the previous 12s. The VAD already waits LONG_PAUSE_SEC (2.4s) of silence
     * before finalizing at all, so anything past ~4s means the person paused, heard
     * nothing, and started a new thought. 12s reliably glued two unrelated questions
     * together — and now that the anchor is honest, a 12s window would be even wider in
     * practice than it was before.
     */
    const GRACE_WINDOW_SEC = 4.0
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

    // The volume/activity monitor that used to live here has been removed. It opened a
    // *second* AudioContext on the same stream and drove an uncancellable
    // requestAnimationFrame loop for the life of the window — two audio graphs on one
    // device, a rAF that survived teardown, and the only value it produced
    // (lastActiveSpeechRef) was never read. The VAD worker already reports speech
    // activity from the PCM the capture graph is decoding anyway.

    // ── VAD + Audio Capture ─────────────────────────────────────
    const startCapture = useCallback(async (sessionDataOverride?: SessionData) => {
        const sData = sessionDataOverride || sessionRef.current || session
        if (!sData) return

        // ── Segmentation tuning ──────────────────────────────────
        // Deliberately unchanged: the silence that ends an utterance. Everything else
        // below is about not wasting STT requests, so there was no need to trade
        // turn-taking feel for latency by shortening this.
        const LONG_PAUSE_SEC = 2.4
        // A pause this long is a safe place to freeze text: long enough that the cut
        // cannot land inside a word, short enough to happen several times a sentence.
        const COMMIT_PAUSE_SEC = 0.35
        const MIN_VOICED_SEC = 0.4
        const SPEECH_START_RMS = 0.018
        const SPEECH_END_RMS = 0.01
        // Renderer-side floor for "this chunk contained something". Slightly below the
        // worker's end threshold so voiced audio is never under-counted.
        const VOICED_RMS = 0.008
        // Audio kept from *before* the detected onset. The worker needs two consecutive
        // loud chunks (~170ms) to open an utterance and speech ramps up before that, so
        // without this the clip starts mid-phoneme — exactly the condition in which
        // Whisper invents a plausible-sounding first word.
        const PRE_ROLL_SEC = 0.3
        // Audio kept after the detected offset, for the same reason at the other end:
        // word-final consonants in Hindi ("hai", "hain", "nahin") sit on the threshold.
        const POST_ROLL_SEC = 0.2
        // Shortest clip worth a request. Below this there is nothing for Whisper to work
        // with and, on the default `auto` language, its detection is a coin toss.
        const MIN_STT_SEC = 0.5
        // Partial cadence, adaptive between these: a short tail is cheap to re-transcribe
        // often, a long one is not.
        const PARTIAL_MIN_MS = 300
        const PARTIAL_MAX_MS = 1200
        // The tail must have grown by this much before re-sending it is worth anything.
        const PARTIAL_GROWTH_SEC = 0.35
        // Ring capacity. Only has to cover the longest single utterance plus whatever is
        // still in flight; 90s of mono float32 at 48kHz is ~17MB.
        const RING_SEC = 90
        // Whisper's encoder window is 30s. Past that the request is both slower and less
        // accurate, so an utterance longer than this is finalized from its tail.
        const MAX_FINAL_SEC = 28

        // Initialize VAD Worker
        const worker = new Worker(new URL('../services/vadWorker.ts', import.meta.url))
        vadWorkerRef.current = worker

        // Held so a failure below can release the OS capture. Without this, throwing on
        // "System audio missing" left the screen-capture stream live and its recording
        // indicator on for the rest of the session.
        let rawStream: MediaStream | null = null

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
            rawStream = stream
            const audioTrack = stream.getAudioTracks()[0]
            if (!audioTrack)
                throw new Error('System audio missing. Ensure "Share system audio" is checked.')
            stream.getVideoTracks().forEach((t) => t.stop())

            audioStreamRef.current = new MediaStream([audioTrack])

            const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
            audioContextRef.current = audioCtx
            const sr = audioCtx.sampleRate
            ringRef.current = new AudioRing(Math.ceil(sr * RING_SEC))
            diagStartSession()

            const sourceNode = audioCtx.createMediaStreamSource(audioStreamRef.current)
            // bufferSize=4096 @ 48kHz ≈ 85ms per chunk
            const processor = audioCtx.createScriptProcessor(4096, 1, 1) as ScriptProcessorNode
            scriptProcessorRef.current = processor
            sourceNode.connect(processor)
            processor.connect(audioCtx.destination)

            /**
             * Language actually in use for this utterance.
             *
             * The default session language is `auto`, which makes every request an
             * independent detection — so a long Hindi question could have its opening
             * segment recognised as Hindi and its quiet trailing segment recognised as
             * something else, which is where "words that were never spoken" come from.
             * One Devanagari result is unambiguous proof the speaker is talking Hindi, so
             * from that point on the remaining calls of the utterance pin `hi`.
             */
            const utteranceLangRef = { current: '' as '' | 'hi' }
            const sessionLanguage = sData.language || 'auto'
            const isAutoLanguage = sessionLanguage.split('-')[0].toLowerCase() === 'auto'
            const noteScript = (text: string): void => {
                if (isAutoLanguage && !utteranceLangRef.current && hasDevanagari(text)) {
                    utteranceLangRef.current = 'hi'
                }
            }

            /** Committed segments, in order. Index-addressed so a late authoritative
             *  result can replace its own optimistic placeholder without disturbing the
             *  segments around it. */
            const committedSegments: string[] = []
            /** Tail length at the last partial request, for the growth gate. */
            let lastPartialTailSamples = 0
            const renderTicker = (): void => {
                setPendingTranscript(joinSegments(committedSegments.join(' '), partialTailTextRef.current))
            }
            /**
             * Drop every trace of the current utterance.
             *
             * `committedSegments` lives in this closure, so callers outside startCapture
             * (Clear button, manual-mode start) reach it through `resetTranscriptStateRef`
             * rather than keeping a second copy of the committed text. An earlier version
             * did keep a mirror ref, and clearing the mirror left the real array intact —
             * so the next partial repainted the transcript the user had just cleared.
             */
            const resetTranscriptState = (): void => {
                committedSegments.length = 0
                partialTailTextRef.current = ''
                voicedSinceCommitRef.current = 0
                utteranceVoicedRef.current = 0
                committedCountRef.current = 0
                utteranceStartRef.current = null
                utteranceLangRef.current = ''
                lastPartialTailSamples = 0
                manualStopPendingRef.current = false
                segmentFromRef.current = ringRef.current?.head ?? 0
                partialAppliedSeqRef.current = partialSeqRef.current
            }
            resetTranscriptStateRef.current = resetTranscriptState

            // ── Encode a ring slice → WAV → base64 → Whisper ─────────────────
            const transcribeSlice = async (
                from: number,
                to: number,
                kind: SttKind,
                seq: number
            ): Promise<{ text: string; handle: number }> => {
                const ring = ringRef.current
                if (!ring) return { text: '', handle: 0 }
                const chunks = ring.slice(from, to)
                if (!chunks.length) return { text: '', handle: 0 }
                const total = chunks.reduce((s, c) => s + c.length, 0)
                if (total < sr * MIN_STT_SEC) return { text: '', handle: 0 }

                const blob = encodeWAV(chunks, sr)
                const base64 = await new Promise<string>((resolve) => {
                    const r = new FileReader()
                    r.onloadend = () => resolve((r.result as string).split(',')[1])
                    r.readAsDataURL(blob)
                })
                const language = utteranceLangRef.current || sessionLanguage
                const handle = diagStartStt({
                    kind,
                    seq,
                    audioFromSec: from / sr,
                    durationSec: total / sr,
                    language
                })
                const text = (
                    await transcribeAudioOnly(
                        base64,
                        'audio/wav',
                        kind === 'partial',
                        utteranceLangRef.current || undefined
                    )
                )?.trim() ?? ''
                diagEndStt(handle, text)
                noteScript(text)
                return { text, handle }
            }

            // ── Commit a closed segment ──────────────────────────────────────
            /**
             * Freezes the text for `[from, to)` so it is never re-transcribed.
             *
             * The optimistic placeholder is whatever the last partial for this segment
             * showed, so the ticker never blanks or regresses while the authoritative
             * request is in flight. Commits are serialised through `commitChainRef` and
             * each writes to its own index, so two boundaries in quick succession cannot
             * interleave their text or overwrite each other.
             */
            const commitSegment = (from: number, to: number): void => {
                const utteranceId = utteranceIdRef.current
                const index = committedSegments.length
                committedSegments.push(partialTailTextRef.current)
                committedCountRef.current += 1
                partialTailTextRef.current = ''
                lastPartialTailSamples = 0
                // This utterance's remaining partials cover a different range now.
                partialAppliedSeqRef.current = partialSeqRef.current
                renderTicker()

                commitChainRef.current = commitChainRef.current
                    .then(async () => {
                        if (utteranceId !== utteranceIdRef.current) return
                        const seq = ++partialSeqRef.current
                        const { text, handle } = await transcribeSlice(from, to, 'commit', seq)
                        if (utteranceId !== utteranceIdRef.current) {
                            diagDropped(handle, 'utterance closed')
                            return
                        }
                        if (!text || isTranscriptNoise(text)) {
                            diagDropped(handle, 'noise')
                            return
                        }
                        committedSegments[index] = text
                        renderTicker()
                        pendingDisplayHandleRef.current = handle
                    })
                    .catch(() => {
                        /* a lost commit leaves the optimistic text in place */
                    })
            }

            // ── Finalize utterance → one full-clip Whisper pass → LLM ────────
            /**
             * Produces the transcript the LLM actually answers.
             *
             * Transcribes the whole utterance in ONE request rather than concatenating the
             * committed segments. Segments exist to make the ticker feel live; each is an
             * independent decode with its own language detection and its own seam, so
             * joining them is measurably worse than a single pass over the same audio —
             * which is where duplicated and invented words at segment joins came from. The
             * committed text is kept only as a fallback for a failed final request.
             */
            const finalizeQuestion = async (payload?: {
                startSample: number
                endSample: number
                voicedSamples: number
                speechEndAtMs: number
            }) => {
                const ring = ringRef.current
                if (!ring) return

                // Anchor the continuation window on when speech actually stopped, before
                // anything below can spend a second on a network round trip.
                const speechEndSec = (payload?.speechEndAtMs ?? Date.now()) / 1000

                const startSample = Math.max(
                    ring.tail,
                    (payload?.startSample ?? utteranceStartRef.current ?? ring.tail) -
                        Math.floor(sr * PRE_ROLL_SEC)
                )
                const endSample = Math.min(
                    ring.head,
                    (payload?.endSample ?? ring.head) + Math.floor(sr * POST_ROLL_SEC)
                )
                // A very long turn is finalized from its tail: Whisper's encoder window is
                // 30s and beyond it the request gets slower *and* less accurate.
                const clipFrom = Math.max(startSample, endSample - Math.floor(sr * MAX_FINAL_SEC))
                const voicedSec = utteranceVoicedRef.current / sr
                const fallbackText = joinSegments(
                    committedSegments.join(' '),
                    partialTailTextRef.current
                )

                // Close the utterance: every in-flight partial and commit belongs to it,
                // and none of them may repaint the ticker from here on.
                utteranceIdRef.current += 1
                manualListenRef.current = false
                if (partialTimerRef.current) {
                    clearTimeout(partialTimerRef.current)
                    partialTimerRef.current = null
                }
                partialAppliedSeqRef.current = partialSeqRef.current

                // A finalize that lands while an answer is still being written used to be
                // dropped, silently losing the question. Queue it instead — latest wins.
                if (isFinalizingRef.current || isGeneratingRef.current) {
                    queuedFinalizeRef.current = () => {
                        void finalizeQuestion({
                            startSample,
                            endSample,
                            voicedSamples: payload?.voicedSamples ?? 0,
                            speechEndAtMs: speechEndSec * 1000
                        })
                    }
                    setIsManualListening(false)
                    return
                }

                if (endSample - clipFrom < sr * MIN_STT_SEC) {
                    resetTranscriptState()
                    setIsManualListening(false)
                    setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                    return
                }

                isFinalizingRef.current = true
                setIsManualListening(false)
                const finalizeStartedAt = performance.now()

                try {
                    isGeneratingRef.current = true
                    setStatusText('Transcribing...')
                    const seq = ++partialSeqRef.current
                    const { text: pass, handle } = await transcribeSlice(
                        clipFrom,
                        endSample,
                        'final',
                        seq
                    )
                    // A failed or empty final pass falls back to what is already on
                    // screen rather than losing the question outright.
                    const finalText = pass || fallbackText
                    if (!pass && handle) diagDropped(handle, 'empty final, using ticker text')
                    diagUtterance({
                        voicedSec,
                        committedSegments: committedCountRef.current,
                        finalChars: finalText.length,
                        finalizeMs: Math.round(performance.now() - finalizeStartedAt)
                    })

                    // ── Filler / hallucination gate ───────────────────
                    const cleaned = cleanTranscript(finalText)
                    if (!cleaned.keep) {
                        // Nothing worth answering: drop the utterance AND the transcript
                        // it produced. Leaving it in rawSessionHistoryRef was how a
                        // discarded "hmm" ended up glued to the front of the next real
                        // question.
                        resetTranscriptState()
                        rawSessionHistoryRef.current = ''
                        setPendingTranscript('')
                        setDisplayedWords([])
                        isGeneratingRef.current = false
                        isFinalizingRef.current = false
                        setIsGenerating(false)
                        setIsThinking(false)
                        setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                        return
                    }
                    const keptText = cleaned.text

                    // ── Continuation vs new question ──────────────────
                    // Both timestamps now come from the VAD worker's view of when speech
                    // actually stopped. The old code stamped `lastSpeechEndRef` here, at
                    // the end of finalize — after a Whisper round trip and a whole LLM
                    // generation — so every gap was under-measured by seconds and
                    // unrelated questions kept being appended to the previous one.
                    const prevSpeechEnd = lastSpeechEndRef.current
                    const timeSinceLastSpeech =
                        prevSpeechEnd !== null ? speechEndSec - prevSpeechEnd : Infinity
                    lastSpeechEndRef.current = speechEndSec

                    const hasMaster = masterQuestionRef.current.trim().length > 0
                    const underCap = continuationCountRef.current < MAX_CONTINUATIONS
                    // An answer has already been delivered for the master question, so more
                    // speech is a reaction to that answer, not the rest of the question.
                    const answeredSince =
                        lastAnswerTimeRef.current !== null &&
                        prevSpeechEnd !== null &&
                        lastAnswerTimeRef.current >= prevSpeechEnd

                    if (
                        hasMaster &&
                        underCap &&
                        !answeredSince &&
                        timeSinceLastSpeech < GRACE_WINDOW_SEC
                    ) {
                        masterQuestionRef.current = joinSegments(masterQuestionRef.current, keptText)
                        continuationCountRef.current += 1
                    } else {
                        masterQuestionRef.current = keptText
                        continuationCountRef.current = 0
                    }

                    const question = masterQuestionRef.current

                    // Show the question, then the transcript bar is cleared — the final
                    // transcript has been committed to the question, so leaving it in the
                    // ticker would double it up against the next utterance.
                    setCurrentQA((prev) => ({
                        question,
                        answer: prev?.answer || '',
                        timestamp: new Date()
                    }))

                    setIsThinking(true)
                    setIsGenerating(true)
                    setStatusText('Thinking...')

                    resetTranscriptState()
                    rawSessionHistoryRef.current = ''
                    setPendingTranscript('')
                    setDisplayedWords([])

                    setStatusText('Writing...')
                    // Stamped before the await: whichever generation was started last is
                    // the one whose answer is allowed on screen, regardless of which
                    // request the gateway returns first.
                    const genSeq = ++generationSeqRef.current
                    const answer = await generateInterviewAnswer(question)

                    if (genSeq !== generationSeqRef.current) return
                    if (!answer) {
                        setStatusText('Failed')
                        return
                    }

                    displayHistoryRef.current += (displayHistoryRef.current ? ' ' : '') + question
                    setCurrentQA({ question, answer, timestamp: new Date() })
                    lastAnswerTimeRef.current = Date.now() / 1000
                } catch (err: any) {
                    setErrorMsg(`Error: ${err.message?.substring(0, 100)}`)
                } finally {
                    isGeneratingRef.current = false
                    isFinalizingRef.current = false
                    setIsGenerating(false)
                    setIsThinking(false)
                    setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
                    // Replay a finalize that arrived while this one was still running.
                    // Guard: if the user switched to Manual mode during generation, drop
                    // the queued finalize — it was auto-triggered and should not fire.
                    const queued = queuedFinalizeRef.current
                    queuedFinalizeRef.current = null
                    if (queued && autoAnswerRef.current) queued()
                }
            }

            // Expose to handleToggleManual (which lives outside this closure)
            finalizeQuestionRef.current = finalizeQuestion

            // ── Live partials: transcribe only the uncommitted tail ──────────
            /**
             * Re-transcribes the audio since the last committed boundary.
             *
             * The previous version re-sent up to 24 SECONDS of audio every 300ms. At that
             * cadence a single 20s question pushed something like 80x realtime audio at
             * the STT endpoint, which tripped Groq's rate limiter, put its keys into a 45s
             * cooldown, and pushed the *final* request — the one the answer waits on — onto
             * the slow fallback path or into retry backoff. That is the latency regression.
             *
             * Now the clip is only ever the tail since the last VAD pause, the cadence
             * scales with tail length, at most one request is in flight, and a tail that
             * has not grown is not re-sent at all.
             */
            const schedulePartial = (): void => {
                if (partialTimerRef.current) return
                const ring = ringRef.current
                if (!ring) return

                const tailSamples = Math.max(0, ring.head - segmentFromRef.current)
                const delay = Math.min(
                    PARTIAL_MAX_MS,
                    Math.max(PARTIAL_MIN_MS, PARTIAL_MIN_MS + (tailSamples / sr) * 120)
                )

                partialTimerRef.current = setTimeout(() => {
                    partialTimerRef.current = null

                    const live = manualListenRef.current || utteranceStartRef.current !== null
                    // Reschedule before any early return, so a skipped tick can never kill
                    // the ticker for the rest of the turn.
                    if (live) schedulePartial()

                    if (isFinalizingRef.current || isGeneratingRef.current) return
                    if (partialInFlightRef.current) return

                    const r = ringRef.current
                    if (!r) return
                    const from = segmentFromRef.current
                    const to = r.head
                    const samples = to - from
                    if (samples < sr * MIN_STT_SEC) return
                    // Nothing new was said, or not enough new audio to change the text.
                    if (voicedSinceCommitRef.current < sr * 0.2) return
                    if (samples < lastPartialTailSamples + sr * PARTIAL_GROWTH_SEC) return

                    lastPartialTailSamples = samples
                    const utteranceId = utteranceIdRef.current
                    const seq = ++partialSeqRef.current
                    partialInFlightRef.current = true

                    void (async () => {
                        try {
                            const { text, handle } = await transcribeSlice(from, to, 'partial', seq)

                            if (utteranceId !== utteranceIdRef.current) {
                                diagDropped(handle, 'utterance closed')
                                return
                            }
                            if (isFinalizingRef.current || isGeneratingRef.current) {
                                diagDropped(handle, 'finalizing')
                                return
                            }
                            // A slower overlapping response must never rewind the ticker.
                            if (seq <= partialAppliedSeqRef.current) {
                                diagDropped(handle, `stale seq ${seq}`)
                                return
                            }
                            if (isTranscriptNoise(text)) {
                                diagDropped(handle, 'noise')
                                return
                            }

                            partialAppliedSeqRef.current = seq
                            partialTailTextRef.current = text
                            pendingDisplayHandleRef.current = handle
                            renderTicker()

                            if (
                                autoAnswerRef.current &&
                                !isGeneratingRef.current &&
                                (TRIGGER_WORDS_EN.test(text.toLowerCase()) ||
                                    TRIGGER_WORDS_HI.test(text))
                            ) {
                                setStatusText('Question Detected...')
                            }
                        } catch {
                            /* a dropped partial is cosmetic; the final pass is authoritative */
                        } finally {
                            partialInFlightRef.current = false
                        }
                    })()
                }, delay)
            }

            // ── VAD worker events ────────────────────────────────────────────
            worker.onmessage = (e) => {
                const { type, data } = e.data
                if (type === 'speech_start') {
                    // In manual mode, only track the utterance if the user has explicitly
                    // pressed the Listen button. Ignore ambient speech detected by VAD.
                    if (!autoAnswerRef.current && !manualListenRef.current) return
                    // Rewind to before the confirmed onset so the first phoneme survives.
                    const at = Math.max(
                        ringRef.current?.tail ?? 0,
                        data.atSample - Math.floor(sr * PRE_ROLL_SEC)
                    )
                    if (utteranceStartRef.current === null) {
                        utteranceStartRef.current = at
                        segmentFromRef.current = at
                        lastPartialTailSamples = 0
                    }
                    schedulePartial()
                } else if (type === 'segment_boundary') {
                    const from = segmentFromRef.current
                    const to = Math.min(
                        ringRef.current?.head ?? data.atSample,
                        data.atSample + Math.floor(sr * POST_ROLL_SEC)
                    )
                    // Only a boundary that actually closes off new speech is a commit; a
                    // pause inside a pause is not.
                    if (
                        utteranceStartRef.current !== null &&
                        voicedSinceCommitRef.current >= sr * 0.25 &&
                        to - from >= sr * MIN_STT_SEC
                    ) {
                        segmentFromRef.current = data.atSample
                        voicedSinceCommitRef.current = 0
                        commitSegment(from, to)
                    }
                } else if (type === 'finalize') {
                    manualStopPendingRef.current = false
                    // 🔴 MANUAL MODE GUARD: The VAD worker's own mode flag prevents it from
                    // emitting finalize in manual mode, but a race can occur when the user
                    // switches modes while a utterance is already open. Double-check here.
                    if (!autoAnswerRef.current) {
                        // In manual mode, a VAD-driven finalize is not wanted — the user
                        // controls when to stop via the Listen button (manual_stop).
                        // Just clean up the utterance state without generating an answer.
                        resetTranscriptState()
                        return
                    }
                    void finalizeQuestion(data)
                } else if (type === 'discard') {
                    // A manual turn the detector never opened — quiet speech that stayed
                    // under SPEECH_START_RMS. The user explicitly asked for this audio to
                    // be transcribed, so finalize it from the moment they pressed Listen
                    // rather than throwing the turn away. Renderer-counted voiced audio is
                    // the guard, so pure silence still costs nothing.
                    if (
                        manualStopPendingRef.current &&
                        utteranceVoicedRef.current >= sr * MIN_VOICED_SEC
                    ) {
                        manualStopPendingRef.current = false
                        void finalizeQuestion({
                            startSample: manualStartSampleRef.current,
                            endSample: ringRef.current?.head ?? 0,
                            voicedSamples: utteranceVoicedRef.current,
                            speechEndAtMs: Date.now()
                        })
                        return
                    }
                    // Too little real speech: throw the utterance away without an STT call.
                    // resetTranscriptState() also re-anchors segmentFromRef to the ring head.
                    utteranceIdRef.current += 1
                    resetTranscriptState()
                    setPendingTranscript('')
                    setDisplayedWords([])
                } else if (type === 'status') {
                    // Only apply VAD-driven status in auto mode.
                    // In manual mode the status chip is controlled by UI interactions
                    // (handleToggleManual), not by the detector's internal state changes.
                    if (autoAnswerRef.current) setStatusText(data)

                } else if (type === 'speech_active') {
                    const isSpeaking = data as boolean
                    setIsAudioSpeaking(autoAnswerRef.current ? isSpeaking : false)
                }
            }

            // Sync initial config to worker
            worker.postMessage({
                type: 'config',
                data: {
                    LONG_PAUSE_SEC,
                    COMMIT_PAUSE_SEC,
                    MIN_VOICED_SEC,
                    SPEECH_START_RMS,
                    SPEECH_END_RMS,
                    sampleRate: sr,
                    isAuto: autoAnswerRef.current,
                    isManual: manualListenRef.current
                }
            })

            // ── Capture loop (~85ms per chunk) ───────────────────────────────
            processor.onaudioprocess = (e: AudioProcessingEvent) => {
                const chunk = new Float32Array(e.inputBuffer.getChannelData(0))

                // Always buffer, always feed the detector. The old loop returned early for
                // the whole of `isFinalizingRef` — which spanned the entire LLM generation —
                // and in auto mode only pushed chunks that were already above the speech
                // threshold. Between them, utterances that began during a generation were
                // silently lost and every utterance lost its onset.
                ringRef.current?.push(chunk)
                worker.postMessage({ type: 'audio', data: chunk })

                if (computeRMS(chunk) >= VOICED_RMS) {
                    voicedSinceCommitRef.current += chunk.length
                    utteranceVoicedRef.current += chunk.length
                }

                if (manualListenRef.current || utteranceStartRef.current !== null) {
                    schedulePartial()
                }
            }

            setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
        } catch (err: any) {
            // Release everything this attempt acquired. `vadWorkerRef` is cleared too, so
            // the teardown effect cannot terminate an already-dead worker and, more to the
            // point, a failed start leaves no capture running.
            rawStream?.getTracks().forEach((t) => t.stop())
            audioStreamRef.current?.getTracks().forEach((t) => t.stop())
            audioStreamRef.current = null
            if (scriptProcessorRef.current) {
                scriptProcessorRef.current.onaudioprocess = null
                scriptProcessorRef.current.disconnect()
                scriptProcessorRef.current = null
            }
            audioContextRef.current?.close().catch(() => {})
            audioContextRef.current = null
            worker.onmessage = null
            worker.terminate()
            if (vadWorkerRef.current === worker) vadWorkerRef.current = null
            ringRef.current = null
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
            if (partialTimerRef.current) {
                clearTimeout(partialTimerRef.current)
                partialTimerRef.current = null
            }
            // Detach the callback before disconnecting: a ScriptProcessorNode keeps
            // firing (and keeps its closure, the ring and the worker reachable) until
            // its handler is cleared, so disconnect alone leaked the whole graph across
            // a start/stop/start cycle.
            if (scriptProcessorRef.current) {
                scriptProcessorRef.current.onaudioprocess = null
                scriptProcessorRef.current.disconnect()
                scriptProcessorRef.current = null
            }
            audioContextRef.current?.close().catch(() => {})
            audioContextRef.current = null
            audioStreamRef.current?.getTracks().forEach((t) => t.stop())
            audioStreamRef.current = null
            if (vadWorkerRef.current) {
                vadWorkerRef.current.onmessage = null
                vadWorkerRef.current.terminate()
                vadWorkerRef.current = null
            }
            ringRef.current = null
            // Retire anything still in flight so a late response cannot touch state
            // belonging to a torn-down session.
            utteranceIdRef.current += 1
            partialAppliedSeqRef.current = partialSeqRef.current
            partialInFlightRef.current = false
            queuedFinalizeRef.current = null
            finalizeQuestionRef.current = null
            resetTranscriptStateRef.current = null
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
            manualStopPendingRef.current = true
            // Order matters: `manual_stop` has to be handled while the worker still has
            // the utterance open. Clearing the manual flag first would reset it and turn
            // every manual stop into a discard.
            vadWorkerRef.current?.postMessage({ type: 'manual_stop' })
            // Clear the worker's manual flag as part of stopping. Without this it stayed
            // true for the rest of the session, so the worker kept treating silence as an
            // open utterance and never ended one on its own again.
            vadWorkerRef.current?.postMessage({
                type: 'config',
                data: { isAuto: autoAnswerRef.current, isManual: false }
            })
        } else {
            // START
            setIsManualListening(true)
            manualListenRef.current = true

            // Clear history for a fresh start when manually clicking 'Listen'
            rawSessionHistoryRef.current = ''
            setPendingTranscript('')
            setDisplayedWords([])
            // Close whatever the detector had open and start the segment at "now", so a
            // manual turn can never inherit audio from before the button was pressed.
            utteranceIdRef.current += 1
            resetTranscriptStateRef.current?.()
            manualStartSampleRef.current = segmentFromRef.current

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

            {/* Header / Grabbable bar */}
            <div className="overlay-header-static">
                {/* Top Resize Handles - Nested to punch holes in drag region */}
                <TopResizeHandles />
                {/* Floating Top-Right Trial Timer (Above Header Overlay) */}
                {!isPremium && !minimized && (
                    <div
                        className={`overlay-floating-trial-badge no-drag ${
                            trialSecondsRemaining < 60
                                ? 'danger'
                                : trialSecondsRemaining < 180
                                ? 'warning'
                                : 'normal'
                        }`}
                    >
                        <span className="trial-dot"></span>
                        <span className="trial-text">Trial {trialLabel}</span>
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
                                    className={`header-pill-btn btn-listen no-drag ${isManualListening ? 'listening pulse-red-ring' : ''}`}
                                    onClick={handleToggleManual}
                                    disabled={autoAnswer || isGenerating}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" x2="12" y1="19" y2="22" />
                                    </svg>
                                    <span className="btn-label">{isManualListening ? 'Stop' : 'Listen'}</span>
                                    <span className="btn-shortcut-badge">Ctrl Space</span>
                                </button>

                                <button
                                    className="header-pill-btn btn-screenshot no-drag"
                                    onClick={handleAnalyzeScreen}
                                    disabled={isGenerating}
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
                        <button
                            className={`ov-action-btn minimize no-drag ${minimized ? 'active' : ''}`}
                            onClick={() => setMinimized(!minimized)}
                        >
                            {minimized ? (
                                /* Minimized state: 4 Outward Arrows (Expand) */
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M9 9L4 4m0 5V4h5" />
                                    <path d="M15 9l5-5m-5 0h5v5" />
                                    <path d="M9 15l-5 5m0-5v5h5" />
                                    <path d="M15 15l5 5m-5 0h5v-5" />
                                </svg>
                            ) : (
                                /* Normal / Expanded state: 4 Inward Arrows (Contract / Minimize) */
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M4 4l6 6m-5 0h5V5" />
                                    <path d="M20 4l-6 6m5 0h-5V5" />
                                    <path d="M4 20l6-6m-5 0h5v5" />
                                    <path d="M20 20l-6-6m5 0h-5v5" />
                                </svg>
                            )}
                        </button>
                        <button
                            className="header-end-btn no-drag"
                            onClick={handleEndInterview}
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
                                                {toDisplayTranscript(currentQA?.question || '') || (isThinking ? "Capturing question..." : "No question detected")}
                                            </p>
                                        </div>

                                        <div className="qa-answer-container mt-2">
                                            <div className="qa-answer-header">
                                                <span className="qa-section-label">Answer</span>
                                                {!isThinking && currentQA?.answer && (
                                                    <button
                                                        type="button"
                                                        className={`qa-copy-btn no-drag ${answerCopied ? 'copied' : ''}`}
                                                        onClick={handleCopyAnswer}
                                                        title={answerCopied ? 'Copied' : 'Copy answer'}
                                                        aria-label={answerCopied ? 'Answer copied' : 'Copy answer'}
                                                    >
                                                        {answerCopied ? (
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                                <polyline points="20 6 9 17 4 12" />
                                                            </svg>
                                                        ) : (
                                                            <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor">
                                                                <path d="M216,40H88A16,16,0,0,0,72,56V72H56A16,16,0,0,0,40,88V216a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM184,216H56V88H184V216Zm32-32H200V88a16,16,0,0,0-16-16H88V56H216V184Z" />
                                                            </svg>
                                                        )}
                                                        <span>{answerCopied ? 'Copied' : 'Copy'}</span>
                                                    </button>
                                                )}
                                            </div>
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
                                        <div className="search-loader-wrapper">
                                            <div className="search-loader">
                                                <div className="search-loader-mini-container">
                                                    <div className="search-bar-container">
                                                        <span className="search-bar"></span>
                                                        <span className="search-bar search-bar-2"></span>
                                                    </div>
                                                    <svg
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        fill="none"
                                                        viewBox="0 0 101 114"
                                                        className="search-svg-icon"
                                                    >
                                                        <circle
                                                            strokeWidth="7"
                                                            transform="rotate(36.0692 46.1726 46.1727)"
                                                            r="29.5497"
                                                            cy="46.1727"
                                                            cx="46.1726"
                                                        ></circle>
                                                        <line
                                                            strokeWidth="7"
                                                            y2="111.784"
                                                            x2="97.7088"
                                                            y1="67.7837"
                                                            x1="61.7089"
                                                        ></line>
                                                    </svg>
                                                </div>
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

            {/* Bottom Resize Handles */}
            {!minimized && <BottomResizeHandles />}
        </div>
    )
}
