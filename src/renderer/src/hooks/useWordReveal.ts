import { useState, useEffect, useRef } from 'react'

interface UseWordRevealResult {
    visibleLength: number
    isStreaming: boolean
}

/**
 * useWordReveal — progressively reveals `answer` token-by-token
 * 
 * To match "earlier behavior", it now uses a smarter regex that groups
 * markdown punctuation and whole words together, preventing the 
 * "half-bold" flicker as much as possible.
 */
export function useWordReveal(
    answer: string | undefined,
    wordDelayMs = 20
): UseWordRevealResult {
    const [visibleLength, setVisibleLength] = useState(0)
    const [isStreaming, setIsStreaming] = useState(false)
    const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
    const answerRef  = useRef('')
    const posRef     = useRef(0)

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current)

        if (!answer) {
            setVisibleLength(0)
            setIsStreaming(false)
            answerRef.current = ''
            posRef.current     = 0
            return
        }

        if (answer === answerRef.current) return
        answerRef.current = answer
        posRef.current = 0
        setVisibleLength(0)
        setIsStreaming(true)

        const advance = () => {
            const full = answerRef.current
            const pos  = posRef.current

            if (pos >= full.length) {
                setVisibleLength(full.length)
                setIsStreaming(false)
                return
            }

            // --- SMARTER TOKENIZER ---
            // 1. If we see a code block start, advance to end of that line or block
            // 2. If we see markdown symbols (**, #, etc), grab them as one unit
            // 3. Otherwise, grab the next word + trailing spaces
            
            let next = pos
            const remaining = full.slice(pos)

            // Matcher for markdown tokens or words
            // Groups: [1] whitespace, [2] markdown punctuation, [3] words
            const match = remaining.match(/^(\s+)|(^[\*#_`>]+)|(^[^\s\*#_`>]+)/)
            
            if (match) {
                next += match[0].length
                // If it was just punctuation, maybe grab the next word too to avoid flicker
                if (match[2] && next < full.length) {
                    const nextMatch = full.slice(next).match(/^[^\s\*#_`>]+/)
                    if (nextMatch) next += nextMatch[0].length
                }
                // Always eat trailing spaces
                while (next < full.length && full[next] === ' ') next++
            } else {
                next++ // safety
            }

            posRef.current = next
            setVisibleLength(next)
            timerRef.current = setTimeout(advance, wordDelayMs)
        }

        timerRef.current = setTimeout(advance, 0)
        return () => { if (timerRef.current) clearTimeout(timerRef.current) }
    }, [answer, wordDelayMs])

    return { visibleLength, isStreaming }
}
