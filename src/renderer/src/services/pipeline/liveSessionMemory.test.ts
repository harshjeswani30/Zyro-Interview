import { describe, it, expect } from 'vitest'
import {
  clipAnswer,
  renderMemoryBlock,
  NORMAL_BUDGET,
  type TranscriptTurn
} from './liveSessionMemory'

const t = (speaker: 'interviewer' | 'candidate', text: string): TranscriptTurn => ({
  speaker,
  text,
  timestamp: '10:00'
})

describe('clipAnswer', () => {
  it('returns short text unchanged', () => {
    expect(clipAnswer('Short answer.', 180)).toBe('Short answer.')
  })

  it('clips at a sentence boundary when one fits', () => {
    const out = clipAnswer('First point here. Second point that runs well past the cap.', 30)
    expect(out).toBe('First point here. …')
  })

  it('never exceeds the cap plus the ellipsis', () => {
    const out = clipAnswer('x'.repeat(500), 180)
    expect(out.length).toBeLessThanOrEqual(182)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('renderMemoryBlock', () => {
  it('returns empty string with no prior turns', () => {
    expect(renderMemoryBlock([], 'what is a closure')).toBe('')
  })

  it('drops the trailing interviewer turn that equals the current query', () => {
    expect(renderMemoryBlock([t('interviewer', 'what is a closure')], 'what is a closure')).toBe('')
  })

  it('keeps questions verbatim and clips the candidate answer', () => {
    const longAnswer = 'A closure captures its lexical scope. ' + 'filler '.repeat(80)
    const turns = [
      t('interviewer', 'what is a closure'),
      t('candidate', longAnswer),
      t('interviewer', 'and hoisting')
    ]
    const out = renderMemoryBlock(turns, 'and hoisting')
    expect(out).toContain('Interviewer: what is a closure')
    expect(out).toContain('A closure captures its lexical scope.')
    expect(out).not.toContain('filler filler filler filler')
    expect(out).toContain('=== END SESSION MEMORY ===')
  })

  it('caps the block and drops the oldest turns first', () => {
    const turns: TranscriptTurn[] = []
    for (let i = 0; i < 20; i++) {
      turns.push(t('interviewer', `question number ${i} about something`))
      turns.push(t('candidate', 'answer '.repeat(60)))
    }
    const out = renderMemoryBlock(turns, 'next question')
    expect(out.length).toBeLessThan(NORMAL_BUDGET.maxBlockChars + 200)
    expect(out).not.toContain('question number 0')
    expect(out).toContain('question number 19')
  })

  it('a recall query gets more history than a normal query', () => {
    const turns: TranscriptTurn[] = []
    for (let i = 0; i < 8; i++) {
      turns.push(t('interviewer', `question ${i}`))
      turns.push(t('candidate', `answer ${i} `.repeat(30)))
    }
    const normal = renderMemoryBlock(turns, 'what is a promise')
    const recall = renderMemoryBlock(turns, 'as you mentioned earlier, what was that')
    expect(recall.length).toBeGreaterThan(normal.length)
  })
})
