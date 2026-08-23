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
        navigator.clipboard.writeText(text).catch(() => {})
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
    wordDelayMs = 8,
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

    // The cursor belongs to the LAST rendered block only. Answers are now point
    // lists, so it has to be able to land inside an <li> as well as a <p>, and
    // it must not be duplicated into every earlier bullet. hast node positions
    // are offsets into visibleText, so the tail block is the one ending at the
    // end of the trimmed visible text.
    const tailOffset = visibleText.trimEnd().length
    const isTailNode = (node?: { position?: { end?: { offset?: number } } }): boolean => {
        if (!isStreaming || visibleLength === 0) return false
        const end = node?.position?.end?.offset
        return typeof end === 'number' ? end >= tailOffset : false
    }

    // A "loose" list wraps each bullet's text in a <p>, and that <p> ends at the
    // same offset as its <li>. Only the innermost one may own the cursor.
    const wrapsParagraph = (node?: { children?: unknown[] }): boolean =>
        Boolean(
            node?.children?.some(
                (child) =>
                    typeof child === 'object' &&
                    child !== null &&
                    (child as { tagName?: string }).tagName === 'p'
            )
        )

    return (
        <div className="animated-answer-content qa-answer markdown-content">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    p: ({ node, children }) => (
                        <p>
                            {children}
                            {isTailNode(node) && <Cursor />}
                        </p>
                    ),
                    li: ({ node, children }) => (
                        <li>
                            {children}
                            {!wrapsParagraph(node) && isTailNode(node) && <Cursor />}
                        </li>
                    ),
                    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
                }}
            >
                {visibleText}
            </ReactMarkdown>
            {/* Fallback cursor if there are no paragraphs (rare) */}
            {isStreaming && visibleLength === 0 && <Cursor />}
        </div>
    )
}
