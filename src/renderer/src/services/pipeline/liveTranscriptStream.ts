/*
 * Reducer for a streaming-ASR transcript.
 *
 * This replaces the old "partition" model, where the on-screen text was rebuilt from a
 * list of separately-transcribed audio segments plus a partial tail. That model could
 * never be word-by-word: each segment was its own batch STT round trip, and every
 * segment boundary invalidated whichever partial was still in flight, so text only
 * really landed once the speaker paused.
 *
 * A streaming recogniser instead emits a growing interim hypothesis for the current
 * phrase and then freezes it as a final. Two rules are all that is needed:
 *
 *   - an interim result REPLACES the live tail (it is a revision, not an addition)
 *   - a final result APPENDS to the committed text and clears the tail
 *
 * Keeping that here, as a pure function over plain objects, is what makes the tail /
 * revision behaviour testable without a socket, a microphone, or a key.
 */

/** The shape of the `Results` payload Deepgram sends on a live connection. */
export interface DeepgramResultMessage {
    type?: string
    is_final?: boolean
    speech_final?: boolean
    channel?: {
        alternatives?: { transcript?: string }[]
    }
}

export interface LiveTranscriptState {
    /** Phrases the recogniser has frozen. Never revised again. */
    committed: string[]
    /** The current hypothesis for what is being said right now. Replaced on every tick. */
    interim: string
}

export function emptyLiveTranscript(): LiveTranscriptState {
    return { committed: [], interim: '' }
}

/** Pulls the transcript text out of a Deepgram message, or '' if it carries none. */
export function readTranscript(message: unknown): string {
    if (!message || typeof message !== 'object') return ''
    const alt = (message as DeepgramResultMessage).channel?.alternatives?.[0]
    const text = alt?.transcript
    return typeof text === 'string' ? text.trim() : ''
}

/**
 * Folds one recogniser message into the transcript.
 *
 * Returns the same object when nothing changed, so callers can skip a re-render on the
 * many empty keep-alive and metadata frames a live connection produces.
 */
export function applyDeepgramMessage(
    state: LiveTranscriptState,
    message: unknown
): LiveTranscriptState {
    const type = (message as DeepgramResultMessage | null)?.type
    // Metadata, UtteranceEnd, SpeechStarted and friends carry no transcript.
    if (type && type !== 'Results') return state

    const text = readTranscript(message)
    const isFinal = Boolean((message as DeepgramResultMessage | null)?.is_final)

    if (!isFinal) {
        // An interim is a revision of the live tail, not an addition to it. An empty
        // interim is a real event -- the recogniser withdrew its hypothesis -- but if the
        // tail is already empty there is nothing to change.
        if (text === state.interim) return state
        return { committed: state.committed, interim: text }
    }

    // A final with no text still closes the phrase: drop the tail rather than leaving a
    // hypothesis on screen that will never be confirmed.
    if (!text) {
        if (!state.interim) return state
        return { committed: state.committed, interim: '' }
    }

    return { committed: [...state.committed, text], interim: '' }
}

/** The full text to display: everything committed, plus the live tail. */
export function liveTranscriptText(state: LiveTranscriptState): string {
    const parts = state.interim ? [...state.committed, state.interim] : state.committed
    return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** How many trailing words are still an unconfirmed hypothesis. */
export function interimWordCount(state: LiveTranscriptState): number {
    if (!state.interim) return 0
    return state.interim.split(/\s+/).filter(Boolean).length
}
