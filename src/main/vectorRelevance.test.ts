import { describe, it, expect } from 'vitest'
import { selectRelevantChunks } from './vectorRelevance'

describe('selectRelevantChunks', () => {
  it('returns nothing when the best match is below the absolute floor', () => {
    expect(selectRelevantChunks([{ text: 'noise', score: 0.05 }], 3)).toEqual([])
  })

  it('drops chunks far weaker than the best match', () => {
    const out = selectRelevantChunks(
      [
        { text: 'strong', score: 1.2 },
        { text: 'ok', score: 0.7 },
        { text: 'noise', score: 0.1 }
      ],
      3
    )
    expect(out).toEqual(['strong', 'ok'])
  })

  it('respects topK', () => {
    const out = selectRelevantChunks(
      [
        { text: 'a', score: 1 },
        { text: 'b', score: 0.9 },
        { text: 'c', score: 0.85 }
      ],
      2
    )
    expect(out).toEqual(['a', 'b'])
  })

  it('ranks regardless of input order', () => {
    const out = selectRelevantChunks(
      [
        { text: 'weak', score: 0.5 },
        { text: 'best', score: 1.0 }
      ],
      3
    )
    expect(out[0]).toBe('best')
  })

  it('caps the total characters injected', () => {
    const big = 'x'.repeat(800)
    const out = selectRelevantChunks([{ text: big, score: 1 }, { text: big, score: 0.9 }], 3)
    expect(out.join('').length).toBeLessThanOrEqual(1200)
  })

  it('clips a single oversized chunk instead of dropping it', () => {
    const out = selectRelevantChunks([{ text: 'y'.repeat(5000), score: 1 }], 3)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeLessThanOrEqual(1200)
  })
})
