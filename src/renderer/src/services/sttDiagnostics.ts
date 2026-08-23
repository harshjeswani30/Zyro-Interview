/**
 * Development-only instrumentation for the live transcription pipeline.
 *
 * Answers the two questions that are otherwise guesswork when the transcript feels
 * slow: how long the STT round trip actually took, and how long the renderer sat on
 * the result before it was on screen.
 *
 * Enabled automatically in a dev build, or in any build by running
 *   localStorage.setItem('zyro:stt-diag', '1')
 * in the overlay devtools and restarting the session. Transcript text is only ever
 * printed in a dev build — a production session logs lengths and timings only, so
 * enabling this on a real interview machine cannot leak what was said.
 */

const IS_DEV = Boolean(import.meta.env?.DEV)

function flagEnabled(): boolean {
    try {
        return window.localStorage.getItem('zyro:stt-diag') === '1'
    } catch {
        return false
    }
}

const ENABLED = IS_DEV || flagEnabled()

export type SttKind = 'partial' | 'commit' | 'final'

interface PendingStt {
    id: number
    kind: SttKind
    /** Sequence number within its kind, for correlating out-of-order responses. */
    seq: number
    /** Audio-clock position of the oldest sample in the clip, in seconds. */
    audioFromSec: number
    durationSec: number
    language: string
    requestedAt: number
    respondedAt?: number
    chars?: number
}

let nextId = 1
const pending = new Map<number, PendingStt>()

/** Rolling totals, to make STT request amplification visible at a glance. */
const totals = { requests: 0, audioSec: 0, wallSec: 0, dropped: 0 }
let sessionStart = 0

export function isDiagEnabled(): boolean {
    return ENABLED
}

export function diagStartSession(): void {
    if (!ENABLED) return
    pending.clear()
    totals.requests = 0
    totals.audioSec = 0
    totals.wallSec = 0
    totals.dropped = 0
    sessionStart = performance.now()
    console.log('[STT-Diag] session started (text logging: %s)', IS_DEV ? 'on' : 'redacted')
}

/** Call immediately before the STT request leaves the renderer. Returns a handle. */
export function diagStartStt(info: {
    kind: SttKind
    seq: number
    audioFromSec: number
    durationSec: number
    language: string
}): number {
    if (!ENABLED) return 0
    const id = nextId++
    pending.set(id, { id, ...info, requestedAt: performance.now() })
    totals.requests++
    totals.audioSec += info.durationSec
    return id
}

/** Call as soon as the STT response is in hand, before any filtering. */
export function diagEndStt(handle: number, text: string): void {
    if (!ENABLED || !handle) return
    const rec = pending.get(handle)
    if (!rec) return
    rec.respondedAt = performance.now()
    rec.chars = text.length
    const sttMs = Math.round(rec.respondedAt - rec.requestedAt)
    console.log(
        `[STT-Diag] #${rec.id} ${rec.kind}/${rec.seq} audio@${rec.audioFromSec.toFixed(1)}s ` +
            `dur=${rec.durationSec.toFixed(2)}s lang=${rec.language} stt=${sttMs}ms ` +
            `chars=${rec.chars}${IS_DEV ? ` text="${text}"` : ''}`
    )
}

/**
 * Call when the text from `handle` has been written to the DOM. Reports the
 * renderer-side share of the delay, which is the part a UI change can regress.
 */
export function diagDisplayed(handle: number): void {
    if (!ENABLED || !handle) return
    const rec = pending.get(handle)
    pending.delete(handle)
    if (!rec?.respondedAt) return
    const now = performance.now()
    console.log(
        `[STT-Diag] #${rec.id} ${rec.kind}/${rec.seq} response→display=${Math.round(now - rec.respondedAt)}ms ` +
            `audio→display=${Math.round(now - (rec.requestedAt - rec.durationSec * 1000))}ms`
    )
}

/** Call when a response is thrown away (stale sequence, noise, closed utterance). */
export function diagDropped(handle: number, reason: string): void {
    if (!ENABLED || !handle) return
    const rec = pending.get(handle)
    pending.delete(handle)
    totals.dropped++
    if (!rec) return
    console.log(`[STT-Diag] #${rec.id} ${rec.kind}/${rec.seq} dropped: ${reason}`)
}

/** Per-utterance summary: the numbers that show whether STT is being oversubscribed. */
export function diagUtterance(info: {
    voicedSec: number
    committedSegments: number
    finalChars: number
    finalizeMs: number
}): void {
    if (!ENABLED) return
    totals.wallSec = (performance.now() - sessionStart) / 1000
    console.log(
        `[STT-Diag] utterance voiced=${info.voicedSec.toFixed(1)}s segments=${info.committedSegments} ` +
            `finalize=${info.finalizeMs}ms chars=${info.finalChars} | session: ${totals.requests} reqs, ` +
            `${totals.audioSec.toFixed(0)}s audio sent over ${totals.wallSec.toFixed(0)}s wall ` +
            `(${(totals.audioSec / Math.max(1, totals.wallSec)).toFixed(1)}x realtime), ${totals.dropped} dropped`
    )
}
