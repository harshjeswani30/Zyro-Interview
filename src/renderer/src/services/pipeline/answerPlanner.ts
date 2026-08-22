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
        scaffoldScored: true
      }

    case 'system_design':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 5,
        targetSeconds: 40,
        requiresExample: true,
        scaffoldScored: false
      }

    case 'definitional':
      return {
        voicePerspective: 'neutral_explanation',
        profileContextPolicy: 'forbidden',
        maxSentences: 3,
        targetSeconds: 20,
        requiresExample: true,
        scaffoldScored: false
      }

    case 'technical_concept':
      return {
        voicePerspective: 'neutral_explanation',
        profileContextPolicy: 'forbidden',
        maxSentences: 4,
        targetSeconds: 25,
        requiresExample: true,
        scaffoldScored: false
      }

    case 'identity':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 6,
        targetSeconds: 40,
        requiresExample: false,
        scaffoldScored: false
      }

    case 'behavioral':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 5,
        targetSeconds: 35,
        requiresExample: false,
        scaffoldScored: false
      }

    case 'project_deepdive':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'required',
        maxSentences: 5,
        targetSeconds: 35,
        requiresExample: true,
        scaffoldScored: false
      }

    case 'followup':
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 3,
        targetSeconds: 20,
        requiresExample: true,
        scaffoldScored: false
      }

    default:
      return {
        voicePerspective: 'first_person_candidate',
        profileContextPolicy: 'allowed',
        maxSentences: 4,
        targetSeconds: 25,
        requiresExample: false,
        scaffoldScored: false
      }
  }
}
