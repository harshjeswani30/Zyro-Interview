/**
 * VAD status is a capture hint, not an answer-pipeline status. Once final STT or
 * generation owns the turn, late audio callbacks must not overwrite Transcribing,
 * Thinking, or Writing with Waiting.
 */
export function shouldApplyVadStatus(
  autoMode: boolean,
  isFinalizing: boolean,
  isGenerating: boolean
): boolean {
  return autoMode && !isFinalizing && !isGenerating
}
