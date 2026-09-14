export interface ScoredChunk {
  text: string
  score: number
}

/** Absolute floor. Below this the best match is noise and nothing is injected. */
export const RELEVANCE_FLOOR = 0.08
/** A chunk must score at least this fraction of the best match to travel with it. */
export const RELATIVE_FLOOR_RATIO = 0.45
/** Ceiling on retrieved text injected into one prompt. */
export const MAX_CONTEXT_CHARS = 1200

export function selectRelevantChunks(
  scored: ScoredChunk[],
  topK: number,
  opts: { floor?: number; ratio?: number; maxChars?: number } = {}
): string[] {
  const floor = opts.floor ?? RELEVANCE_FLOOR
  const ratio = opts.ratio ?? RELATIVE_FLOOR_RATIO
  const maxChars = opts.maxChars ?? MAX_CONTEXT_CHARS

  if (scored.length === 0) return []

  const ranked = [...scored].sort((a, b) => b.score - a.score)
  const best = ranked[0].score
  if (best < floor) return []

  // Relative cutoff: hash-embedding scores aren't calibrated, so "much worse than
  // the best hit" is a far better signal than any fixed number.
  const cutoff = Math.max(floor, best * ratio)
  const kept: string[] = []
  let used = 0

  for (const chunk of ranked.slice(0, topK)) {
    if (chunk.score < cutoff) break
    const remaining = maxChars - used
    if (remaining <= 0) break
    const text = chunk.text.length > remaining ? chunk.text.slice(0, remaining) : chunk.text
    kept.push(text)
    used += text.length
  }

  return kept
}
