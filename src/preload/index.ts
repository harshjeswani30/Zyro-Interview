import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { UserProfile } from './index.d'

const api = {
  // ── Supabase Auth ────────────────────────────────────────
  supabaseLogin: (
    email: string,
    password: string
  ): Promise<{ user: { id: string }; accessToken: string }> =>
    ipcRenderer.invoke('supabase-login', { email, password }),
  supabaseLoginGoogle: (): Promise<void> => ipcRenderer.invoke('supabase-login-google'),
  supabaseSendOtp: (phone: string): Promise<any> =>
    ipcRenderer.invoke('supabase-send-otp', { phone }),
  supabaseVerifyOtp: (
    phone: string,
    token: string
  ): Promise<{ user: { id: string }; accessToken: string }> =>
    ipcRenderer.invoke('supabase-verify-otp', { phone, token }),
  supabaseLogout: (): Promise<void> => ipcRenderer.invoke('supabase-logout'),
  supabaseGetProfile: (): Promise<UserProfile | null> => ipcRenderer.invoke('supabase-get-profile'),
  supabaseDeductSession: (): Promise<{ newBalance: number }> =>
    ipcRenderer.invoke('supabase-deduct-session'),
  supabaseDeductPhoneSession: (): Promise<{ newBalance: number }> =>
    ipcRenderer.invoke('supabase-deduct-phone-session'),
  supabaseCreateRazorpayOrder: (planId: string): Promise<any> =>
    ipcRenderer.invoke('supabase-create-razorpay-order', { planId }),
  supabaseUpdateTrial: (seconds: number): Promise<void> =>
    ipcRenderer.invoke('supabase-update-trial', seconds),
  supabaseLogSession: (
    durationSeconds: number,
    startedAt: string,
    sessionType: string
  ): Promise<void> =>
    ipcRenderer.invoke('supabase-log-session', { durationSeconds, startedAt, sessionType }),
  supabaseManualSync: (accessToken: string, refreshToken?: string, userId?: string): Promise<{ ok: boolean; userId: string | null }> =>
    ipcRenderer.invoke('supabase-manual-sync', { accessToken, refreshToken, userId }),
  // ── Setup window ─────────────────────────────────────────
  pickResume: (): Promise<{ path: string; data: string; name: string } | null> =>
    ipcRenderer.invoke('pick-resume'),
  parsePdf: (base64Data: string): Promise<string> => ipcRenderer.invoke('parse-pdf', base64Data),
  initGroq: (apiKey: string): void => ipcRenderer.send('init-groq', apiKey),
  transcribeAudio: (data: {
    base64Audio: string
    mimeType: string
    language: string
    model: string
    systemPrompt: string
    resumeText: string
  }): Promise<{ transcript: string; answer: string }> =>
    ipcRenderer.invoke('transcribe-audio', data),
  transcribeOnly: (data: {
    base64Audio: string
    mimeType: string
    language: string
    context?: string
  }): Promise<string> => ipcRenderer.invoke('transcribe-only', data),
  generateAnswer: (data: {
    transcript: string
    model: string
    systemPrompt: string
    temperature?: number
    maxTokens?: number
    presencePenalty?: number
    frequencyPenalty?: number
  }): Promise<string> => ipcRenderer.invoke('generate-answer', data),
  analyzeScreen: (data: { systemPrompt: string }): Promise<string> =>
    ipcRenderer.invoke('analyze-screen', data),
  captureScreenshot: (): Promise<string> => ipcRenderer.invoke('capture-screenshot'),
  queryVision: (data: { systemPrompt: string; base64Image: string }): Promise<string> =>
    ipcRenderer.invoke('query-vision', data),
  extractQuestionFromImage: (data: { base64Image: string }): Promise<string> =>
    ipcRenderer.invoke('extract-question-from-image', data),
  toggleCompact: (minimized: boolean): void => ipcRenderer.send('toggle-compact', minimized),
  startInterview: (sessionData: unknown): Promise<{ allowed: boolean; reason?: string }> =>
    ipcRenderer.invoke('start-interview', sessionData),
  quitApp: (): void => ipcRenderer.send('quit-app'),
  reloadWindow: (): void => ipcRenderer.send('reload-window'),
  minimizeWindow: (): void => ipcRenderer.send('minimize-window'),
  closeWindow: (): void => ipcRenderer.send('close-window'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('install-update'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('download-update'),
  // ── Overlay window ────────────────────────────────────────
  getSession: (): Promise<unknown> => ipcRenderer.invoke('get-session'),
  getDeepgramKey: (): Promise<string> => ipcRenderer.invoke('get-deepgram-key'),
  getSupabaseToken: (): Promise<string | null> => ipcRenderer.invoke('get-supabase-token'),
  getSupabaseSessionData: (): Promise<{ accessToken: string | null; refreshToken: string | null }> => ipcRenderer.invoke('get-supabase-session-data'),
  // ── Knowledge Base (via main process — always uses valid user token) ───
  kbList: (): Promise<{ data: { id: string; title: string; created_at: string }[] | null; error: string | null }> =>
    ipcRenderer.invoke('kb-list'),
  kbSave: (args: { title: string; content: string }): Promise<{ data: { id: string; title: string; created_at: string } | null; error: string | null }> =>
    ipcRenderer.invoke('kb-save', args),
  kbDelete: (kbId: string): Promise<{ error: string | null }> =>
    ipcRenderer.invoke('kb-delete', kbId),
  indexLocalContent: (source: string, content: string): Promise<number> =>
    ipcRenderer.invoke('index-local-content', { source, content }),
  searchLocalVectorDb: (query: string, topK?: number): Promise<string[]> =>
    ipcRenderer.invoke('search-local-vector-db', { query, topK }),
  getScreenSize: (): Promise<{ width: number; height: number }> =>
    ipcRenderer.invoke('get-screen-size'),
  getDesktopSources: (): Promise<unknown[]> => ipcRenderer.invoke('get-desktop-sources'),
  endInterview: (): void => ipcRenderer.send('end-interview'),
  setOverlayPosition: (x: number, y: number): void =>
    ipcRenderer.send('set-overlay-position', { x, y }),
  setPosition: (x: number, y: number): void => ipcRenderer.send('set-position', x, y),
  setBounds: (bounds: { x: number; y: number; width: number; height: number }): void =>
    ipcRenderer.send('set-bounds', bounds),
  getBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('get-bounds'),
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }): void =>
    ipcRenderer.send('set-ignore-mouse', ignore, options),
  setZoom: (level: number) => ipcRenderer.send('set-zoom', level),
  setOverlaySize: (width: number, height: number) =>
    ipcRenderer.send('set-overlay-size', { width, height }),
  toggleScreenProtection: (enabled?: boolean) =>
    ipcRenderer.send('toggle-screen-protection', enabled),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  resizeMainWindow: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('resize-main-window', { width, height }),

  // Status events
  onSttReady: (cb: (data: { transcript: string; isFinal: boolean }) => void): void => {
    ipcRenderer.on('stt-ready', (_e, data) => cb(data))
  },
  onSttError: (cb: (data: { message: string }) => void): void => {
    ipcRenderer.on('stt-error', (_e, data) => cb(data))
  },
  onInterviewEnd: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('interview-ended', listener)
    return (): void => {
      ipcRenderer.removeListener('interview-ended', listener)
    }
  },
  onScrollOverlay: (cb: (direction: 'up' | 'down') => void): (() => void) => {
    const listener = (_e: unknown, dir: 'up' | 'down'): void => cb(dir)
    ipcRenderer.on('scroll-overlay', listener)
    return (): void => {
      ipcRenderer.removeListener('scroll-overlay', listener)
    }
  },
  onToggleListening: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('toggle-listening', listener)
    return (): void => {
      ipcRenderer.removeListener('toggle-listening', listener)
    }
  },
  onSetAutoAnswer: (cb: (enabled: boolean) => void): (() => void) => {
    const listener = (_e: unknown, enabled: boolean): void => cb(enabled)
    ipcRenderer.on('set-auto-answer', listener)
    return (): void => {
      ipcRenderer.removeListener('set-auto-answer', listener)
    }
  },
  onTriggerScreenScan: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('trigger-screen-scan', listener)
    return (): void => {
      ipcRenderer.removeListener('trigger-screen-scan', listener)
    }
  },
  onInitSession: (cb: (data: unknown) => void): (() => void) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('init-session', listener)
    return (): void => {
      ipcRenderer.removeListener('init-session', listener)
    }
  },
  onSessionExpired: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('session-expired', listener)
    return (): void => {
      ipcRenderer.removeListener('session-expired', listener)
    }
  },
  // Auto-updater status events
  onUpdateAvailable: (cb: (info: unknown) => void): (() => void) => {
    const listener = (_e: unknown, info: unknown): void => cb(info)
    ipcRenderer.on('update-available', listener)
    return (): void => {
      ipcRenderer.removeListener('update-available', listener)
    }
  },
  onUpdateProgress: (cb: (progress: unknown) => void): (() => void) => {
    const listener = (_e: unknown, progress: unknown): void => cb(progress)
    ipcRenderer.on('update-progress', listener)
    return (): void => {
      ipcRenderer.removeListener('update-progress', listener)
    }
  },
  onUpdateReady: (cb: (info: unknown) => void): (() => void) => {
    const listener = (_e: unknown, info: unknown): void => cb(info)
    ipcRenderer.on('update-ready', listener)
    return (): void => {
      ipcRenderer.removeListener('update-ready', listener)
    }
  },
  onUpdateError: (cb: (error: string) => void): (() => void) => {
    const listener = (_e: unknown, error: string) => cb(error)
    ipcRenderer.on('update-error', listener)
    return () => {
      ipcRenderer.removeListener('update-error', listener)
    }
  },
  onAuthCallbackSuccess: (
    cb: (data: { accessToken: string; refreshToken?: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, data: { accessToken: string; refreshToken?: string }): void =>
      cb(data)
    ipcRenderer.on('auth-callback-success', listener)
    return (): void => {
      ipcRenderer.removeListener('auth-callback-success', listener)
    }
  },
  onOverlayToggle: (cb: (visible: boolean) => void): (() => void) => {
    const listener = (_e: unknown, visible: boolean): void => cb(visible)
    ipcRenderer.on('overlay-toggled', listener)
    return (): void => {
      ipcRenderer.removeListener('overlay-toggled', listener)
    }
  },
  onScreenProtectionToggle: (cb: (enabled: boolean) => void): (() => void) => {
    const listener = (_e: unknown, enabled: boolean): void => cb(enabled)
    ipcRenderer.on('screen-protection-toggled', listener)
    return (): void => {
      ipcRenderer.removeListener('screen-protection-toggled', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore: electronAPI is provided by @electron-toolkit/preload but might not be in the lib types
  window.electron = electronAPI
  // @ts-ignore: api is our custom bridge object
  window.api = api
}
