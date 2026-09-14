/*
 * Shared contract between OverlayPage (all logic) and the presentational
 * pieces under components/overlay/. Nothing in here reaches for window.api or
 * app state -- the container owns every side effect and passes plain data down.
 */

/** Session-balance urgency band, drives the timer tab's colour states. */
export type TimeBand = 'ok' | 'warn' | 'crit'

/** Coarse overlay state; sets the dock aura + status orb colour. */
export type OverlayVisualState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'error'

/** One interviewer question and the answer generated for it. */
export interface QAPair {
    id: string
    question: string
    answer: string
    timestamp: Date
    /** True while the question is still being captured or the answer is streaming. */
    streaming: boolean
}

/**
 * One word of live transcript.
 *
 * The rail used to receive time-stamped *blocks*, each one a separately transcribed
 * audio segment. That model is gone: a streaming recogniser revises its hypothesis word
 * by word, so the rail now renders a single flowing stream and the only distinction
 * that matters is whether a word is still provisional.
 */
export interface RailWord {
    id: number
    text: string
    /** True while the recogniser may still revise this word. */
    live: boolean
}

