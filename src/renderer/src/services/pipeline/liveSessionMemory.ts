// liveSessionMemory.ts - Natively-style Long-Range Transcript & Session Memory

export interface TranscriptTurn {
  id: string
  speaker: 'interviewer' | 'candidate'
  text: string
  timestamp: string
}

class LiveSessionMemory {
  private turns: TranscriptTurn[] = []
  private maxTurns: number = 50

  public recordTurn(speaker: 'interviewer' | 'candidate', text: string): void {
    if (!text || !text.trim()) return

    const turn: TranscriptTurn = {
      id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      speaker,
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    this.turns.push(turn)
    if (this.turns.length > this.maxTurns) {
      this.turns.shift()
    }
  }

  public getSessionTimelinePrompt(query: string): string {
    if (this.turns.length === 0) return ''

    const isFollowupOrRecall = /\b(earlier|previously|as you mentioned|we discussed|as i said|last question|before this)\b/i.test(query)

    // Include recent timeline if it's a follow up or recall question
    if (isFollowupOrRecall || this.turns.length >= 2) {
      const recentTimeline = this.turns
        .slice(-8)
        .map((t) => `[${t.timestamp}] ${t.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
        .join('\n')

      return `\n=== LIVE INTERVIEW SESSION MEMORY (ROLLING TIMELINE) ===\n${recentTimeline}\n=== END SESSION MEMORY ===\n`
    }

    return ''
  }

  public clearMemory(): void {
    this.turns = []
  }
}

export const liveSessionMemory = new LiveSessionMemory()
