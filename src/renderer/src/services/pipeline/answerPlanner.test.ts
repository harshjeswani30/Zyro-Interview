import { describe, it, expect } from 'vitest'
import { planAnswer } from './answerPlanner'
import type { IntentResult } from './intentClassifier'

const ALL: IntentResult['intent'][] = [
  'definitional', 'technical_concept', 'dsa_coding', 'system_design',
  'behavioral', 'identity', 'project_deepdive', 'followup', 'general_factual'
]

const intent = (i: IntentResult['intent']): IntentResult => ({
  intent: i,
  isCoding: i === 'dsa_coding',
  isHindi: false,
  requiresExample: false
})

describe('planAnswer — completion budget', () => {
  it('a short definition asks for far less than the old flat 1600', () => {
    expect(planAnswer(intent('definitional')).maxTokens).toBe(450)
  })

  it('coding keeps the full ceiling', () => {
    expect(planAnswer(intent('dsa_coding')).maxTokens).toBe(1600)
  })

  it('every intent stays inside the gateway ceiling', () => {
    for (const i of ALL) {
      const { maxTokens } = planAnswer(intent(i))
      expect(maxTokens).toBeGreaterThanOrEqual(320)
      expect(maxTokens).toBeLessThanOrEqual(1600)
    }
  })

  it('budget scales with the bullet allowance', () => {
    expect(planAnswer(intent('system_design')).maxTokens).toBeGreaterThan(
      planAnswer(intent('definitional')).maxTokens
    )
  })
})
