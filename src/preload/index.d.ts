import { ElectronAPI } from '@electron-toolkit/preload'

export interface UserProfile {
  id: string
  email?: string
  full_name?: string
  sessions_balance?: number
  phone_sessions_balance?: number
  trial_seconds_used?: number
  is_premium?: boolean
}

export interface AnswerChunk {
  requestId: string
  /**
   * The whole visible answer so far, already stripped of chain-of-thought.
   * Deliberately not a `delta`: stripThinkBlocks can *shrink* the text when an
   * unterminated <think> arrives, so an incremental field would be wrong and a
   * renderer that concatenated it would render reasoning. Always replace, never append.
   */
  full?: string
  done: boolean
  error?: string
}

interface SessionData {
  name: string
  role: string
  company: string
  language: string
  resumeText: string
  groqApiKey?: string
  autoAnswer: boolean
  experienceLevel: 'fresher' | 'experienced'
  experienceDuration?: string
  workHistory?: string
  sessions_balance?: number
  trial_seconds_used?: number
  isPremium?: boolean
  codingLanguage?: string
  /** 1–2 answer languages the copilot replies in; any other spoken language falls back to English. */
  responseLanguages?: string[]
  apiType?: 'normal' | 'gemini_live'
  geminiApiKey?: string
  interviewContent?: string
  activeKbId?: string
  sessionStartedFromSchedule?: boolean
  hasHold?: boolean
}

interface Api {
  pickResume: () => Promise<{ path: string; data: string; name: string } | null>
  parsePdf: (base64Data: string) => Promise<string>
  initGroq: (apiKey: string) => void
  transcribeAudio: (data: {
    base64Audio: string
    mimeType: string
    language: string
    model: string
    systemPrompt: string
    resumeText: string
  }) => Promise<{ transcript: string; answer: string }>
  transcribeOnly: (data: {
    base64Audio: string
    mimeType: string
    language: string
    isPartial?: boolean
  }) => Promise<{ text: string; language?: string }>
  generateAnswer: (data: {
    transcript: string
    model: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
    presencePenalty?: number
    frequencyPenalty?: number
  }) => Promise<string>
  generateAnswerStream?: (data: {
    requestId: string
    transcript: string
    model?: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
    presencePenalty?: number
    frequencyPenalty?: number
  }) => Promise<string>
  onAnswerChunk?: (cb: (payload: AnswerChunk) => void) => () => void
  analyzeScreen: (data: { systemPrompt: string; model?: string }) => Promise<string>
  writeClipboard: (text: string) => Promise<void>
  captureScreenshot: () => Promise<string>
  queryVision: (data: { systemPrompt: string; base64Image: string }) => Promise<string>
  /** Optional so the renderer can capability-check before using the streaming path. */
  analyzeScreenStream?: (data: {
    requestId: string
    systemPrompt: string
    base64Image: string
    userPrompt?: string
    maxTokens?: number
  }) => Promise<string>
  extractQuestionFromImage: (data: { base64Image: string }) => Promise<string>
  toggleCompact: (minimized: boolean) => void
  startInterview: (sessionData: SessionData) => Promise<{ allowed: boolean; reason?: string }>
  prewarmGatewayToken?: () => Promise<{ ok: boolean }>
  getGatewayToken: () => Promise<string | null>
  quitApp: () => void
  minimizeWindow: () => void
  closeWindow: () => void
  reloadWindow: () => void
  getSession: () => Promise<SessionData | null>
  getAiGatewayUrl: () => Promise<string>
  getDeepgramKey: () => Promise<string>
  getSupabaseToken: () => Promise<string | null>
  getSupabaseSessionData: () => Promise<{ accessToken: string | null; refreshToken: string | null }>
  getScreenSize: () => Promise<{ width: number; height: number }>
  getDesktopSources: () => Promise<any[]>
  endInterview: () => void
  installUpdate: () => Promise<void>
  downloadUpdate: () => Promise<void>
  setOverlayPosition: (x: number, y: number) => void
  setPosition: (x: number, y: number) => void
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
  getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
  setZoom: (level: number) => void
  setOverlaySize: (width: number, height: number) => void
  toggleScreenProtection: (enabled?: boolean) => void
  openExternal: (url: string) => void
  resizeMainWindow: (width: number, height: number) => Promise<void>
  // Supabase auth + profile
  supabaseLogin: (
    email: string,
    password: string
  ) => Promise<{ user: { id: string }; accessToken: string }>
  supabaseLoginGoogle: () => Promise<void>
  supabaseSendOtp: (phone: string) => Promise<any>
  supabaseVerifyOtp: (phone: string, token: string) => Promise<{ user: { id: string }; accessToken: string }>
  supabaseLogout: () => Promise<void>
  supabaseGetProfile: () => Promise<UserProfile | null>
  supabaseDeductSession: () => Promise<{ newBalance: number }>
  supabaseDeductPhoneSession: () => Promise<{ newBalance: number }>
  supabaseHoldCredit: () => Promise<{ ok: boolean; reason?: string; effective_balance?: number; held_credits?: number }>
  supabaseReleaseHold: () => Promise<void>
  supabaseDeductCreditHours: (data: { durationSeconds: number; releaseHold?: boolean }) => Promise<{ newBalance: number; creditsDeducted: number; creditsUsedTotal?: number }>
  supabaseCreateRazorpayOrder: (planId: string) => Promise<any>
  supabaseUpdateTrial: (seconds: number) => Promise<void>
  supabaseLogSession: (durationSeconds: number, startedAt: string, sessionType: string) => Promise<void>
  supabaseSaveTranscript: (payload: {
    startedAt: string
    endedAt: string
    durationSeconds: number
    sessionType: string
    sessionId?: string
    qa: { id: string; question: string; answer: string; timestamp: string }[]
  }) => Promise<{ ok: boolean; transcriptId?: string }>
  endInterviewAndExit: (payload: {
    elapsed: number
    startedAt: string
    sessionType: string
    premium: boolean
    releaseHold?: boolean
    qa: { id: string; question: string; answer: string; timestamp: string }[]
  }) => void
  supabaseManualSync: (accessToken: string, refreshToken?: string, userId?: string) => Promise<{ ok: boolean; userId: string | null }>
  // Knowledge Base via main process IPC
  kbList: () => Promise<{ data: { id: string; title: string; created_at: string }[] | null; error: string | null }>
  kbSave: (args: { title: string; content: string }) => Promise<{ data: { id: string; title: string; created_at: string } | null; error: string | null }>
  kbDelete: (kbId: string) => Promise<{ error: string | null }>
  indexLocalContent: (source: string, content: string) => Promise<number>
  searchLocalVectorDb: (query: string, topK?: number) => Promise<string[]>
  getSupabaseSessionData: () => Promise<{ accessToken: string | null; refreshToken: string | null }>

  onSttReady: (cb: (data: { transcript: string; isFinal: boolean }) => void) => void
  onSttError: (cb: (data: { message: string }) => void) => void
  onInterviewEnd: (cb: () => void) => () => void
  onScrollOverlay: (cb: (direction: 'up' | 'down') => void) => () => void
  onHistoryNav: (cb: (direction: 'prev' | 'next') => void) => () => void
  onToggleListening: (cb: () => void) => () => void
  onSetAutoAnswer: (cb: (enabled: boolean) => void) => () => void
  onTriggerScreenScan: (cb: () => void) => () => void
  onInitSession: (cb: (data: SessionData) => void) => () => void
  onUpdateAvailable: (cb: (info: any) => void) => () => void
  onUpdateProgress: (cb: (progress: any) => void) => () => void
  onUpdateReady: (cb: (info: any) => void) => () => void
  onUpdateError: (cb: (error: string) => void) => () => void
  onAuthCallbackSuccess: (
    cb: (data: { accessToken: string; refreshToken?: string }) => void
  ) => () => void
  onOverlayToggle: (cb: (visible: boolean) => void) => () => void
  onScreenProtectionToggle: (cb: (enabled: boolean) => void) => () => void
  onSessionExpired: (cb: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
