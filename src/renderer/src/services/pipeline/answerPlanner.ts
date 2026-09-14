// answerPlanner.ts - Natively-style Answer Planning & Execution Policy Engine

// Single source of truth for the intent union lives in intentClassifier. Re-exported
// here so existing importers of `IntentResult` from this module keep working.
import type { IntentResult } from './intentClassifier'
export type { IntentResult }

export type VoicePerspective = 'first_person_candidate' | 'neutral_explanation'
export type ProfileContextPolicy = 'required' | 'allowed' | 'forbidden'

export interface AnswerPlan {
  voicePerspective: VoicePerspective
  profileContextPolicy: ProfileContextPolicy
  maxSentences: number
  targetSeconds: number
  requiresExample: boolean
  scaffoldScored: boolean
  /** Bullet budget for the answer. Every answer is rendered as a point list. */
  bulletsMin: number
  bulletsMax: number
  /**
   * Completion-token ceiling for this intent. Gateway fallback default is 1024
   * when maxTokens is not provided by the caller.
   *
   * Budgets were raised in Sept 2026 to accommodate the PRECISION & DEPTH and
   * EXPERT COMPLETENESS rules, which require reasoning chains and adjacent expert
   * concepts — both of which consume more tokens than a plain factual sentence.
   */
  maxTokens: number
}

export function planAnswer(intentResult: IntentResult): AnswerPlan {
  switch (intentResult.intent) {
    case 'dsa_coding':
      return {
        voicePerspective: 'neutral_explanation',
        profileContextPolicy: 'forbidden',
        maxSentences: 3,
        targetSeconds: 45,
        requiresExample: false,
        scaffoldScored: true,
        bulletsMin: 3,
        bulletsMax: 4,
        maxTokens: 1600  // code block needs the full room
      }

    case 'system_design':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 5,
        targetSeconds: 40,
        requiresExample: true,
        scaffoldScored: false,
        bulletsMin: 5,
        bulletsMax: 7,
        maxTokens: 1000  // mermaid diagram + 7 depth bullets
      }

    case 'definitional':
      return {
        voicePerspective: 'neutral_explanation',
        profileContextPolicy: 'forbidden',
        maxSentences: 3,
        targetSeconds: 20,
        requiresExample: true,
        scaffoldScored: false,
        bulletsMin: 4,
        bulletsMax: 6,
        maxTokens: 650  // raised from 450: precision rules + expert completeness need room
      }

    case 'technical_concept':
      return {
        voicePerspective: 'neutral_explanation',
        profileContextPolicy: 'forbidden',
        maxSentences: 4,
        targetSeconds: 25,
        requiresExample: true,
        scaffoldScored: false,
        bulletsMin: 5,
        bulletsMax: 7,
        maxTokens: 850  // raised from 650: when/why comparisons + adjacent expert concepts
      }

    case 'identity':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 6,
        targetSeconds: 40,
        requiresExample: false,
        scaffoldScored: false,
        bulletsMin: 5,
        bulletsMax: 7,
        maxTokens: 800  // raised from 700: resume grounding requires more tokens
      }

    case 'behavioral':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 5,
        targetSeconds: 35,
        requiresExample: false,
        scaffoldScored: false,
        bulletsMin: 5,
        bulletsMax: 6,
        maxTokens: 800  // raised from 700: reasoning chain (WHY) + measurable outcome bullets
      }

    case 'project_deepdive':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 5,
        targetSeconds: 35,
        requiresExample: true,
        scaffoldScored: false,
        bulletsMin: 5,
        bulletsMax: 6,
        maxTokens: 800  // raised from 700: reasoning chain + specific tech choice justification
      }

    case 'followup':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 3,
        targetSeconds: 20,
        requiresExample: true,
        scaffoldScored: false,
        bulletsMin: 3,
        bulletsMax: 5,
        maxTokens: 550  // raised from 450: followup can trigger expert completeness
      }

    default:
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 4,
        targetSeconds: 25,
        requiresExample: false,
        scaffoldScored: false,
        bulletsMin: 4,
        bulletsMax: 6,
        maxTokens: 700  // raised from 600: default covers annotation/review/general questions
      }
  }
}
