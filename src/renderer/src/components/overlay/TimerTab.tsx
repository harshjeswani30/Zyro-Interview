import React from 'react'
import type { TimeBand } from './types'

export interface TimerTabProps {
    /** Pre-formatted remaining balance, e.g. "12:04". */
    label: string
    /** Urgency band -- only changes the trailing word here; colour lives on the root. */
    band: TimeBand
    /** Remaining fraction of the session, 0..1. */
    progress: number
}

/** Floating session-balance tab. The root element (OverlayPage) carries `data-time`. */
function TimerTabBase({ label, band, progress }: TimerTabProps): React.ReactElement {
    const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0

    return (
        <div className="ttab no-drag" title="Session balance">
            <span className="pip" />
            <span className="num">{label}</span>
            <span className="lbl">
                {band === 'crit' ? 'Ending' : band === 'warn' ? 'Low' : 'Left'}
            </span>
            <span className="bar">
                <i style={{ width: `${clamped * 100}%` }} />
            </span>
        </div>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree. */
export const TimerTab = React.memo(TimerTabBase)
