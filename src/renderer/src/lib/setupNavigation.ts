export type StepId = 1 | 2 | 3 | 'knowledge_base' | 'ai_source'

export const STEP_ORDER: readonly StepId[] = [1, 2, 'knowledge_base', 'ai_source', 3] as const

export function stepIndex(id: StepId): number {
  return STEP_ORDER.indexOf(id)
}

export function isPastStep(current: StepId, id: StepId): boolean {
  return stepIndex(id) < stepIndex(current)
}

export function canClickStep(
  id: StepId,
  _current: StepId,
  hasNameAndRole: boolean,
  hasSelectedResume: boolean
): boolean {
  if (id === 1) return true
  if (id === 2 || id === 'knowledge_base' || id === 'ai_source') return hasNameAndRole
  if (id === 3) return hasSelectedResume
  return false
}

export function nextStepId(current: StepId): StepId | null {
  const i = stepIndex(current)
  return i >= 0 && i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1] : null
}

export function prevStepId(current: StepId): StepId | null {
  const i = stepIndex(current)
  return i > 0 ? STEP_ORDER[i - 1] : null
}
