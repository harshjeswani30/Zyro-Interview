import React, { useMemo } from 'react'
import { AnimatedAnswer } from '../AnimatedAnswer'
import { IconCheck, IconCopy } from './icons'

/** Words read per second used for the "~Ns read" estimate. */
const WORDS_PER_SECOND = 2.5

export interface AnswerCardProps {
    answer: string
    /** Pre-formatted wall-clock time. */
    time: string
    /** True while tokens are still arriving. */
    streaming: boolean
    /** Model label shown next to the title. */
    model: string
    /** True right after a successful copy -- swaps the chip to its done state. */
    copied: boolean
    onCopy: () => void
}

/** One generated answer: header, rendered markdown, copy chip and read stats. */
function AnswerCardBase({
    answer,
    time,
    streaming,
    model,
    copied,
    onCopy
}: AnswerCardProps): React.ReactElement {
    const { words, readSeconds } = useMemo(() => {
        const count = answer.split(/\s+/).filter((token) => token.length > 0).length
        return { words: count, readSeconds: Math.max(1, Math.ceil(count / WORDS_PER_SECOND)) }
    }, [answer])

    return (
        <div className={`card card--a a-card ${streaming ? 'streaming' : ''}`}>
            <div className="card__meta a-head">
                <span className="glyph a-glyph">A</span>
                <span className="card__title ttl">Answer</span>
                {model && <span className="card__sub sub">· {model}</span>}
                <span className="ts">{time}</span>
            </div>
            <div className="ans markdown-content">
                <AnimatedAnswer answer={answer} isThinking={false} />
            </div>
            <div className="card__foot a-foot">
                <button
                    type="button"
                    className={`chip cp no-drag ${copied ? 'done' : ''}`}
                    onClick={onCopy}
                >
                    {copied ? <IconCheck /> : <IconCopy />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
                <span className="stats">
                    <span>~{readSeconds}s read</span>
                    <span>{words} words</span>
                </span>
            </div>
        </div>
    )
}

/* Memoised: the overlay pushes a fresh audio level into state ~10x a second while the
   mic is open, which re-renders the container. Nothing here depends on that, so the
   props comparison is what keeps those ticks off this subtree -- answer body re-renders react-markdown, so this is the expensive one. */
export const AnswerCard = React.memo(AnswerCardBase)
