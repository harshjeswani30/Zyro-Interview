import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { motion, AnimatePresence } from 'framer-motion'
import { closeOpenCodeFence } from '../services/pipeline/streamMarkdown'

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

/* ─── Copy / check glyphs ─────────────────────────────────────── */
function CopyGlyph(): React.ReactElement {
    return (
        <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden>
            <path d="M216,40H88A16,16,0,0,0,72,56V72H56A16,16,0,0,0,40,88V216a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM184,216H56V88H184V216Zm32-32H200V88a16,16,0,0,0-16-16H88V56H216V184Z" />
        </svg>
    )
}

function CheckGlyph(): React.ReactElement {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

/**
 * Code block with its own copy button.
 *
 * The code text is read straight off the rendered <pre> via innerText rather
 * than reconstructed from the markdown children, so the copied text matches
 * exactly what the user sees even after syntax highlighting wraps it in spans.
 */
function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
    const preRef = React.useRef<HTMLPreElement>(null)
    const [copied, setCopied] = React.useState(false)
    const resetRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    React.useEffect(() => {
        return () => {
            if (resetRef.current) clearTimeout(resetRef.current)
        }
    }, [])

    const handleCopy = (): void => {
        const text = preRef.current?.innerText?.replace(/\n+$/, '') ?? ''
        if (!text) return
        // Route through the main process — navigator.clipboard fails silently in the
        // overlay window (alwaysOnTop + skipTaskbar means Chromium denies the
        // clipboard-write permission). typeof, not truthiness: writeClipboard is
        // non-optional in the Api type, so `if (api?.writeClipboard)` is a condition
        // TypeScript knows can never be false.
        if (typeof window.api?.writeClipboard === 'function') {
            window.api.writeClipboard(text).catch(() => {})
        } else {
            navigator.clipboard.writeText(text).catch(() => {})
        }
        setCopied(true)
        if (resetRef.current) clearTimeout(resetRef.current)
        resetRef.current = setTimeout(() => setCopied(false), 1600)
    }

    return (
        <div className="code-block-wrapper">
            <button
                type="button"
                className={`copy-btn code-copy-btn no-drag ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
                title={copied ? 'Copied' : 'Copy code'}
                aria-label={copied ? 'Code copied' : 'Copy code'}
            >
                {copied ? <CheckGlyph /> : <CopyGlyph />}
            </button>
            <pre ref={preRef}>{children}</pre>
        </div>
    )
}

/* ─── Main component ─────────────────────────────────────────── */
interface AnimatedAnswerProps {
    /** Full answer markdown. Under streaming this grows between renders. */
    answer: string
    /** Show the skeleton loader instead of the answer. */
    isThinking: boolean
}

export function AnimatedAnswer({ answer, isThinking }: AnimatedAnswerProps): React.ReactElement {
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

    // A stream can pause inside an unclosed fence. Repair it for display only.
    const renderable = closeOpenCodeFence(answer)

    return (
        <div className="animated-answer-content qa-answer markdown-content">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
            >
                {renderable}
            </ReactMarkdown>
        </div>
    )
}
