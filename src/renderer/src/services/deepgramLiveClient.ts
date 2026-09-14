/*
 * Live (streaming) speech-to-text over a WebSocket.
 *
 * The rest of the pipeline transcribes *clips*: record a slice, upload it, wait for
 * text. That is what made the on-screen transcript lag a full phrase behind the
 * speaker. This connection instead stays open for the turn and returns a growing
 * hypothesis every ~100-300ms, which is what word-by-word display needs.
 *
 * Scope is deliberately narrow: this feeds the on-screen ticker only. The
 * authoritative transcript that a question is answered from still comes from the batch
 * path, which is heavily tuned for accuracy (pre/post-roll, hallucination gates,
 * language pinning) and is not worth trading for latency.
 *
 * Auth: browsers cannot set an Authorization header on a WebSocket, so Deepgram takes
 * the key as a subprotocol pair. That means the key is visible to the page -- fine for
 * a proxy URL that injects it server-side, a real exposure for a desktop build that
 * ships one. `endpoint` exists so the caller can point this at a gateway proxy instead.
 */

import {
    applyDeepgramMessage,
    emptyLiveTranscript,
    interimWordCount,
    liveTranscriptText,
    type LiveTranscriptState
} from './pipeline/liveTranscriptStream'

export interface LiveTranscriberOptions {
    /** Sample rate of the PCM being pushed in. Sent to the recogniser as-is. */
    sampleRate: number
    /**
     * Deepgram key, or '' when none is configured. Ignored when `endpoint` points at a
     * proxy that supplies its own credentials.
     */
    apiKey: string
    /** Override the socket URL. Defaults to Deepgram's live endpoint. */
    endpoint?: string
    /**
     * Gateway HMAC token for a proxied endpoint. Browsers cannot set headers on a
     * WS handshake, so the gateway's auth middleware reads `?token=` from the URL
     * instead (audit C7). Empty for a direct Deepgram connection.
     */
    wsToken?: string
    /** BCP-47 tag, or 'multi' to let Nova-3 keep both halves of a Hinglish sentence. */
    language?: string
    /** Called whenever the visible text changes. `liveWords` is the unconfirmed tail. */
    onText: (text: string, liveWords: number) => void
    /** Called when the connection gives up, so the caller can fall back to batch STT. */
    onUnavailable?: (reason: string) => void
}

const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
/** Attempts before declaring the connection unavailable. */
const MAX_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 800

/** Float32 [-1,1] to little-endian linear16, which is what `encoding=linear16` expects. */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const out = new DataView(new ArrayBuffer(input.length * 2))
    for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i]))
        out.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    }
    return out.buffer
}

export function buildLiveUrl(opts: LiveTranscriberOptions): string {
    const params = new URLSearchParams({
        model: 'nova-3',
        language: opts.language || 'multi',
        encoding: 'linear16',
        sample_rate: String(Math.round(opts.sampleRate)),
        channels: '1',
        // The three that matter for a live ticker: revisions as you speak, punctuation
        // so the text reads like a question, and phrase-level finals to commit against.
        interim_results: 'true',
        smart_format: 'true',
        punctuate: 'true'
    })
    const base = `${opts.endpoint || DEEPGRAM_LIVE_URL}?${params.toString()}`
    // Gateway auth for a proxied endpoint — see wsToken docs above. Appended last
    // so it never interferes with the provider's own params.
    return opts.wsToken ? `${base}&token=${encodeURIComponent(opts.wsToken)}` : base
}

export class LiveTranscriber {
    private socket: WebSocket | null = null
    private state: LiveTranscriptState = emptyLiveTranscript()
    private attempts = 0
    private stopped = false
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    /** Audio that arrived before the socket was open. Bounded: see push(). */
    private backlog: ArrayBuffer[] = []

    constructor(private readonly opts: LiveTranscriberOptions) {}

    get available(): boolean {
        return this.socket?.readyState === WebSocket.OPEN
    }

    start(): void {
        this.stopped = false
        this.open()
    }

    private open(): void {
        if (this.stopped) return
        if (!this.opts.apiKey && !this.opts.endpoint) {
            this.opts.onUnavailable?.('no streaming key configured')
            return
        }
        this.attempts += 1
        try {
            const url = buildLiveUrl(this.opts)
            this.socket = this.opts.apiKey
                ? new WebSocket(url, ['token', this.opts.apiKey])
                : new WebSocket(url)
        } catch (err) {
            this.fail(`socket construction failed: ${(err as Error).message}`)
            return
        }

        this.socket.binaryType = 'arraybuffer'

        this.socket.onopen = () => {
            this.attempts = 0
            const queued = this.backlog
            this.backlog = []
            queued.forEach((buf) => this.socket?.send(buf))
        }

        this.socket.onmessage = (event) => {
            if (typeof event.data !== 'string') return
            let parsed: unknown
            try {
                parsed = JSON.parse(event.data)
            } catch {
                return
            }
            const next = applyDeepgramMessage(this.state, parsed)
            // The reducer returns the same object for the many frames that carry no
            // transcript, which is what keeps keep-alives off the render path.
            if (next === this.state) return
            this.state = next
            this.opts.onText(liveTranscriptText(next), interimWordCount(next))
        }

        this.socket.onerror = () => {
            /* onclose always follows; retrying is handled there */
        }

        this.socket.onclose = (event) => {
            this.socket = null
            if (this.stopped) return
            if (this.attempts >= MAX_ATTEMPTS) {
                this.fail(`connection closed (${event.code})`)
                return
            }
            this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_DELAY_MS)
        }
    }

    /** Feeds one capture chunk. Safe to call before the socket is open. */
    push(chunk: Float32Array): void {
        if (this.stopped) return
        const buf = floatTo16BitPCM(chunk)
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(buf)
            return
        }
        // Hold at most ~2s of audio while connecting; past that the oldest is dropped,
        // because a backlog longer than the utterance is worse than a late start.
        const maxChunks = Math.ceil((this.opts.sampleRate * 2) / 4096)
        this.backlog.push(buf)
        if (this.backlog.length > maxChunks) this.backlog.shift()
    }

    /** Clears the accumulated text without dropping the connection. */
    reset(): void {
        this.state = emptyLiveTranscript()
    }

    stop(): void {
        this.stopped = true
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.backlog = []
        const sock = this.socket
        this.socket = null
        if (sock && sock.readyState === WebSocket.OPEN) {
            // Tells Deepgram to flush its final result before hanging up.
            try {
                sock.send(JSON.stringify({ type: 'CloseStream' }))
            } catch {
                /* closing anyway */
            }
        }
        sock?.close()
    }

    private fail(reason: string): void {
        this.stopped = true
        this.socket = null
        this.opts.onUnavailable?.(reason)
    }
}
