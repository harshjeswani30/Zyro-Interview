import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { motion, AnimatePresence } from 'framer-motion'
import { useWordReveal } from '../hooks/useWordReveal'

/* ─── Original Thinking Indicator (Restored) ─────────────────── */
function OldThinkingIndicator(): React.ReactElement {
    return (
        <div className="thinking-indicator">
            <div className="neural-flow">
                <div className="neural-wave">
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                </div>
                <span className="skeleton-text">Analyzing question...</span>
            </div>
            <div className="skeleton-modern" style={{ width: '100%' }} />
            <div className="skeleton-modern" style={{ width: '85%' }} />
            <div className="skeleton-modern" style={{ width: '60%' }} />
        </div>
    )
}

/* ─── Blinking cursor ─────────────────────────────────────────── */
function Cursor(): React.ReactElement {
    return <span className="animated-answer-cursor" aria-hidden />
}

/* ─── Main component ─────────────────────────────────────────── */
interface AnimatedAnswerProps {
    /** Full answer markdown string */
    answer: string
    /** Show skeleton loader instead of answer */
    isThinking: boolean
    /** Reveal speed in ms (default 20ms for snappier feel) */
    wordDelayMs?: number
}

export function AnimatedAnswer({
    answer,
    isThinking,
    wordDelayMs = 20,
}: AnimatedAnswerProps): React.ReactElement {

    const { visibleLength, isStreaming } = useWordReveal(
        isThinking ? undefined : answer,
        wordDelayMs
    )

    // ── Thinking state: Original Neural Flow ──────────────────────
    if (isThinking) {
        return (
            <AnimatePresence mode="wait">
                <motion.div
                    key="thinking"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <OldThinkingIndicator />
                </motion.div>
            </AnimatePresence>
        )
    }

    const visibleText = answer.slice(0, visibleLength)

    return (
        <div className="animated-answer-content qa-answer markdown-content">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    // Inject the cursor into the last child of the last paragraph
                    // so it stays inline and doesn't jump to a new line.
                    p: ({ children }) => (
                        <p>
                            {children}
                            {isStreaming && visibleLength > 0 && <Cursor />}
                        </p>
                    )
                }}
            >
                {visibleText}
            </ReactMarkdown>
            {/* Fallback cursor if there are no paragraphs (rare) */}
            {isStreaming && visibleLength === 0 && <Cursor />}
        </div>
    )
}
