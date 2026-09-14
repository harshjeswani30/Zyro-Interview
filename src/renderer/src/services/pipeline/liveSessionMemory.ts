// liveSessionMemory.ts - rolling transcript memory, rendered under a token budget

export interface TranscriptTurn {
  speaker: 'interviewer' | 'candidate'
  text: string
  timestamp: string
}

export interface MemoryBudget {
  /** Trailing turns rendered into the prompt. */
  windowTurns: number
  /** Chars kept from a candidate answer before clipping. */
  answerClipChars: number
  /** Hard ceiling on the rendered lines, excluding the markers. */
  maxBlockChars: number
}

export const NORMAL_BUDGET: MemoryBudget = {
  windowTurns: 6,
  answerClipChars: 180,
  maxBlockChars: 1400
}
export const RECALL_BUDGET: MemoryBudget = {
  windowTurns: 10,
  answerClipChars: 420,
  maxBlockChars: 2600
}

/** Queries that explicitly reach back into the conversation earn a wider window. */
export const RECALL_CUE =
  /\b(earlier|previously|as you mentioned|we discussed|as i said|last question|before this|pehle|abhi bola)\b/i

export function clipAnswer(text: string, maxChars: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean.length <= maxChars) return clean

  const head = clean.slice(0, maxChars)
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? ')
  )
  if (sentenceEnd > maxChars * 0.15) return `${head.slice(0, sentenceEnd + 1)} …`

  const lastSpace = head.lastIndexOf(' ')
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trim()} …`
}

export function renderMemoryBlock(
  turns: TranscriptTurn[],
  query: string,
  budget: MemoryBudget = RECALL_CUE.test(query) ? RECALL_BUDGET : NORMAL_BUDGET
): string {
  if (turns.length === 0) return ''

  // The caller records the current question before rendering, and the main process
  // sends it again as the user message. Rendering it here would be a third copy.
  const prior = [...turns]
  const last = prior[prior.length - 1]
  if (last && last.speaker === 'interviewer' && last.text.trim() === query.trim()) prior.pop()
  if (prior.length === 0) return ''

  const lines = prior
    .slice(-budget.windowTurns)
    .map((turn) =>
      turn.speaker === 'interviewer'
        ? `[${turn.timestamp}] Interviewer: ${turn.text.trim()}`
        : `[${turn.timestamp}] Me: ${clipAnswer(turn.text, budget.answerClipChars)}`
    )

  while (lines.length > 1 && lines.join('\n').length > budget.maxBlockChars) lines.shift()

  return `\n=== LIVE INTERVIEW SESSION MEMORY (ROLLING TIMELINE) ===\n${lines.join('\n')}\n=== END SESSION MEMORY ===\n`
}

class LiveSessionMemory {
  private turns: TranscriptTurn[] = []
  // The render window is at most RECALL_BUDGET.windowTurns, so a larger store would
  // only hold memory the prompt can never use.
  private maxTurns = 24

  public recordTurn(speaker: TranscriptTurn['speaker'], text: string): void {
    if (!text || !text.trim()) return
    this.turns.push({
      speaker,
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    })
    while (this.turns.length > this.maxTurns) this.turns.shift()
  }

  public getSessionTimelinePrompt(query: string): string {
    return renderMemoryBlock(this.turns, query)
  }

  public clearMemory(): void {
    this.turns = []
  }
}

export const liveSessionMemory = new LiveSessionMemory()
