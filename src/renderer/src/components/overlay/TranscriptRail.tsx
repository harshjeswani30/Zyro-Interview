import React from 'react'
import { IconEqualizer, IconTrash } from './icons'
import type { RailWord } from './types'

/** Number of bars in the input meter. */
const METER_BARS = 22

/**
 * Fixed per-bar waveform profile. Deterministic on purpose -- randomising bar
 * heights would make the meter jitter on every unrelated re-render.
 */
const METER_SHAPE: readonly number[] = [
    0.34, 0.52, 0.71, 0.9, 0.62, 0.81, 1, 0.74, 0.56, 0.86, 0.96, 0.68, 0.91, 0.6, 0.79, 1, 0.7,
    0.53, 0.83, 0.65, 0.44, 0.3
]

/** Resting bar height in px is owned by CSS; hot bars grow from it. */
const BAR_BASE_PX = 3
const BAR_SPAN_PX = 15

export interface TranscriptRailProps {
    words: RailWord[]
    wordCount: number
    /** True while the recogniser is open -- pulses the head dot. */
    live: boolean
    /** Normalised input level, 0..1. */
    level: number
    onClear: () => void
    /** Attached to the scrolling body so the container can auto-stick to bottom. */
    bodyRef?: React.Ref<HTMLDivElement>
}

/** Left rail: the live word stream plus the input level meter. */
function TranscriptRailBase({
    words,
    wordCount,
    live,
    level,
    onClear,
    bodyRef
}: TranscriptRailProps): React.ReactElement {
    const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
    const activeBars = Math.round(clamped * METER_BARS)
    const dbValue = Math.round(-40 + clamped * 32)

    return (
        <aside className="stream">
            {/* The rail is only 270px wide, so this head is deliberately terse: a
                "Live transcript" label plus a labelled Clear button overflowed it and
                wrapped onto the word count. Clear is icon-only here; its Ctrl+Backspace
                shortcut is spelled out in the feed's empty state. */}
            <div className="panel-head">
                <span className="l">
                    <span className={`dot ${live ? 'live' : ''}`} />
                    Transcript
                </span>
                <span className="ph-right">
                    <span className="wc">
                        {wordCount} {wordCount === 1 ? 'word' : 'words'}
                    </span>
                    <button
                        type="button"
                        className="mini only-icon no-drag"
                        onClick={onClear}
                        aria-label="Clear transcript"
                    >
                        <IconTrash />
                    </button>
                </span>
            </div>

            <div className="stream__body" ref={bodyRef}>
                {/* The empty state only holds while nothing is being said. Once the
                    detector reports speech the stream opens immediately, so a bare caret
                    blinks in the ~300ms before the first word lands instead of the rail
                    still claiming nothing was captured. */}
                {words.length === 0 && !live ? (
                    <div className="stream__empty">
                        <div className="ear">
                            <IconEqualizer />
                        </div>
                        <b>Nothing captured yet</b>
                        Words appear here as they are spoken.
                    </div>
                ) : (
                    /* One flowing stream, not a list of time-stamped blocks: the
                       recogniser revises its tail as you speak, so a word is either
                       settled or still provisional and nothing else about it matters. */
                    <div className="wordstream">
                        {words.map((w) => (
                            <span key={w.id} className={`w ${w.live ? 'live' : ''}`}>
                                {w.text}{' '}
                            </span>
                        ))}
                        <span className="caret" />
                    </div>
                )}
            </div>

            <div className="stream__foot">
                <div className="meter">
                    {Array.from({ length: METER_BARS }, (_unused, i) => {
                        const hot = i < activeBars
                        const shape = METER_SHAPE[i] ?? 0.5
                        const height = Math.round(BAR_BASE_PX + shape * clamped * BAR_SPAN_PX)
                        return (
                            <i
                                key={i}
                                className={hot ? 'hot' : ''}
                                style={hot ? { height: `${height}px` } : undefined}
                            />
                        )
                    })}
                </div>
                <span className="db">{level > 0 ? `${dbValue} dB` : '—'}</span>
            </div>
        </aside>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree. */
export const TranscriptRail = React.memo(TranscriptRailBase)
