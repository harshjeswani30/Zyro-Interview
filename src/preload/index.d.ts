import { ElectronAPI } from '@electron-toolkit/preload'

export interface UserProfile {
  id: string
  email?: string
  full_name?: string
  sessions_balance?: number
  trial_seconds_used?: number
  is_premium?: boolean
}

interface SessionData {
  name: string
  role: string
  company: string
  language: string
  resumeText: string
  groqApiKey: string
  autoAnswer: boolean
  experienceLevel: 'fresher' | 'experienced'
  experienceDuration?: string
  workHistory?: string
  sessions_balance?: number
  trial_seconds_used?: number
  isPremium?: boolean
  codingLanguage?: string
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
    context?: string
  }) => Promise<string>
  generateAnswer: (data: {
    transcript: string
    model: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
    presencePenalty?: number
    frequencyPenalty?: number
  }) => Promise<string>
  analyzeScreen: (data: { systemPrompt: string; model?: string }) => Promise<string>
  toggleCompact: (minimized: boolean) => void
  startInterview: (sessionData: SessionData) => Promise<{ allowed: boolean; reason?: string }>
  quitApp: () => void
  closeWindow: () => void
  reloadWindow: () => void
  getSession: () => Promise<SessionData | null>
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
  openExternal: (url: string) => void
  // Supabase auth + profile
  supabaseLogin: (
    email: string,
    password: string
  ) => Promise<{ user: { id: string }; accessToken: string }>
  supabaseLoginGoogle: () => Promise<void>
  supabaseLogout: () => Promise<void>
  supabaseGetProfile: () => Promise<UserProfile | null>
  supabaseDeductSession: () => Promise<{ newBalance: number }>
  supabaseUpdateTrial: (seconds: number) => Promise<void>
  supabaseLogSession: (durationSeconds: number, startedAt: string, sessionType: string) => Promise<void>
  supabaseManualSync: (accessToken: string, userId?: string) => void
  onSttReady: (cb: (data: { transcript: string; isFinal: boolean }) => void) => void
  onSttError: (cb: (data: { message: string }) => void) => void
  onInterviewEnd: (cb: () => void) => () => void
  onScrollOverlay: (cb: (direction: 'up' | 'down') => void) => () => void
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
