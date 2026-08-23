/**
 * VAD Worker — pure voice-activity detector.
 *
 * It owns NO audio. Earlier versions kept their own copy of the utterance and
 * posted the whole Float32Array back on finalize, which meant:
 *   - two buffers (worker + main thread) that could disagree about what was said,
 *   - a structured clone of several MB at the worst possible moment (right before
 *     the LLM call), and
 *   - an unbounded buffer in manual mode, because `isManual` was never cleared.
 *
 * Now it only reports *where* speech starts and stops, as absolute sample offsets
 * on a monotonic audio clock that the main thread shares (both sides count every
 * chunk, in order, and neither ever resets the counter). The main thread owns one
 * ring buffer and slices it with those offsets.
 *
 * Events out:
 *   status           — human-readable state for the status chip
 *   speech_active    — boolean, drives the speaking indicator
 *   speech_start     — { atSample } an utterance opened
 *   segment_boundary — { atSample } sustained pause: safe place to commit text
 *   finalize         — { startSample, endSample, voicedSamples, speechEndAtMs }
 *   discard          — utterance ended with too little actual speech
 */

type Mode = 'auto' | 'manual'

// ── Config (overridden from the main thread) ────────────────────────────────
let LONG_PAUSE_SEC = 2.4
// A pause this long is a safe word boundary: long enough that cutting here cannot
// split a word, short enough to happen several times in a normal sentence.
let COMMIT_PAUSE_SEC = 0.35
// An utterance needs at least this much *voiced* audio to be worth transcribing.
// Measured on speech only, so 2.4s of trailing silence never counts towards it.
let MIN_VOICED_SEC = 0.4
let SPEECH_START_RMS = 0.018
let SPEECH_END_RMS = 0.01
let sampleRate = 48000
let mode: Mode = 'auto'

// ── State ──────────────────────────────────────────────────────────────────
/** Monotonic audio clock. Never reset — the main thread's ring shares it. */
let samplesSeen = 0
let speechActive = false
let pauseStartSample: number | null = null
let utteranceStartSample: number | null = null
let voicedSamples = 0
/** Consecutive above-threshold chunks, so one click cannot open an utterance. */
let onsetRunSamples = 0
/** Guards against re-emitting segment_boundary for the same pause. */
let boundaryEmittedAt: number | null = null

function computeRMS(buffer: Float32Array): number {
    let sum = 0
    for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i]
    }
    return Math.sqrt(sum / buffer.length)
}

function resetUtterance(): void {
    speechActive = false
    pauseStartSample = null
    utteranceStartSample = null
    voicedSamples = 0
    onsetRunSamples = 0
    boundaryEmittedAt = null
}

self.onmessage = (e: MessageEvent) => {
    const { type, data } = e.data

    if (type === 'config') {
        if (data.LONG_PAUSE_SEC) LONG_PAUSE_SEC = data.LONG_PAUSE_SEC
        if (data.COMMIT_PAUSE_SEC) COMMIT_PAUSE_SEC = data.COMMIT_PAUSE_SEC
        if (data.MIN_VOICED_SEC) MIN_VOICED_SEC = data.MIN_VOICED_SEC
        if (data.SPEECH_START_RMS) SPEECH_START_RMS = data.SPEECH_START_RMS
        if (data.SPEECH_END_RMS) SPEECH_END_RMS = data.SPEECH_END_RMS
        if (data.sampleRate) sampleRate = data.sampleRate
        // A mode switch always closes whatever was open, otherwise the offsets of a
        // half-finished auto utterance leak into the next manual turn.
        const nextMode: Mode = data.isManual ? 'manual' : 'auto'
        if (nextMode !== mode) {
            mode = nextMode
            resetUtterance()
            self.postMessage({ type: 'speech_active', data: false })
        }
        return
    }

    if (type === 'audio') {
        const chunk: Float32Array = data
        const rms = computeRMS(chunk)
        samplesSeen += chunk.length

        // ── Onset: two consecutive loud chunks (~170ms) before we call it speech.
        // The main thread pre-rolls ~300ms of audio before this offset, so the
        // confirmation delay does not clip the start of the first word.
        if (!speechActive) {
            if (rms >= SPEECH_START_RMS) {
                onsetRunSamples += chunk.length
                if (onsetRunSamples >= chunk.length * 2) {
                    speechActive = true
                    pauseStartSample = null
                    boundaryEmittedAt = null
                    const atSample = samplesSeen - onsetRunSamples
                    if (utteranceStartSample === null) {
                        utteranceStartSample = atSample
                        self.postMessage({ type: 'speech_start', data: { atSample } })
                    }
                    voicedSamples += onsetRunSamples
                    onsetRunSamples = 0
                    self.postMessage({ type: 'status', data: 'Listening...' })
                    self.postMessage({ type: 'speech_active', data: true })
                }
            } else {
                onsetRunSamples = 0
            }
        } else if (rms < SPEECH_END_RMS) {
            // ── Offset: recorded at the first quiet chunk so the boundary lands on
            // the real end of the word, not COMMIT_PAUSE_SEC later.
            speechActive = false
            pauseStartSample = samplesSeen - chunk.length
            self.postMessage({ type: 'status', data: 'Waiting...' })
            self.postMessage({ type: 'speech_active', data: false })
        } else {
            voicedSamples += chunk.length
        }

        if (pauseStartSample === null || utteranceStartSample === null) return

        const silence = (samplesSeen - pauseStartSample) / sampleRate

        // Pause long enough to be a word boundary: tell the main thread it can
        // freeze everything up to here as committed text.
        if (silence >= COMMIT_PAUSE_SEC && boundaryEmittedAt !== pauseStartSample) {
            boundaryEmittedAt = pauseStartSample
            self.postMessage({ type: 'segment_boundary', data: { atSample: pauseStartSample } })
        }

        // Auto mode ends the utterance on a long pause. Manual mode waits for the
        // user to press stop.
        if (mode === 'auto' && silence >= LONG_PAUSE_SEC) {
            if (voicedSamples >= sampleRate * MIN_VOICED_SEC) {
                self.postMessage({
                    type: 'finalize',
                    data: {
                        startSample: utteranceStartSample,
                        endSample: pauseStartSample,
                        voicedSamples,
                        // Wall-clock instant speech actually stopped. The main thread
                        // anchors its continuation window on this rather than on when
                        // finalize finished, which is up to ~10s later.
                        speechEndAtMs: Date.now() - silence * 1000
                    }
                })
            } else {
                self.postMessage({ type: 'discard' })
                self.postMessage({ type: 'status', data: 'Ready (Auto)' })
            }
            resetUtterance()
        }
        return
    }

    if (type === 'reset') {
        resetUtterance()
        self.postMessage({ type: 'speech_active', data: false })
        return
    }

    if (type === 'manual_stop') {
        if (utteranceStartSample !== null && voicedSamples >= sampleRate * MIN_VOICED_SEC) {
            const endSample = pauseStartSample ?? samplesSeen
            self.postMessage({
                type: 'finalize',
                data: {
                    startSample: utteranceStartSample,
                    endSample,
                    voicedSamples,
                    speechEndAtMs: Date.now() - ((samplesSeen - endSample) / sampleRate) * 1000
                }
            })
        } else {
            self.postMessage({ type: 'discard' })
        }
        resetUtterance()
        self.postMessage({ type: 'speech_active', data: false })
    }
}
