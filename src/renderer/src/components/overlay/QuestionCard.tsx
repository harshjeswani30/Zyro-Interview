import React from 'react'

export interface QuestionCardProps {
    question: string
    /** Pre-formatted wall-clock time. */
    time: string
    /** True while the question text is still being transcribed. */
    capturing?: boolean
}

/** The detected interviewer question that sits above an answer. */
function QuestionCardBase({ question, time, capturing }: QuestionCardProps): React.ReactElement {
    return (
        <div className="card card--q q-card">
            <div className="card__meta">
                <span className="glyph">Q</span>
                <span>{capturing ? 'Capturing question' : 'Detected question'}</span>
                <span className="ts">{time}</span>
            </div>
            <div className="q">{question}</div>
        </div>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree. */
export const QuestionCard = React.memo(QuestionCardBase)
