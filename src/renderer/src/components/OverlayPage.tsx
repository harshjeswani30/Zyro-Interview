import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    initAI,
    generateInterviewAnswer,
    transcribeAudioOnly,
    analyzeScreen,
    SessionData,
    getCurrentModelName,
    getSttLanguage
} from '../services/aiService'
import 'highlight.js/styles/github-dark.css'
import '../assets/overlay.css'
import { TopResizeHandles, BottomResizeHandles } from './ResizeHandles'
import { TimerTab } from './overlay/TimerTab'
import { OverlayDock } from './overlay/OverlayDock'
import { TranscriptRail } from './overlay/TranscriptRail'
import { ConversationFeed } from './overlay/ConversationFeed'
import { QuestionCard } from './overlay/QuestionCard'
import { AnswerCard } from './overlay/AnswerCard'
import { ThinkingCard } from './overlay/ThinkingCard'
import { FeedEmptyState } from './overlay/FeedEmptyState'
import { Composer } from './overlay/Composer'
import type { OverlayVisualState, QAPair, RailWord, TimeBand } from './overlay/types'
import { toDisplayTranscript } from '../services/pipeline/devanagariToRoman'
import { detectUtteranceLanguage, type LanguageCode } from '../services/pipeline/languagePolicy'
import { useHeaderScale } from '../hooks/useHeaderScale'
import { useDrag } from '../hooks/useDrag'
import { AudioRing } from '../services/audioRing'
import { resolveSessionClock, TRIAL_LIMIT_SEC } from '../services/sessionClock'
import { LiveTranscriber } from '../services/deepgramLiveClient'
import { shouldAnswerFinalizedTurn } from '../services/pipeline/turnGating'
import {
    diagDisplayed,
    diagDropped,
    diagEndStt,
    diagStartSession,
    diagStartStt,
    diagUtterance,
    type SttKind
} from '../services/sttDiagnostics'

interface WordToken {
    id: number
    text: string
    timestamp: number
}

/** 14:22:07 -- question cards. */
function formatClock(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 14:22 -- answer cards, where seconds are just noise. */
function formatClockShort(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

/** Conversation history cap. Older pairs fall off the front; the visible pair is
    tracked by id so trimming can never silently change which one is on screen. */
const MAX_PAIRS = 30

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
    const dockDrag = useDrag()

    const [session, setSession] = useState<SessionData | null>(null)

    // Conversation history. The feed shows exactly one pair at a time and
    // Prev/Next page through the rest; answers stream into the pair they belong to.
    const [pairs, setPairs] = useState<QAPair[]>([])
    const [activeId, setActiveId] = useState<string | null>(null)
    const [hasNewerAnswer, setHasNewerAnswer] = useState(false)
    const [audioLevel, setAudioLevel] = useState(0)
    const [liveWordCount, setLiveWordCount] = useState(0)
    const [warnMsg, setWarnMsg] = useState('')
    const [isGenerating, setIsGenerating] = useState(false)
    const [minimized, setMinimized] = useState(false)
    const minimizedRef = useRef(minimized)
    useEffect(() => {
        minimizedRef.current = minimized
    }, [minimized])
    const [chatInput, setChatInput] = useState('')
    const [errorMsg, setErrorMsg] = useState('')
    const [statusText, setStatusText] = useState('Initializing...')
    const [overlayOpacity, setOverlayOpacity] = useState<number>(() => {
        try {
            const saved = localStorage.getItem('zv_overlay_opacity')
            if (saved) {
                const val = parseFloat(saved)
                if (!isNaN(val) && val >= 0 && val <= 1) return val
            }
        } catch {
            // fallback
        }
        return 0
    })

    const handleOpacityChange = useCallback((val: number) => {
        const clamped = Math.max(0, Math.min(1.0, Math.round(val * 100) / 100))
        setOverlayOpacity(clamped)
        try {
            localStorage.setItem('zv_overlay_opacity', clamped.toString())
        } catch {
            // fallback
        }
    }, [])

    const [clickThrough, setClickThrough] = useState<boolean>(() => {
        try {
            return localStorage.getItem('zv_overlay_click_through') === 'true'
        } catch {
            return false
        }
    })
    const clickThroughRef = useRef(clickThrough)
    useEffect(() => {
        clickThroughRef.current = clickThrough
    }, [clickThrough])

    const handleToggleClickThrough = useCallback((): void => {
        setClickThrough((prev) => {
            const next = !prev
            try {
                localStorage.setItem('zv_overlay_click_through', next ? 'true' : 'false')
            } catch {
                // fallback
            }
            return next
        })
    }, [])
    const handleToggleClickThroughRef = useRef(handleToggleClickThrough)
    useEffect(() => {
        handleToggleClickThroughRef.current = handleToggleClickThrough
    }, [handleToggleClickThrough])

    // isResizing moved to hooks logic, but we might want a local one for UI effects


    const [isThinking, setIsThinking] = useState(false)
    const [isScreenCapturing, setIsScreenCapturing] = useState(false)
    const [answerCopied, setAnswerCopied] = useState(false)
    const answerCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Mirrors of the two pieces of history state that async callbacks touch. The
    // STT/answer paths run outside React's render cycle, so they read and advance
    // these rather than closing over a snapshot that may already be stale.
    //
    // These refs are the ONLY write path: beginPair, updatePair, settleOpenPair,
    // navigateHistory and jumpToNewest each write the ref and then hand the very same
    // value to setState, and nothing else calls setPairs/setActiveId. There is
    // deliberately no effect syncing them back from state -- one used to exist, and
    // because a commit can land after the ref has already moved on, it rolled the ref
    // backwards: holding the Left arrow lost most of the steps (a measured run of 40
    // presses from the newest of 30 pairs stopped at the 3rd instead of the 1st).
    const pairsRef = useRef<QAPair[]>([])
    const activeIdRef = useRef<string | null>(null)
    const pairSeqRef = useRef(0)
    const openPairRef = useRef<string | null>(null)

    // Resolved from the id so a trim of the oldest pairs cannot shift the selection.
    // An id that no longer exists falls back to the newest pair.
    const activeIndex = useMemo(() => {
        if (pairs.length === 0) return -1
        const found = pairs.findIndex((p) => p.id === activeId)
        return found === -1 ? pairs.length - 1 : found
    }, [pairs, activeId])

    const activePair = activeIndex >= 0 ? pairs[activeIndex] : null

    /**
     * Opens a pair for a freshly captured question and returns its id; every later
     * delta for that question is applied through updatePair(id, ...).
     *
     * The view auto-advances only when the user was already sitting on the newest
     * pair. If they had paged back to re-read something, the new answer lands
     * silently and the "New answer" pill offers the jump instead.
     */
    const beginPair = useCallback((question: string): string => {
        const previous = pairsRef.current
        const atNewest =
            previous.length === 0 ||
            activeIdRef.current === null ||
            previous[previous.length - 1].id === activeIdRef.current

        const id = `pair-${Date.now().toString(36)}-${(++pairSeqRef.current).toString(36)}`
        openPairRef.current = id
        const appended = [
            ...previous,
            { id, question, answer: '', timestamp: new Date(), streaming: true }
        ]
        // Written straight to the ref as well: two questions can open inside one
        // React batch, and the second has to see the first.
        pairsRef.current =
            appended.length > MAX_PAIRS ? appended.slice(appended.length - MAX_PAIRS) : appended
        setPairs(pairsRef.current)

        if (atNewest) {
            activeIdRef.current = id
            setActiveId(id)
            setHasNewerAnswer(false)
        } else {
            setHasNewerAnswer(true)
        }
        return id
    }, [])

    /**
     * Closes whichever pair is still streaming. Called from every generation
     * path's finally block so a failed or superseded request cannot leave a card
     * stuck in the streaming state with its footer hidden. Safe to call twice.
     */
    const settleOpenPair = useCallback((): void => {
        const id = openPairRef.current
        if (!id) return
        openPairRef.current = null
        pairsRef.current = pairsRef.current.map((p) =>
            p.id === id ? { ...p, streaming: false } : p
        )
        setPairs(pairsRef.current)
    }, [])

    /** Applies a streamed delta (or the final answer) to one pair. */
    const updatePair = useCallback((id: string, patch: Partial<QAPair>): void => {
        pairsRef.current = pairsRef.current.map((p) => (p.id === id ? { ...p, ...patch } : p))
        setPairs(pairsRef.current)
    }, [])

    /** Left/Prev walks toward older answers, Right/Next back toward the newest. */
    const navigateHistory = useCallback((direction: 'prev' | 'next'): void => {
        const list = pairsRef.current
        if (list.length === 0) return
        const current = list.findIndex((p) => p.id === activeIdRef.current)
        const from = current === -1 ? list.length - 1 : current
        const to = Math.max(0, Math.min(list.length - 1, from + (direction === 'prev' ? -1 : 1)))
        if (to === from) return
        activeIdRef.current = list[to].id
        setActiveId(list[to].id)
        if (to === list.length - 1) setHasNewerAnswer(false)
    }, [])

    const jumpToNewest = useCallback((): void => {
        const list = pairsRef.current
        if (list.length === 0) return
        const newestId = list[list.length - 1].id
        activeIdRef.current = newestId
        setActiveId(newestId)
        setHasNewerAnswer(false)
    }, [])

    // Copy the full answer markdown to the clipboard. The button reverts to its
    // idle icon on its own so it never gets stuck reading "Copied".
    const handleCopyAnswer = useCallback((): void => {
        const text = activePair?.answer?.trim()
        if (!text) return
        // navigator.clipboard.writeText silently fails in overlay windows (alwaysOnTop +
        // skipTaskbar causes Chromium to deny clipboard-write permission). Route through
        // main process Electron clipboard module which always has access.
        if (window.api?.writeClipboard) {
            window.api.writeClipboard(text).catch(() => {})
        } else {
            navigator.clipboard.writeText(text).catch(() => {})
        }
        setAnswerCopied(true)
        if (answerCopyResetRef.current) clearTimeout(answerCopyResetRef.current)
        answerCopyResetRef.current = setTimeout(() => setAnswerCopied(false), 1600)
    }, [activePair?.answer])

    // A fresh answer clears the copied state, and the pending timer is dropped
    // on unmount so it cannot fire against a torn-down component.
    useEffect(() => {
        setAnswerCopied(false)
    }, [activePair?.id])

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
    const TRIAL_LIMIT = TRIAL_LIMIT_SEC // 10 minutes, shared with sessionClock
    const [sessionBalance, setSessionBalance] = useState<number>(-1) // -1 = unknown/loading
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

        // Serialize the full Q&A record BEFORE anything else — this is the only
        // copy of the interview that exists (MAX_PAIRS-capped, in-memory only).
        // Partial pairs (answer still streaming) are still real record; they ship.
        const qaRecord = pairsRef.current.map((p) => ({
            id: p.id,
            question: p.question,
            answer: p.answer,
            timestamp: p.timestamp instanceof Date ? p.timestamp.toISOString() : String(p.timestamp)
        }))

        // 2. Hand everything to the main process: it performs the credit/trial
        // accounting, session log, transcript save (+ Drive copy) within a time
        // budget and exits itself. The old renderer-orchestrated sequence ended
        // in app.exit(0), which could kill these in-flight network writes.
        if (sessionStartTimeRef.current) {
            const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
            const startedAt = new Date(sessionStartTimeRef.current).toISOString()
            const sessionType = session?.name || 'Interview'
            const premium =
                sessionBalance > 0 || (session?.sessions_balance && session.sessions_balance > 0)

            window.api.endInterviewAndExit({
                elapsed,
                startedAt,
                sessionType,
                premium: !!premium,
                releaseHold: session?.hasHold,
                qa: qaRecord
            })
            return
        }

        // No session start time (nothing to bill or log) — just exit.
        window.api.quitApp()
    }, [session, sessionBalance])

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
                initialTrialUsedRef.current = usedSeconds
                lastReportedElapsedRef.current = 0
                sessionStartTimeRef.current = Date.now()

                startTimers(balance, usedSeconds)
            })
            .catch(() => {
                // Guarded the same way .then is. Without the abort check a stale rejected
                // fetch overwrote an already-resolved balance with 0, dropping a paid
                // session onto the free-trial clock; and a balance we already learned is
                // never downgraded -- only the still-unknown -1 gets filled in.
                if (currentFetchId !== fetchIdRef.current) return
                setSessionBalance((prev) => (prev >= 0 ? prev : 0))
                sessionStartTimeRef.current = Date.now()
            })
    }, [session, handleEndInterview])

    const startTimers = (balance: number, usedSeconds: number) => {
        if (balance > 0) {
            // Paid user: mark as paid run (actual deduction happens at the end of the session)
            if (!deductionFiredRef.current) {
                deductionFiredRef.current = true
                setSessionDeducted(true)
            }
            
            // Auto-end based on available credit balance (1 credit = 1 hour = 3600s)
            const maxSecondsAllowed = balance * 3600
            
            if (trialTimeoutRef.current) clearTimeout(trialTimeoutRef.current)
            trialTimeoutRef.current = setTimeout(() => {
                handleEndInterview()
            }, maxSecondsAllowed * 1000)

            if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
            trialIntervalRef.current = setInterval(() => {
                if (!sessionStartTimeRef.current) return
                const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
                if (elapsed >= maxSecondsAllowed) {
                    if (trialIntervalRef.current) clearInterval(trialIntervalRef.current)
                    handleEndInterview()
                }
            }, 10000)
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

    const [sessionElapsedSec, setSessionElapsedSec] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => {
            if (sessionStartTimeRef.current) {
                setSessionElapsedSec(Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
            }
        }, 1000)
        return () => clearInterval(timer)
    }, [])

    // All of the premium-vs-trial and "is the balance even known yet" reasoning lives in
    // services/sessionClock.ts, where it is unit tested.
    const sessionClock = resolveSessionClock({
        sessionBalance,
        sessionDeducted,
        sessionPayloadBalance: session?.sessions_balance,
        trialSecondsUsed: initialTrialUsedRef.current,
        elapsedSeconds: sessionElapsedSec
    })
    const { balanceKnown, remainingSeconds } = sessionClock

    const formatHHMMSS = (totalSec: number) => {
        const h = Math.floor(totalSec / 3600).toString().padStart(2, '0')
        const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0')
        const s = Math.floor(totalSec % 60).toString().padStart(2, '0')
        return `${h}:${m}:${s}`
    }

    // Placeholder rather than a wrong number: until the balance lands, any figure here
    // would be the trial allowance, which is not this user's clock.
    const timerLabel = balanceKnown ? formatHHMMSS(remainingSeconds) : '--:--:--'

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

    const [showScheduledSuccess, setShowScheduledSuccess] = useState(false)

    // Handle resume (init-session event)
    useEffect(() => {
        if (!window.api.onInitSession) return
        const unlisten = window.api.onInitSession((data: any) => {
            const sess = data as SessionData
            setSession(sess)
            if (sess.sessionStartedFromSchedule) {
                setShowScheduledSuccess(true)
                setTimeout(() => setShowScheduledSuccess(false), 6000)
            }
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

    // The rail streams top-to-bottom now, so stick to the newest block. (This used
    // to chase the rightmost edge of the old horizontal pill bar, and the
    // is-overflowing fade mask that went with it no longer has anything to mask.)
    useEffect(() => {
        const el = transcriptContainerRef.current
        if (el) el.scrollTop = el.scrollHeight
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
    
    // Scroll to the top when a different pair becomes visible -- keyed on the pair id,
    // not the object, since streaming rewrites the pair on every coalesced flush.
    useEffect(() => {
        if (activePair && contentRef.current) {
            contentRef.current.scrollTop = 0
        }
    }, [activePair?.id])

    /**
     * The words the rail renders. liveWordCount is how many of the trailing words are
     * still a hypothesis the recogniser may revise -- 0 on the batch fallback, where
     * every word that reaches the screen has already been decoded.
     */
    const railWords = useMemo<RailWord[]>(() => {
        const firstLive = Math.max(0, displayedWords.length - liveWordCount)
        return displayedWords.map((word, i) => ({
            id: word.id,
            text: word.text,
            live: i >= firstLive
        }))
    }, [displayedWords, liveWordCount])

    const handleClearTranscript = useCallback(() => {
        setPendingTranscript('')
        setDisplayedWords([])
        setLiveWordCount(0)
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
    /**
     * Streaming recogniser for the on-screen ticker. Null when no key is configured, in
     * which case the batch partial/commit path below keeps painting the transcript.
     */
    const liveStreamRef = useRef<LiveTranscriber | null>(null)
    /** True while the socket owns the display, so batch STT does not fight it. */
    const streamingDisplayRef = useRef(false)
    /** Latest streamed text, used as the fallback if the final full-clip pass fails. */
    const streamedTextRef = useRef('')

    // Last wall-clock push of the meter level, for throttling.
    const lastLevelPushRef = useRef(0)
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
                } else if (e.key.toLowerCase() === 'm') {
                    // The minimize keycap's tooltip advertises this. It had no handler
                    // anywhere -- not here and not as a global shortcut in the main
                    // process -- so pressing it did nothing at all.
                    e.preventDefault()
                    setMinimized((prev) => !prev)
                } else if (e.key === 'Backspace') {
                    e.preventDefault()
                    handleClearTranscript()
                } else if (e.code === 'Space') {
                    e.preventDefault()
                    handleToggleManualRef.current?.()
                } else if ((e.shiftKey && e.key.toLowerCase() === 'c') || e.key.toLowerCase() === 't') {
                    e.preventDefault()
                    handleToggleClickThroughRef.current?.()
                }
            } else {
                if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    navigateHistory('prev')
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    navigateHistory('next')
                } else if (e.key === 'ArrowUp') {
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

        const handleMouseMove = (e: MouseEvent) => {
            // Never ignore mouse events while user is actively dragging the overlay or interacting with controls
            if ((window as any).__isDraggingOverlay || (window as any).__isInteractingWithOverlay) {
                if (currentIgnore) {
                    currentIgnore = false
                    window.api.setIgnoreMouseEvents(false)
                }
                return
            }

            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

            const dockEl = document.querySelector('.dock') as HTMLElement | null
            const pillEl = document.querySelector('.dock-drag-bar__pill') as HTMLElement | null
            const ttabEl = document.querySelector('.ttab') as HTMLElement | null

            const dockRect = dockEl?.getBoundingClientRect()
            const pillRect = pillEl?.getBoundingClientRect()
            const ttabRect = ttabEl?.getBoundingClientRect()

            let overPanel = false

            // 1. Check timer tab (above the dock)
            if (ttabRect && ttabRect.width > 0 && ttabRect.height > 0) {
                if (
                    e.clientX >= ttabRect.left &&
                    e.clientX <= ttabRect.right &&
                    e.clientY >= ttabRect.top &&
                    e.clientY <= ttabRect.bottom
                ) {
                    overPanel = true
                }
            }

            // 2. Check upper header dock:
            // Activate with a slight lead buffer (8px below dock bottom) so transitioning from below into the header is seamless.
            if (!overPanel && dockRect && dockRect.width > 0 && dockRect.height > 0) {
                const headerLeadBuffer = 8
                if (
                    e.clientY >= 0 &&
                    e.clientY <= dockRect.bottom + headerLeadBuffer &&
                    e.clientX >= dockRect.left &&
                    e.clientX <= dockRect.right
                ) {
                    overPanel = true
                }
            }

            // 3. Check the dash symbol (pill) in the middle space:
            if (
                !overPanel &&
                !minimizedRef.current &&
                pillRect &&
                pillRect.width > 0 &&
                pillRect.height > 0
            ) {
                const pillBufferX = 14
                const pillBufferY = 8
                if (
                    e.clientX >= pillRect.left - pillBufferX &&
                    e.clientX <= pillRect.right + pillBufferX &&
                    e.clientY >= pillRect.top - pillBufferY &&
                    e.clientY <= pillRect.bottom + pillBufferY
                ) {
                    overPanel = true
                }
            }

            // 4. Check the opacity bar in the answer panel header (only active when clickThrough is ON):
            const opacityBarEl = document.querySelector('.opacity-bar') as HTMLElement | null
            const opacityRect = opacityBarEl?.getBoundingClientRect()
            if (
                !overPanel &&
                !minimizedRef.current &&
                clickThroughRef.current &&
                opacityRect &&
                opacityRect.width > 0 &&
                opacityRect.height > 0
            ) {
                const pad = 6
                if (
                    e.clientX >= opacityRect.left - pad &&
                    e.clientX <= opacityRect.right + pad &&
                    e.clientY >= opacityRect.top - pad &&
                    e.clientY <= opacityRect.bottom + pad
                ) {
                    overPanel = true
                }
            }

            // 5. Check the click-through button in the answer panel header:
            // ALWAYS interactive (whether clickThrough is true or false) so user can toggle it on and off at any time!
            const clickThroughEl = document.querySelector('.click-through-btn') as HTMLElement | null
            const clickThroughRect = clickThroughEl?.getBoundingClientRect()
            let overClickThrough = false
            if (
                !minimizedRef.current &&
                clickThroughRect &&
                clickThroughRect.width > 0 &&
                clickThroughRect.height > 0
            ) {
                const pad = 10
                if (
                    e.clientX >= clickThroughRect.left - pad &&
                    e.clientX <= clickThroughRect.right + pad &&
                    e.clientY >= clickThroughRect.top - pad &&
                    e.clientY <= clickThroughRect.bottom + pad
                ) {
                    overClickThrough = true
                }
            }

            let isOverInteractive = false
            if (clickThroughRef.current) {
                // Click-Through / Overlay Focus is ON:
                // All buttons in the answer panel work on click (over deck, cards, acts Prev/Next, copy chip, composer, dock, etc.)
                isOverInteractive =
                    overPanel ||
                    overClickThrough ||
                    !!el?.closest(
                        '.dock, .ttab, .dock-drag-bar__pill, .resize-handle-adv, .deck, .deck *'
                    )
            } else {
                // Click-Through / Overlay Focus is OFF: Background focus mode.
                // Clicks pass straight through the answer panel to background windows.
                // Only upper dock, timer tab, drag pill, and the click-through toggle button itself remain interactive.
                isOverInteractive =
                    overPanel ||
                    overClickThrough ||
                    !!el?.closest(
                        '.dock, .ttab, .dock-drag-bar__pill, .click-through-btn, .click-through-btn *'
                    )
            }

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
        //
        // Raised from 0.35s. Every commit invalidates whichever partial is still in
        // flight (its range just changed), and a partial round trip is 500-900ms -- so at
        // 0.35s a natural micro-pause threw away nearly every partial before it could
        // paint, which is why batch-path text only appeared once the speaker stopped.
        const COMMIT_PAUSE_SEC = 0.9
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
        // Shortest clip worth a request. The old 0.5s floor was set when Whisper was the
        // primary recogniser; the gateway now sends to Deepgram Nova-3 first, which is far
        // more tolerant of short audio, so this can come down and let the first words show
        // sooner. Whisper only sees it as a fallback.
        const MIN_STT_SEC = 0.3
        // Partial cadence, adaptive between these: a short tail is cheap to re-transcribe
        // often, a long one is not.
        const PARTIAL_MIN_MS = 140
        const PARTIAL_MAX_MS = 1200
        // The tail must have grown by this much before re-sending it is worth anything.
        const PARTIAL_GROWTH_SEC = 0.18
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
            // First confident language surfaced by Whisper for THIS utterance (Part B).
            // Empty until an auto-detected chunk comes back; the Devanagari pin above
            // still wins for Hindi. Fed into the response-language decision at finalize.
            const utteranceWhisperLangRef = { current: '' as string }
            // Resolved by initAI, which owns the rule (more than one configured answer
            // language means the recogniser must detect per utterance rather than being
            // pinned). Read rather than recomputed so there is one rule, not two that
            // can drift apart -- an earlier version computed it here as well and only
            // the copy in aiService reached the actual request.
            const sessionLanguage = getSttLanguage()
            const noteScript = (text: string): void => {
                // Not gated on isAutoLanguage any more. Devanagari coming back is
                // unambiguous proof the interviewer is speaking Hindi -- it is the
                // strongest signal in the whole pipeline -- and refusing to record it
                // just because the session pinned an STT locale threw that proof away,
                // which is how a Hindi question ended up answered in English.
                if (!utteranceLangRef.current && hasDevanagari(text)) {
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
                // The socket keeps its own accumulated text, so a reset has to clear that
                // too or the next turn starts with the previous question still on screen.
                liveStreamRef.current?.reset()
                streamedTextRef.current = ''
                setLiveWordCount(0)
                committedSegments.length = 0
                partialTailTextRef.current = ''
                voicedSinceCommitRef.current = 0
                utteranceVoicedRef.current = 0
                committedCountRef.current = 0
                utteranceStartRef.current = null
                utteranceLangRef.current = ''
                utteranceWhisperLangRef.current = ''
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
                const result = await transcribeAudioOnly(
                    base64,
                    'audio/wav',
                    kind === 'partial',
                    utteranceLangRef.current || undefined
                )
                const text = result?.text?.trim() ?? ''
                // Keep the first confident language Whisper surfaced for this utterance.
                // `auto` sessions get a real per-clip detection; once set we leave it, and
                // the Devanagari pin (utteranceLangRef) still overrides at finalize.
                if (!utteranceWhisperLangRef.current && result?.language) {
                    utteranceWhisperLangRef.current = result.language
                }
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
                // Segment commits only exist to freeze batch partial text at a pause. With
                // the socket driving the display there is nothing to freeze, and decoding
                // the segment again would just spend a request to reproduce text already
                // on screen.
                if (streamingDisplayRef.current) return
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
                // If the final full-clip pass fails, fall back to whatever is already on
                // screen. With the socket driving that is the streamed text; otherwise it
                // is the committed segments plus the partial tail.
                const fallbackText = streamingDisplayRef.current
                    ? streamedTextRef.current
                    : joinSegments(committedSegments.join(' '), partialTailTextRef.current)

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

                    // Decide the interviewer's language for THIS utterance now, before
                    // resetTranscriptState() below clears the per-utterance pins. Combines
                    // the Devanagari pin, Whisper's detected language, and the text itself.
                    const detectedLang: LanguageCode = detectUtteranceLanguage({
                        text: question,
                        devanagariPinned: utteranceLangRef.current === 'hi',
                        whisperLang: utteranceWhisperLangRef.current || undefined
                    })

                    // Show the question, then the transcript bar is cleared — the final
                    // transcript has been committed to the question, so leaving it in the
                    // ticker would double it up against the next utterance.
                    // Open the pair now so the question card and the thinking state are
                    // on screen before the model has produced a single token.
                    const pairId = beginPair(question)

                    setIsThinking(true)
                    setIsGenerating(true)
                    setStatusText('Thinking...')

                    resetTranscriptState()
                    rawSessionHistoryRef.current = ''
                    setPendingTranscript('')
                    setDisplayedWords([])

                    // Stamped before the await: whichever generation was started last is
                    // the one whose answer is allowed on screen, regardless of which
                    // request the gateway returns first.
                    const genSeq = ++generationSeqRef.current
                    const answer = await generateInterviewAnswer(question, detectedLang, {
                        requestId: `qa-${genSeq}`,
                        onDelta: (partial) => {
                            // A newer question superseded this one — drop its deltas.
                            if (genSeq !== generationSeqRef.current) return
                            // The first visible token ends the thinking state, so the
                            // skeleton is replaced by real text instead of by a finished answer.
                            setIsThinking(false)
                            setStatusText('Writing...')
                            updatePair(pairId, { answer: partial })
                        }
                    })

                    if (genSeq !== generationSeqRef.current) return
                    if (!answer) {
                        setStatusText('Failed')
                        return
                    }

                    displayHistoryRef.current += (displayHistoryRef.current ? ' ' : '') + question
                    updatePair(pairId, { answer, streaming: false })
                    lastAnswerTimeRef.current = Date.now() / 1000
                } catch (err: any) {
                    setErrorMsg(`Error: ${err.message?.substring(0, 100)}`)
                } finally {
                    settleOpenPair()
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
                    // The socket is painting the ticker word by word; a batch partial
                    // would only overwrite it with staler text and cost a request.
                    if (streamingDisplayRef.current) return
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
                    // The worker sends this same message both when it notices a pause by
                    // itself and when it is answering our own manual_stop, so the pending
                    // flag has to be read BEFORE it is cleared -- clearing first is what
                    // made manual mode swallow the user's own Stop and show a transcript
                    // with no answer under it.
                    const userRequestedStop = manualStopPendingRef.current
                    manualStopPendingRef.current = false
                    if (
                        !shouldAnswerFinalizedTurn({
                            autoMode: autoAnswerRef.current,
                            userRequestedStop
                        })
                    ) {
                        // Manual mode, and the detector ended the turn on its own. The user
                        // owns the boundary here, so drop it without generating.
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
                liveStreamRef.current?.push(chunk)
                worker.postMessage({ type: 'audio', data: chunk })

                const chunkRms = computeRMS(chunk)
                if (chunkRms >= VOICED_RMS) {
                    voicedSinceCommitRef.current += chunk.length
                    utteranceVoicedRef.current += chunk.length
                }

                // Drives the transcript rail's level meter. This callback runs every
                // few milliseconds -- far too often to push into React -- so it is
                // throttled to ~10fps, and floored so near-silence reads as no signal
                // instead of a permanently twitching bottom bar.
                const levelNow = Date.now()
                if (levelNow - lastLevelPushRef.current >= 100) {
                    lastLevelPushRef.current = levelNow
                    setAudioLevel(chunkRms < 0.006 ? 0 : Math.min(1, chunkRms / 0.12))
                }

                if (manualListenRef.current || utteranceStartRef.current !== null) {
                    schedulePartial()
                }
            }

            // ── Live streaming recogniser (on-screen ticker only) ─────────────
            // Deepgram returns a revised hypothesis every ~100-300ms, which is what
            // word-by-word display needs; the batch path can only ever deliver a phrase
            // at a time because each update re-uploads a growing clip. The question the
            // LLM answers still comes from the batch final pass.
            //
            // Two things here are deliberate, both learned the hard way:
            //   1. Nothing is awaited on the way in. This used to sit above the capture
            //      loop with an `await` on an IPC round trip, so a slow reply delayed
            //      wiring processor.onaudioprocess -- and until that is wired, no audio
            //      reaches the ring buffer, the detector, or the transcript at all.
            //   2. The batch ticker is only switched off once the socket has actually
            //      produced text. Flipping the flag at start() meant a socket that
            //      failed to deliver (bad key, blocked by CSP, route not deployed) left
            //      the display with no source whatsoever -- an empty rail, which is
            //      strictly worse than a slow one.
            void (async () => {
                try {
                    // Preferred route: the gateway proxies the socket to Deepgram, so the
                    // key stays a Worker secret. A key read straight from the desktop env
                    // is only a fallback for a machine that has one locally -- shipping a
                    // Deepgram key inside the app would make it extractable.
                    const gatewayBase = window.api.getAiGatewayUrl
                        ? await window.api.getAiGatewayUrl()
                        : ''
                    const gatewayToken = gatewayBase && window.api.getGatewayToken
                        ? await window.api.getGatewayToken()
                        : ''
                    const endpoint = gatewayBase
                        ? `${gatewayBase.replace(/^http/, 'ws').replace(/\/+$/, '')}/gateway/stt-stream`
                        : ''
                    const dgKey =
                        !endpoint && window.api.getDeepgramKey
                            ? await window.api.getDeepgramKey()
                            : ''
                    if (!endpoint && !dgKey) {
                        console.info('[STT] no streaming route — batch transcript ticker in use')
                        return
                    }
                    console.info('[STT] live stream via', endpoint || 'deepgram direct')
                    streamedTextRef.current = ''
                    const transcriber = new LiveTranscriber({
                        sampleRate: sr,
                        apiKey: dgKey,
                        endpoint: endpoint || undefined,
                        wsToken: gatewayToken || undefined,
                        onText: (text, liveWords) => {
                            // First real text is what earns the handover from batch.
                            if (!streamingDisplayRef.current) {
                                streamingDisplayRef.current = true
                                console.info('[STT] live stream is driving the transcript')
                            }
                            streamedTextRef.current = text
                            setPendingTranscript(text)
                            setLiveWordCount(liveWords)
                        },
                        onUnavailable: (reason) => {
                            // Hand the display back rather than leaving the rail frozen.
                            console.warn('[STT] live stream unavailable:', reason)
                            streamingDisplayRef.current = false
                            setLiveWordCount(0)
                        }
                    })
                    liveStreamRef.current = transcriber
                    transcriber.start()
                } catch (err) {
                    console.warn('[STT] live stream init failed:', (err as Error).message)
                    streamingDisplayRef.current = false
                }
            })()

            setStatusText(autoAnswerRef.current ? 'Ready (Auto)' : 'Manual Mode')
        } catch (err: any) {
            // Release everything this attempt acquired. `vadWorkerRef` is cleared too, so
            // the teardown effect cannot terminate an already-dead worker and, more to the
            // point, a failed start leaves no capture running.
            rawStream?.getTracks().forEach((t) => t.stop())
            audioStreamRef.current?.getTracks().forEach((t) => t.stop())
            audioStreamRef.current = null
            // Close the recogniser socket with the graph that feeds it, otherwise a
            // start/stop/start cycle leaves an orphan connection billing time.
            liveStreamRef.current?.stop()
            liveStreamRef.current = null
            streamingDisplayRef.current = false
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
            // Close the recogniser socket with the graph that feeds it, otherwise a
            // start/stop/start cycle leaves an orphan connection billing time.
            liveStreamRef.current?.stop()
            liveStreamRef.current = null
            streamingDisplayRef.current = false
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
            handleAnalyzeScreenRef.current?.()
        })
        const c4 = window.api.onScreenProtectionToggle((enabled) => {
            setScreenProtection(enabled)
        })
        // There were two more subscriptions here, onToggleAutoAnswer and
        // onClearTranscript. Both were declared in preload/index.d.ts but never
        // implemented in preload/index.ts, so the optional calls resolved to undefined
        // and the listeners never existed. Ctrl+A and Ctrl+Backspace are handled by the
        // local keydown listener above, so nothing was lost -- the declarations are gone
        // rather than half-wired.
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
        if (isGeneratingRef.current || isScreenCapturing) return
        setMinimized(false) // Auto-expand when starting scan
        setIsGenerating(true)
        setIsScreenCapturing(true)
        setStatusText('Analyzing Screen...')
        setErrorMsg('')
        try {
            // Stamped BEFORE the await so this scan immediately supersedes any in-flight
            // spoken/typed answer — its late deltas check genSeq against this ref — and
            // so this scan's own deltas have a sequence to validate against.
            const genSeq = ++generationSeqRef.current
            const pairId = beginPair('Screen Analysis Request')
            const result = await analyzeScreen({
                requestId: `scan-${genSeq}`,
                onDelta: (partial) => {
                    // A newer generation superseded this scan — drop its deltas.
                    if (genSeq !== generationSeqRef.current) return
                    if (partial && partial.trim()) {
                        setIsScreenCapturing(false)
                    }
                    setIsThinking(false)
                    setStatusText('Writing...')
                    updatePair(pairId, { answer: partial })
                }
            })
            setIsScreenCapturing(false)
            updatePair(pairId, { answer: result, streaming: false })
            setMinimized(false) // Ensure it's expanded once result is back

            // Reset continuation state for screen analysis
            masterQuestionRef.current = ''
            lastSpeechEndRef.current = null
            continuationCountRef.current = 0
        } catch (err: any) {
            setErrorMsg(err.message || 'Failed to analyze screen')
        } finally {
            settleOpenPair()
            setIsGenerating(false)
            setIsScreenCapturing(false)
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
        
        const genSeq = ++generationSeqRef.current
        const pairId = beginPair(query)
        try {
            // Typed query: no audio, so detect language from the text alone.
            const answer = await generateInterviewAnswer(
                query,
                detectUtteranceLanguage({ text: query }),
                {
                    requestId: `chat-${genSeq}`,
                    onDelta: (partial) => {
                        if (genSeq !== generationSeqRef.current) return
                        setIsThinking(false)
                        updatePair(pairId, { answer: partial })
                    }
                }
            )
            if (answer && genSeq === generationSeqRef.current) {
                displayHistoryRef.current += (displayHistoryRef.current ? ' ' : '') + query
                // Kept in the raw history because later answers use it as context, but
                // deliberately NOT pushed into pendingTranscript: that feeds the live
                // transcript rail, so a typed question used to appear there dressed up as
                // captured speech, complete with a timestamp and the in-progress caret.
                rawSessionHistoryRef.current += (rawSessionHistoryRef.current ? ' ' : '') + query
                updatePair(pairId, { answer, streaming: false })

                // Reset continuation state for manual chat query
                masterQuestionRef.current = ''
                lastSpeechEndRef.current = null
                continuationCountRef.current = 0
            }
            settleOpenPair()
            isGeneratingRef.current = false
            setIsGenerating(false)
            setIsThinking(false)
            setStatusText(autoAnswer ? 'Ready (Auto)' : 'Manual Mode')
        } catch (err: any) {
            setErrorMsg(err.message || 'Failed to generate answer')
            settleOpenPair()
            isGeneratingRef.current = false
            setIsGenerating(false)
            setIsThinking(false)
            setStatusText(autoAnswer ? 'Ready (Auto)' : 'Manual Mode')
        }
    }

    // ---- Derived view state -------------------------------------------------
    // data-state on the root drives the dock aura, the status colour and the orb,
    // so this is the single place the overlay's visual state is decided.
    const isTranscribing =
        statusText.toLowerCase().includes('transcrib') ||
        statusText.toLowerCase().includes('processing manual')

    const visualState: OverlayVisualState = errorMsg
        ? 'error'
        : isTranscribing
          ? 'transcribing'
          : isThinking || isGenerating
            ? 'thinking'
            : isManualListening || isAudioSpeaking
              ? 'listening'
              : 'idle'

    const timeBand: TimeBand = sessionClock.band
    const timeProgress = sessionClock.progress
    const transcriptLive = isAudioSpeaking || isManualListening
    const modelName = getCurrentModelName()

    // One banner per threshold crossing, auto-dismissed after six seconds. The ref
    // is what stops a re-render inside the same band from re-firing it.
    const lastTimeBandRef = useRef<TimeBand>('ok')
    useEffect(() => {
        // Nothing to warn about until the real balance is in. Without this the banner
        // fired on the loading render, off a trial clock the user was not even on.
        if (!balanceKnown) return undefined
        if (timeBand === lastTimeBandRef.current) return undefined
        lastTimeBandRef.current = timeBand
        if (timeBand === 'ok') return undefined
        setWarnMsg(
            timeBand === 'crit'
                ? 'Under 5 minutes left — wrap up soon'
                : 'Under 15 minutes left in this session'
        )
        const timer = setTimeout(() => setWarnMsg(''), 6000)
        return () => clearTimeout(timer)
    }, [timeBand, balanceKnown])

    // In manual mode capture is off until Listen is pressed, so park the meter at
    // zero instead of leaving it frozen on the last frame it saw.
    useEffect(() => {
        if (!autoAnswer && !isManualListening) setAudioLevel(0)
    }, [autoAnswer, isManualListening])

    // Global Left / Right (and numpad 4 / 6) page through answered questions.
    useEffect(() => {
        if (!window.api.onHistoryNav) return undefined
        return window.api.onHistoryNav((direction) => navigateHistory(direction))
    }, [navigateHistory])

    // The dock's Auto/Manual control is positional, not a toggle: clicking the side
    // that is already selected has to be a no-op.
    const handleModeChange = useCallback(
        (auto: boolean): void => {
            if (auto === autoAnswer) return
            handleToggleAutoRef.current?.()
        },
        [autoAnswer]
    )

    // Stable identities so the memoised dock and feed are not invalidated by a new
    // arrow function on every render -- which the ~10x/second audio level guarantees.
    const handleToggleMinimize = useCallback((): void => {
        setMinimized((prev) => !prev)
    }, [])

    const handleHistoryPrev = useCallback((): void => navigateHistory('prev'), [navigateHistory])
    const handleHistoryNext = useCallback((): void => navigateHistory('next'), [navigateHistory])
    const handleDismissWarn = useCallback((): void => setWarnMsg(''), [])
    const handleDismissError = useCallback((): void => setErrorMsg(''), [])

    const handleToggleStealth = useCallback((): void => {
        const next = !screenProtection
        setScreenProtection(next)
        window.api.toggleScreenProtection(next)
    }, [screenProtection])

    if (!session)
        return (
            <div className="overlay-loading">
                <div className="spinner-large" />
                <p>Loading session…</p>
            </div>
        )

    return (
        <div
            className="zv-overlay"
            data-state={visualState}
            data-mode={autoAnswer ? 'auto' : 'manual'}
            data-min={minimized ? 'true' : 'false'}
            data-stealth={screenProtection ? 'true' : 'false'}
            data-time={timeBand}
            data-click-through={clickThrough ? 'true' : 'false'}
            style={
                {
                    '--overlay-opacity': 0.5 + overlayOpacity * 0.5
                } as React.CSSProperties
            }
        >
            {/* Corner resize grips. They anchor to .zv-overlay, which spans the whole
                window, so each one sits on the window edge it resizes. */}
            <TopResizeHandles />
            {!minimized && <BottomResizeHandles />}

            {showScheduledSuccess && (
                <div className="zv-scheduled-toast">
                    <svg
                        className="i"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                    >
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Session successfully started!
                </div>
            )}

            {/* Stays put while minimized -- collapsing the deck should not cost you
                sight of the session clock. Dock and timer tab are bound together. */}
            <div className="dock-wrap">
                <TimerTab label={timerLabel} band={timeBand} progress={timeProgress} />
                <OverlayDock
                    statusText={statusText}
                    speaking={autoAnswer ? isAudioSpeaking : isManualListening}
                    autoMode={autoAnswer}
                    listening={isManualListening}
                    listenDisabled={autoAnswer || isGenerating}
                    captureDisabled={isGenerating && !isScreenCapturing}
                    capturing={isScreenCapturing}
                    stealthOn={screenProtection}
                    minimized={minimized}
                    onModeChange={handleModeChange}
                    onToggleListen={handleToggleManual}
                    onCapture={handleAnalyzeScreen}
                    onToggleStealth={handleToggleStealth}
                    onToggleMinimize={handleToggleMinimize}
                    onEnd={handleEndInterview}
                    onPointerDown={dockDrag.onPointerDown}
                />
            </div>

            {!minimized && (
                <div
                    className="dock-drag-bar"
                    title="Drag to move overlay"
                >
                    <div
                        className="dock-drag-bar__pill"
                        onPointerDown={dockDrag.onPointerDown}
                    >
                        <span className="dock-drag-bar__grip" />
                    </div>
                </div>
            )}

            <section className="deck glass">
                <TranscriptRail
                    words={railWords}
                    wordCount={displayedWords.length}
                    live={transcriptLive}
                    level={audioLevel}
                    onClear={handleClearTranscript}
                    bodyRef={transcriptContainerRef}
                />

                <ConversationFeed
                    total={pairs.length}
                    position={activeIndex + 1}
                    canPrev={activeIndex > 0}
                    canNext={activeIndex >= 0 && activeIndex < pairs.length - 1}
                    onPrev={handleHistoryPrev}
                    onNext={handleHistoryNext}
                    showNewPill={hasNewerAnswer}
                    onJumpNewest={jumpToNewest}
                    warnMsg={warnMsg}
                    onDismissWarn={handleDismissWarn}
                    errorMsg={errorMsg}
                    onDismissError={handleDismissError}
                    scrollRef={contentRef}
                    opacity={overlayOpacity}
                    onOpacityChange={handleOpacityChange}
                    clickThrough={clickThrough}
                    onToggleClickThrough={handleToggleClickThrough}
                    composer={
                        <Composer
                            value={chatInput}
                            disabled={isGenerating || autoAnswer}
                            onChange={setChatInput}
                            onSubmit={handleChatSubmit}
                            inputRef={bottomChatInputRef}
                        />
                    }
                >
                    {activePair ? (
                        <React.Fragment key={activePair.id}>
                            <QuestionCard
                                question={
                                    toDisplayTranscript(activePair.question) || 'Capturing question…'
                                }
                                time={formatClock(activePair.timestamp)}
                                capturing={activePair.streaming && !activePair.answer}
                            />
                            {activePair.streaming && !activePair.answer ? (
                                <ThinkingCard step={statusText} />
                            ) : (
                                <AnswerCard
                                    answer={activePair.answer}
                                    time={formatClockShort(activePair.timestamp)}
                                    streaming={activePair.streaming}
                                    model={modelName}
                                    copied={answerCopied}
                                    onCopy={handleCopyAnswer}
                                />
                            )}
                        </React.Fragment>
                    ) : (
                        <FeedEmptyState autoMode={autoAnswer} />
                    )}
                </ConversationFeed>
            </section>
        </div>
    )
}
