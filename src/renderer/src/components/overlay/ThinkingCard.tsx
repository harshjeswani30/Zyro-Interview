import React from 'react'

export interface ThinkingCardProps {
    /** Current pipeline step label, e.g. "Retrieving context". */
    step: string
}

/** Placeholder card shown while an answer is being composed. */
function ThinkingCardBase({ step }: ThinkingCardProps): React.ReactElement {
    return (
        <div className="card card--think t-card" id="thinkCard">
            <div className="card__meta">
                <span className="glyph">A</span>
                <span>Generating</span>
                {step && <span className="step">{step}</span>}
            </div>
            <div className="think-row">
                Thinking <span className="dots"><i /><i /><i /></span>
            </div>
            <div className="sk" style={{ width: '92%' }} />
            <div className="sk" style={{ width: '78%' }} />
            <div className="sk" style={{ width: '60%' }} />
        </div>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree. */
export const ThinkingCard = React.memo(ThinkingCardBase)
