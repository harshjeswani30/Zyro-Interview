/// <reference types="vite/client" />

// Speech Recognition API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

declare let SpeechRecognition: {
  new (): SpeechRecognition
}
declare let webkitSpeechRecognition: {
  new (): SpeechRecognition
}
interface UserProfile {
  id: string
  email?: string
  sessions_balance?: number
  trial_seconds_limit?: number
  is_premium?: boolean
}
