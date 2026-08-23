// answerPlanner.ts - Natively-style Answer Planning & Execution Policy Engine

export interface IntentResult {
  intent: 'definitional' | 'technical_concept' | 'dsa_coding' | 'system_design' | 'behavioral' | 'identity' | 'project_deepdive' | 'followup' | 'general_factual'
  isCoding: boolean
  isHindi: boolean
  requiresExample: boolean
}

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
        bulletsMax: 4
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
        bulletsMax: 7
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
        bulletsMax: 5
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
        bulletsMax: 7
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
        bulletsMax: 7
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
        bulletsMax: 6
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
        bulletsMax: 6
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
        bulletsMax: 4
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
        bulletsMax: 6
      }
  }
}
