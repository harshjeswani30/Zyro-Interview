process.env.UV_THREADPOOL_SIZE = '16'

import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  desktopCapturer,
  session,
  globalShortcut,
  powerSaveBlocker
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { readFileSync } from 'fs'
// OpenAI and other SDKs removed — all AI calls now route via AI_GATEWAY fetch
// pdf-parse is a CommonJS module with no official types
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { PDFParse } = require('pdf-parse')
import { loadSecureSession, storeSecureSession, clearSecureSession } from './secureStorage'
import icon from '../../resources/icon.png?asset'
import { autoUpdater } from 'electron-updater'
import { localVectorDb } from './localVectorDb'

// ── Native Windows Stealth Engine (Ghostly Algorithm via Koffi FFI) ──
const WDA_MONITOR = 1
const WDA_EXCLUDEFROMCAPTURE = 17

let cachedSetWindowDisplayAffinity: ((hwnd: number, affinity: number) => number) | null = null
let koffiAvailable: boolean | null = null

function getSetWindowDisplayAffinity(): ((hwnd: number, affinity: number) => number) | null {
  if (koffiAvailable === false) return null
  if (cachedSetWindowDisplayAffinity) return cachedSetWindowDisplayAffinity
  try {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    cachedSetWindowDisplayAffinity = user32.func(
      'int __stdcall SetWindowDisplayAffinity(intptr hwnd, uint32 dwAffinity)'
    )
    koffiAvailable = true
    return cachedSetWindowDisplayAffinity
  } catch (err) {
    console.warn('[Zyro Stealth Engine] koffi not available:', err)
    koffiAvailable = false
    return null
  }
}

function readHWND(hwndBuffer: Buffer): number {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return Number(hwndBuffer.readBigUInt64LE(0))
  }
  return hwndBuffer.readUInt32LE(0)
}

const appliedHWnds = new Set<number>()

function nudgeRepaint(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return
    const opacity = win.getOpacity()
    win.setOpacity(Math.max(0, opacity - 0.001))
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.setOpacity(opacity)
      } catch {
        /* ignore */
      }
    }, 30)
  } catch {
    /* ignore */
  }
}

function setStealthProtection(win: BrowserWindow, enable: boolean): void {
  win.setContentProtection(enable)
  if (process.platform !== 'win32') return

  const SetWindowDisplayAffinity = getSetWindowDisplayAffinity()
  if (!SetWindowDisplayAffinity) return

  try {
    const hwndBuffer = win.getNativeWindowHandle()
    const hwnd = readHWND(hwndBuffer)

    if (enable) {
      // Priority 1: WDA_EXCLUDEFROMCAPTURE (17) — Zero capture by Zoom/Teams/Meet/OBS/Proctoring
      let success = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
      if (success) {
        appliedHWnds.add(hwnd)
        console.log('[Zyro Stealth Engine] ✅ WDA_EXCLUDEFROMCAPTURE (17) applied')
        setTimeout(() => nudgeRepaint(win), 50)
        return
      }

      // Priority 2: Fallback WDA_MONITOR (1) for older Windows builds
      success = SetWindowDisplayAffinity(hwnd, WDA_MONITOR)
      if (success) {
        appliedHWnds.add(hwnd)
        console.log('[Zyro Stealth Engine] ⚠️ WDA_MONITOR (1) applied')
        setTimeout(() => nudgeRepaint(win), 50)
        return
      }
    } else {
      // WDA_NONE (0) — Allow window capture
      SetWindowDisplayAffinity(hwnd, 0)
      appliedHWnds.delete(hwnd)
      console.log('[Zyro Stealth Engine] 🔓 Screen share protection DISABLED')
      setTimeout(() => nudgeRepaint(win), 50)
    }
  } catch (err) {
    console.warn('[Zyro Stealth Engine] FFI call error:', err)
  }
}

function applyStealthMode(win: BrowserWindow): void {
  setStealthProtection(win, true)
}

// CRITICAL: Ensure we use the proper app data folder even if productName is changed to "Host Process for Windows Tasks"
app.setPath('userData', join(app.getPath('appData'), 'Zyro-Ai'))

// Register safe protocol for deep linking
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('zyroapp', process.execPath, [join(__dirname, '../../')])
  }
} else {
  app.setAsDefaultProtocolClient('zyroapp')
}

autoUpdater.logger = console
autoUpdater.autoDownload = false  // Only download when user explicitly clicks — no surprise downloads
autoUpdater.allowPrerelease = false
autoUpdater.channel = 'latest'

// Custom fetch helper with a timeout using AbortController
async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number }): Promise<Response> {
  const { timeout = 15000, ...fetchOptions } = options
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    })
  } finally {
    clearTimeout(id)
  }
}

// Retry helper — retries up to `attempts` times with exponential back-off
// Works whether VPN is on or off: uses whatever network route the system provides.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 800): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn()
      // If result is a Response object, check status
      if (result && typeof (result as any).status === 'number') {
        const res = result as any as Response
        if (!res.ok) {
          const errText = await res.text().catch(() => 'No body')
          console.error(`[AI-Gateway] HTTP ${res.status}: ${errText.substring(0, 200)}`)
          
          // If we hit 429 or 401, wait and retry. Gateway handles its own internal rotation.
          if (res.status === 429 || res.status === 401) {
            throw { status: res.status, message: `Auth/rate-limit error ${res.status}`, body: errText }
          }
          throw { status: res.status, message: `HTTP Error ${res.status}`, body: errText }
        }
      }
      return result
    } catch (err: unknown) {
      lastErr = err
      const error = err as any
      const isNetwork =
        error?.code === 'ECONNRESET' ||
        error?.code === 'ENOTFOUND' ||
        error?.code === 'ETIMEDOUT' ||
        error?.status === 429 ||
        error?.status >= 500 ||
        error?.message?.includes('fetch failed') ||
        error?.message?.includes('network') ||
        error?.name === 'AbortError' ||
        error?.message?.includes('aborted')

      if (!isNetwork || i === attempts - 1) throw err
      const delay = baseDelayMs * Math.pow(2, i)
      console.warn(
        `[AI-Gateway] Attempt ${i + 1} failed (${error.status ?? error.code ?? 'timeout/abort'}), retrying in ${delay} ms…`
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// AI Gateway — all AI calls route here instead of directly to Groq
const AI_GATEWAY = 'https://ai-gateway.harshjeswani30.workers.dev'

// ─────────────────────────────────────────────
// Module-level Supabase constants & session state
// (shared between handleProtocolUrl and setupIPC)
// ─────────────────────────────────────────────
const SUPABASE_URL = 'https://weqwxoihdfsvjwwcgtat.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlcXd4b2loZGZzdmp3d2NndGF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzI5NDksImV4cCI6MjA4ODU0ODk0OX0.93-tT4Uqo2E2EniSa33ZGtNwGzitkIn3P7nfg3sz14c'
// NOTE: service_role key removed — all privileged operations use Edge Functions

let supabaseAccessToken: string | null = null
let supabaseUserId: string | null = null
let supabaseRefreshToken: string | null = null

function isTokenExpired(token: string | null): boolean {
  if (!token) return true
  try {
    const parts = token.split('.')
    if (parts.length < 2) return true
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (base64.length % 4) {
      base64 += '='
    }
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    if (typeof payload.exp !== 'number') return true
    const currentTime = Math.floor(Date.now() / 1000)
    return payload.exp <= currentTime + 60
  } catch {
    return true
  }
}

let refreshPromise: Promise<boolean> | null = null
// Guard: once a refresh token is permanently rejected, stop retrying until user logs in again
let sessionPermanentlyDead = false

// Unrecoverable error codes from Supabase auth
const UNRECOVERABLE_REFRESH_ERRORS = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'invalid_refresh_token',
  'user_not_found',
  'user_banned',
  'session_not_found',
])

function forceLogout(reason: string): void {
  console.warn(`[Supabase] Forcing logout: ${reason}`)
  supabaseAccessToken = null
  supabaseRefreshToken = null
  supabaseUserId = null
  sessionPermanentlyDead = true
  clearSecureSession()
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('session-expired')
  })
}

async function refreshSupabaseSession(): Promise<boolean> {
  // Never retry if session is already dead
  if (sessionPermanentlyDead) {
    console.warn('[Supabase] Session is permanently dead, skipping refresh')
    return false
  }

  if (refreshPromise) {
    return refreshPromise
  }

  refreshPromise = (async () => {
    if (!supabaseRefreshToken) {
      console.warn('[Supabase] No refresh token available to refresh session')
      return false
    }
    console.log('[Supabase] Refreshing session token...')
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ refresh_token: supabaseRefreshToken })
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        console.error('[Supabase] Token refresh failed:', errData)

        // If the error is unrecoverable, force logout immediately (no access token check)
        if (UNRECOVERABLE_REFRESH_ERRORS.has(errData?.error_code)) {
          forceLogout(`Unrecoverable refresh error: ${errData?.error_code}`)
        } else if (errData?.status === 400 || errData?.status === 401) {
          // Generic 400/401 from Supabase auth is also unrecoverable for the refresh
          console.warn('[Supabase] Refresh rejected with non-retryable status, clearing refresh token')
          supabaseRefreshToken = null
          // Don't force full logout — access token might still be valid for a bit
        }
        return false
      }
      const data = await res.json()
      supabaseAccessToken = data.access_token
      supabaseRefreshToken = data.refresh_token
      supabaseUserId = data.user?.id
      sessionPermanentlyDead = false // reset on successful refresh
      storeSecureSession({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user?.id
      })
      console.log('[Supabase] Session token refreshed successfully')
      return true
    } catch (err) {
      console.error('[Supabase] Failed to refresh session:', err)
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

async function ensureFreshSupabaseToken(): Promise<string | null> {
  // If session is dead, return null immediately — no network call
  if (sessionPermanentlyDead) return null

  if (isTokenExpired(supabaseAccessToken) && supabaseRefreshToken) {
    console.log('[Supabase] Token near expiry or expired, refreshing...')
    await refreshSupabaseSession()
  }
  return supabaseAccessToken
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    // Handle deep link from Windows/Linux second instance
    const url = commandLine.pop()
    if (url?.startsWith('zyroapp://')) {
      handleProtocolUrl(url)
    }
  })
}

// Handle macOS deep links
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleProtocolUrl(url)
})

async function handleProtocolUrl(url: string): Promise<void> {
  console.log('[Main] Received protocol URL:', url)
  if (url.includes('auth-callback')) {
    let accessToken: string | null = null
    let refreshToken: string | null = null

    // Try query params first (new format): zyroapp://auth-callback?access_token=...&refresh_token=...
    const queryStart = url.indexOf('?')
    if (queryStart !== -1) {
      const params = new URLSearchParams(url.substring(queryStart + 1))
      accessToken = params.get('access_token')
      refreshToken = params.get('refresh_token')
    }

    // Fallback: hash format (legacy): zyroapp://auth-callback#access_token=...&refresh_token=...
    if (!accessToken) {
      const hashStart = url.indexOf('#')
      if (hashStart !== -1) {
        const params = new URLSearchParams(url.substring(hashStart + 1))
        accessToken = params.get('access_token')
        refreshToken = params.get('refresh_token')
      }
    }

    if (accessToken) {
      console.log('[Main] OAuth token received, fetching user from Supabase...')
      try {
        // Fetch user info so we can store userId in main process
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`
          }
        })
        if (userRes.ok) {
          const userData = await userRes.json()
          const userId = userData.id as string
          console.log('[Main] OAuth user resolved:', userId)
          // Store in module-level vars so supabase-get-profile can use them
          supabaseAccessToken = accessToken
          supabaseRefreshToken = refreshToken
          supabaseUserId = userId
          storeSecureSession({ accessToken, refreshToken, userId })
        } else {
          console.error('[Main] Failed to fetch user from access token, status:', userRes.status)
          // Still store the token — profile fetch may still work
          supabaseAccessToken = accessToken
        }
      } catch (err) {
        console.error('[Main] Error resolving user from token:', err)
        supabaseAccessToken = accessToken
      }

      // Now notify the renderer — it will call supabase-get-profile next
      if (mainWindow) {
        safeSend(mainWindow, 'auth-callback-success', { accessToken, refreshToken })
      } else {
        console.log('[Main] mainWindow not ready, queuing token...')
        pendingSessionData = { accessToken, refreshToken }
      }
    } else {
      console.warn('[Main] Protocol URL received but no access_token found:', url)
    }
  }
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let pendingSessionData: unknown = null
let activeResizeInterval: NodeJS.Timeout | null = null
let activeBlockerId: number | null = null
let overlayVisible = true // tracks Ctrl+B stealth toggle state (monitor)
let screenProtectionEnabled = true // tracks Ctrl+N screen share protection toggle state

// Guard helper: only send if the window + webContents are still alive
function safeSend(
  win: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!win || win.isDestroyed()) return
  if (!win.webContents || win.webContents.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

function safeZoom(win: BrowserWindow | null | undefined, level: number): void {
  if (!win || win.isDestroyed()) return
  if (!win.webContents || win.webContents.isDestroyed()) return
  win.webContents.setZoomLevel(level)
}

function protectWindowFromInspection(win: BrowserWindow | null): void {
  if (!win || is.dev) return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      event.preventDefault()
    }
    if ((input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')) {
      event.preventDefault()
    }
    if ((input.control || input.meta) && input.shift && (input.key === 'J' || input.key === 'j')) {
      event.preventDefault()
    }
    if ((input.control || input.meta) && (input.key === 'U' || input.key === 'u')) {
      event.preventDefault()
    }
  })

  win.webContents.on('devtools-opened', () => {
    win.webContents.closeDevTools()
  })
}

// ─────────────────────────────────────────────
//  Main "Setup" window
// ─────────────────────────────────────────────
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 768,
    height: 522,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0b0f',
    title: 'AppService',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      zoomFactor: 1.0
    }
  })

  protectWindowFromInspection(mainWindow)

  // Disable zoom shortcuts in setup window (Ctrl+, Ctrl-, Ctrl0, and variants)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isZoom =
      (input.control || input.meta) &&
      (input.key === '=' ||
        input.key === '+' ||
        input.key === '-' ||
        input.key === '_' ||
        input.key === '0')
    if (isZoom) event.preventDefault()
  })

  // Disable pinch/wheel zoom completely for this window
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)

  // Force actual zoom level to 0 on every show just in case it's shared across origin
  mainWindow.on('show', () => {
    safeZoom(mainWindow, 0)
  })

  mainWindow.on('ready-to-show', () => {
    safeZoom(mainWindow, 0)
    mainWindow?.show()
    // Check for updates silently in background (production only)
    if (!is.dev) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err) => {
          console.warn('[Updater] Startup check failed (no internet?):', err?.message)
        })
      }, 3000) // 3s delay — let app finish painting before checking
    }
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─────────────────────────────────────────────
//  Overlay window  (hidden from screen share)
// ─────────────────────────────────────────────
function createOverlayWindow(): void {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const overlayW = 850
  const overlayH = 600

  overlayWindow = new BrowserWindow({
    width: overlayW,
    height: overlayH,
    x: Math.floor((width - overlayW) / 2),
    y: 12,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: true, // Enable to allow setSize to work reliably
    movable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false // Prevents Chromium from throttling timers when overlay is out of focus
    }
  })

  protectWindowFromInspection(overlayWindow)
  applyStealthMode(overlayWindow)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  // Re-assert topmost whenever the window loses focus (Windows can demote HWND_TOPMOST)
  overlayWindow.on('blur', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#overlay`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
}

// ─────────────────────────────────────────────
//  IPC Handlers
// ─────────────────────────────────────────────
function setupIPC(): void {
  // Intercept getDisplayMedia for loopback audio (fallback)
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        callback({ video: sources[0], audio: 'loopback' })
      })
      .catch(() => callback({}))
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera', 'display-capture', 'audioCapture']
    callback(allowed.includes(permission))
  })

  ipcMain.handle('get-deepgram-key', () => {
    return process.env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_STT_KEY || ''
  })

  ipcMain.handle('index-local-content', (_event, { source, content }) => {
    return localVectorDb.indexContent(source, content)
  })

  ipcMain.handle('search-local-vector-db', (_event, { query, topK }) => {
    return localVectorDb.search(query, topK || 3)
  })

  ipcMain.handle('get-session', () => pendingSessionData)
  ipcMain.handle('get-supabase-token', async () => {
    return await ensureFreshSupabaseToken()
  })
  ipcMain.handle('get-supabase-session-data', async () => {
    const token = await ensureFreshSupabaseToken()
    return {
      accessToken: token,
      refreshToken: supabaseRefreshToken
    }
  })

  // ── Knowledge Base IPC Handlers ──────────────────────────────
  ipcMain.handle('kb-list', async () => {
    return { data: [], error: null }
  })

  ipcMain.handle('kb-save', async (_event, args: { title: string; content: string }) => {
    try {
      localVectorDb.indexContent('kb_' + args.title, args.content)
      return { data: { id: `kb_${Date.now()}`, title: args.title, created_at: new Date().toISOString() }, error: null }
    } catch (err: any) {
      console.error('[KB] Save error:', err)
      return { error: err.message }
    }
  })

  ipcMain.handle('kb-delete', async (_event, kbId: string) => {
    try {
      localVectorDb.clearSource(kbId)
      return { error: null }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle('get-screen-size', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize

    return { width, height }
  })

  ipcMain.handle('get-desktop-sources', async () => {
    return await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
  })

  ipcMain.handle('get-bounds', () => overlayWindow?.getBounds())

  // Use module-level Supabase constants & session vars (shared with handleProtocolUrl)
  const savedSession = loadSecureSession()
  if (savedSession?.accessToken && savedSession?.userId) {
    supabaseAccessToken = savedSession.accessToken
    supabaseUserId = savedSession.userId
    supabaseRefreshToken = savedSession.refreshToken || null
    console.log(`[Supabase] Restored session for user: ${supabaseUserId}`)
    if (isTokenExpired(supabaseAccessToken)) {
      console.log('[Supabase] Restored access token is expired, refreshing...')
      refreshSupabaseSession().catch((err) => {
        console.error('[Supabase] Initial session refresh failed:', err)
      })
    } else {
      console.log('[Supabase] Restored access token is still valid. Skipping startup refresh.')
    }
  }

  ipcMain.handle('start-interview', async (_event, sessionData: unknown) => {
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) throw new Error('Not logged in')

    // Check balance via Edge Function — no service_role key in client
    const balanceRes = await fetch(`${SUPABASE_URL}/functions/v1/check-balance`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    })
    if (!balanceRes.ok) throw new Error('Failed to check balance')
    const balanceData = await balanceRes.json()

    if (!balanceData.allowed) {
      console.warn(`[Main] Blocked start-interview for ${supabaseUserId}: ${balanceData.reason}`)
      return { allowed: false, reason: 'insufficient_balance' }
    }

    const sessionDataWithProfile = {
      ...(sessionData as Record<string, unknown>),
      trial_seconds_used: balanceData.trial_seconds_used,
      sessions_balance: balanceData.sessions_balance
    }
    pendingSessionData = sessionDataWithProfile

    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
      overlayWindow!.webContents.once('did-finish-load', () => {
        safeSend(overlayWindow, 'init-session', sessionDataWithProfile)
        safeSend(
          overlayWindow,
          'set-auto-answer',
          !!(sessionDataWithProfile as Record<string, unknown>).autoAnswer
        )
        applyStealthMode(overlayWindow!)
        if (!overlayWindow!.isDestroyed()) overlayWindow!.show()
      })
    } else {
      overlayWindow.reload()
      overlayWindow.webContents.once('did-finish-load', () => {
        safeSend(overlayWindow, 'init-session', sessionDataWithProfile)
        safeSend(
          overlayWindow,
          'set-auto-answer',
          !!(sessionDataWithProfile as Record<string, unknown>).autoAnswer
        )
        applyStealthMode(overlayWindow!)
        if (!overlayWindow!.isDestroyed()) overlayWindow!.show()
      })
    }

    // Prevent OS from suspending or throttling CPU while interview is active
    if (activeBlockerId === null) {
      activeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      console.log('[Main] Power save blocker started, ID:', activeBlockerId)
    }

    // Register scroll shortcuts globally during the interview
    try {
      globalShortcut.register('Up', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'up')
      })
      globalShortcut.register('Down', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'down')
      })
      globalShortcut.register('num8', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'up')
      })
      globalShortcut.register('num2', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'down')
      })
      globalShortcut.register('num9', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'up')
      })
      globalShortcut.register('num3', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'down')
      })
      globalShortcut.register('num7', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'up')
      })
      globalShortcut.register('num1', () => {
        safeSend(overlayWindow, 'scroll-overlay', 'down')
      })
    } catch (err) {
      console.error('[Main] Failed to register global scroll shortcuts:', err)
    }

    // Register Ctrl+B stealth toggle — instantly hides/shows the overlay
    overlayVisible = true
    try {
      globalShortcut.register('Ctrl+B', () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return
        overlayVisible = !overlayVisible
        if (overlayVisible) {
          overlayWindow.setOpacity(1)
          overlayWindow.setIgnoreMouseEvents(false)
        } else {
          overlayWindow.setOpacity(0)
          overlayWindow.setIgnoreMouseEvents(true, { forward: true })
        }
        safeSend(overlayWindow, 'overlay-toggled', overlayVisible)
        console.log('[Main] Overlay stealth toggle:', overlayVisible ? 'VISIBLE' : 'HIDDEN')
      })
      console.log('[Main] Ctrl+B stealth toggle registered')
    } catch (err) {
      console.error('[Main] Failed to register Ctrl+B stealth shortcut:', err)
    }

    // Register Ctrl+N screen share protection toggle — turns Zoom/Meet invisibility ON/OFF
    screenProtectionEnabled = true
    try {
      globalShortcut.register('Ctrl+N', () => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return
        screenProtectionEnabled = !screenProtectionEnabled
        setStealthProtection(overlayWindow, screenProtectionEnabled)
        safeSend(overlayWindow, 'screen-protection-toggled', screenProtectionEnabled)
        console.log('[Main] Screen share protection toggle:', screenProtectionEnabled ? 'ENABLED (Invisible)' : 'DISABLED (Visible)')
      })
      console.log('[Main] Ctrl+N screen share protection toggle registered')
    } catch (err) {
      console.error('[Main] Failed to register Ctrl+N stealth shortcut:', err)
    }

    mainWindow?.hide()
    return { allowed: true }
  })

  ipcMain.on('end-interview', () => {
    pendingSessionData = null

    // Release scroll + stealth shortcuts
    globalShortcut.unregister('Up')
    globalShortcut.unregister('Down')
    globalShortcut.unregister('Ctrl+B')
    globalShortcut.unregister('Ctrl+N')
    const scrollKeys = ['num8', 'num2', 'num9', 'num3', 'num7', 'num1']
    scrollKeys.forEach((key) => globalShortcut.unregister(key))

    // Reset overlay stealth state so next session starts visible + protected
    overlayVisible = true
    screenProtectionEnabled = true
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(1)
      overlayWindow.setIgnoreMouseEvents(false)
      setStealthProtection(overlayWindow, true)
    }

    // Stop power save blocker when interview ends
    if (activeBlockerId !== null) {
      powerSaveBlocker.stop(activeBlockerId)
      console.log('[Main] Power save blocker stopped, ID:', activeBlockerId)
      activeBlockerId = null
    }

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
  })

  ipcMain.on('quit-app', () => {
    app.exit(0)
  })

  ipcMain.handle('supabase-login', async (_e, { email, password }) => {
    // ── Input validation (security: prevent injection & junk data) ──
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new Error('Invalid input types')
    }
    const cleanEmail = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      throw new Error('Invalid email format')
    }
    if (password.length < 6 || password.length > 256) {
      throw new Error('Invalid password length')
    }

    console.log(`[Supabase] Attempting login for: ${cleanEmail}`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email: cleanEmail, password })
    })
    console.log(`[Supabase] Login response status: ${res.status}`)

    if (res.status === 429) {
      throw new Error('Too many login attempts. Please wait a moment and try again.')
    }

    const data = await res.json()
    if (!res.ok) {
      console.error(`[Supabase] Login failed:`, data)
      throw new Error(data.error_description || data.msg || 'Login failed')
    }

    // Validate the response contains expected fields before trusting it
    if (!data.access_token || !data.user?.id) {
      console.error('[Supabase] Login response missing required fields:', Object.keys(data))
      throw new Error('Invalid login response from server')
    }

    console.log(`[Supabase] Login successful for user: ${data.user.id}`)
    // ── CRITICAL: Reset dead-session guard so get-profile works immediately ──
    sessionPermanentlyDead = false
    supabaseAccessToken = data.access_token
    supabaseRefreshToken = data.refresh_token || null
    supabaseUserId = data.user.id
    storeSecureSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user.id
    })
    // Return only non-sensitive metadata — never return raw tokens to renderer
    return { userId: data.user.id, email: data.user.email }
  })

  ipcMain.handle('supabase-send-otp', async (_e, { phone }) => {
    console.log(`[Supabase] Sending Phone OTP for: ${phone}`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ phone })
    })
    console.log(`[Supabase] Send OTP response status: ${res.status}`)
    const data = await res.json()
    if (!res.ok) {
      console.error(`[Supabase] Send OTP failed:`, data)
      throw new Error(data.error_description || data.msg || 'Failed to send OTP')
    }
    return data
  })

  ipcMain.handle('supabase-verify-otp', async (_e, { phone, token }) => {
    // ── Input validation ──
    if (typeof phone !== 'string' || typeof token !== 'string') throw new Error('Invalid input types')
    if (!/^\+?[0-9]{8,15}$/.test(phone.trim())) throw new Error('Invalid phone number format')
    if (!/^[0-9]{4,8}$/.test(token.trim())) throw new Error('Invalid OTP format')

    console.log(`[Supabase] Verifying OTP for: ${phone.trim()}`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ type: 'sms', phone: phone.trim(), token: token.trim() })
    })
    console.log(`[Supabase] Verify OTP response status: ${res.status}`)
    if (res.status === 429) throw new Error('Too many attempts. Please wait before retrying.')
    const data = await res.json()
    if (!res.ok) {
      console.error(`[Supabase] Verify OTP failed:`, data)
      throw new Error(data.error_description || data.msg || 'Verification failed')
    }
    if (!data.access_token || !data.user?.id) {
      throw new Error('Invalid OTP verification response')
    }
    console.log(`[Supabase] OTP verification successful for user: ${data.user.id}`)
    // ── CRITICAL: Reset dead-session guard ──
    sessionPermanentlyDead = false
    supabaseAccessToken = data.access_token
    supabaseRefreshToken = data.refresh_token || null
    supabaseUserId = data.user.id
    storeSecureSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user.id
    })
    return { userId: data.user.id, email: data.user.email }
  })

  ipcMain.handle('supabase-login-google', async () => {
    // Initiate OAuth directly via Supabase, but redirect back to our React web app
    // so we can show a nice "Success! You can close this tab" screen to avoid a hanging blank tab.
    const redirectUri = 'https://www.zyro-ai.in/auth/callback?is_desktop=true'
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`
    
    console.log('[Main] Opening Google login in browser via Supabase directly:', authUrl)
    shell.openExternal(authUrl)
  })

  ipcMain.handle('supabase-manual-sync', async (_e, { accessToken, refreshToken, userId }) => {
    // ── Input validation ──
    if (typeof accessToken !== 'string' || accessToken.length < 20) {
      console.error('[Main] Manual sync rejected: invalid accessToken')
      return { ok: false, userId: null }
    }

    console.log('[Main] Manually syncing session for user:', userId || '(resolving...)')

    // ── CRITICAL: Reset dead-session guard on any fresh token sync ──
    sessionPermanentlyDead = false
    supabaseAccessToken = accessToken
    supabaseRefreshToken = (typeof refreshToken === 'string' && refreshToken.length > 10) ? refreshToken : null

    // If userId wasn't passed, resolve it from the access token directly
    if (userId && typeof userId === 'string' && userId.length > 8) {
      supabaseUserId = userId
    } else if (accessToken) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`
          }
        })
        if (userRes.ok) {
          const userData = await userRes.json()
          if (!userData.id) throw new Error('No user ID in response')
          supabaseUserId = userData.id as string
          console.log('[Main] Resolved userId from token during manual sync:', supabaseUserId)
        } else {
          console.error('[Main] Failed to resolve userId during manual sync, status:', userRes.status)
          // Don't store a broken session
          supabaseAccessToken = null
          supabaseRefreshToken = null
          return { ok: false, userId: null }
        }
      } catch (err) {
        console.error('[Main] Error resolving userId during manual sync:', err)
        supabaseAccessToken = null
        supabaseRefreshToken = null
        return { ok: false, userId: null }
      }
    }

    storeSecureSession({ accessToken, refreshToken: supabaseRefreshToken, userId: supabaseUserId || '' })
    console.log('[Main] Manual sync complete. supabaseUserId:', supabaseUserId)
    return { ok: true, userId: supabaseUserId }
  })

  ipcMain.handle('supabase-logout', async () => {
    if (supabaseAccessToken) {
      // Best-effort server-side logout — ignore errors (token may already be expired)
      fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` }
      }).catch(() => { /* ignore */ })
    }
    // ── CRITICAL: Reset dead-session guard so user can log in again without restart ──
    sessionPermanentlyDead = false
    supabaseAccessToken = null
    supabaseRefreshToken = null
    supabaseUserId = null
    clearSecureSession()
    console.log('[Supabase] User logged out, session cleared')
  })

  ipcMain.handle('supabase-get-profile', async () => {
    console.log(`[Supabase] Fetching profile for: ${supabaseUserId}`)
    if (!supabaseUserId) {
      console.warn('[Supabase] No session found for profile fetch')
      return null
    }

    const token = await ensureFreshSupabaseToken()
    if (!token) {
      console.warn('[Supabase] No access token available for profile fetch')
      return null
    }

    // Use Edge Function — identity derived from JWT server-side, no service_role in client
    let res = await fetch(`${SUPABASE_URL}/functions/v1/get-profile`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    })

    // If 401 Unauthorized, token might have been revoked/expired — refresh and retry once
    if (res.status === 401 && supabaseRefreshToken) {
      console.warn('[Supabase] Profile fetch returned 401, refreshing token and retrying...')
      const refreshed = await refreshSupabaseSession()
      if (refreshed && supabaseAccessToken) {
        res = await fetch(`${SUPABASE_URL}/functions/v1/get-profile`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${supabaseAccessToken}`
          }
        })
      }
    }

    console.log(`[Supabase] Profile fetch status: ${res.status}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error('[Supabase] Profile fetch error:', err)
      return null
    }
    const profile = await res.json()
    console.log(`[Supabase] Profile data:`, profile)
    return profile ?? null
  })

  ipcMain.handle('supabase-deduct-session', async () => {
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) throw new Error('Not logged in')
    // Atomic decrement via Edge Function — eliminates race condition (H3 fix)
    const res = await fetch(`${SUPABASE_URL}/functions/v1/consume-session`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sessionType: 'regular' })
    })
    if (res.status === 402) throw new Error('No sessions remaining')
    if (!res.ok) throw new Error('Failed to consume session')
    const data = await res.json()
    return { newBalance: data.newBalance }
  })

  ipcMain.handle('supabase-deduct-phone-session', async () => {
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) throw new Error('Not logged in')
    // Atomic decrement via Edge Function — eliminates race condition (H3 fix)
    const res = await fetch(`${SUPABASE_URL}/functions/v1/consume-session`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sessionType: 'phone' })
    })
    if (res.status === 402) throw new Error('No sessions remaining')
    if (!res.ok) throw new Error('Failed to consume phone session')
    const data = await res.json()
    return { newBalance: data.newBalance }
  })

  ipcMain.handle('supabase-create-razorpay-order', async (_e, { planId }) => {
    if (!supabaseUserId || !supabaseAccessToken) throw new Error('Not logged in')
    const res = await fetch(`${SUPABASE_URL}/functions/v1/razorpay-create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${supabaseAccessToken}`
      },
      body: JSON.stringify({
        planId,
        couponCode: null
      })
    })

    if (!res.ok) {
      let msg = `Edge function returned status ${res.status}`
      try {
        const body = await res.json()
        if (body.error) msg = body.error
      } catch (e) {
        try {
          const text = await res.text()
          if (text) msg = text
        } catch (e2) {}
      }
      throw new Error(msg)
    }

    return await res.json()
  })

  ipcMain.handle('supabase-update-trial', async (_e, delta) => {
    console.log(`[Supabase] Bumping trial for ${supabaseUserId}: +${delta}s`)
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) {
      console.warn('[Supabase] No session for trial update')
      return
    }
    // Send a delta (elapsed seconds), not an absolute value — server enforces monotonicity
    const res = await fetch(`${SUPABASE_URL}/functions/v1/update-trial`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ delta: Math.min(60, Math.max(0, Number(delta))) })
    })
    console.log(`[Supabase] Update trial status: ${res.status}`)
    const data = await res.json().catch(() => ({}))
    console.log('[Supabase] Update trial result:', data)
  })

  ipcMain.handle(
    'supabase-log-session',
    async (_e, { durationSeconds, startedAt, sessionType }) => {
      console.log(
        `[Supabase] Logging session for ${supabaseUserId}: ${durationSeconds}s, started: ${startedAt}, type: ${sessionType}`
      )
      if (!supabaseUserId || !supabaseAccessToken) {
        console.warn('[Supabase] No session for session log')
        return
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/session_logs`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${supabaseAccessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          user_id: supabaseUserId,
          duration_seconds: durationSeconds,
          started_at: startedAt,
          ended_at: new Date().toISOString(),
          session_type: sessionType
        })
      })
      console.log(`[Supabase] Log session status: ${res.status}`)
      const data = await res.json()
      console.log('[Supabase] Log session result:', data)
    }
  )

  ipcMain.handle('pick-resume', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Select your Resume',
      filters: [{ name: 'Resume', extensions: ['pdf', 'doc', 'docx', 'txt'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return null
    try {
      const buffer = readFileSync(filePaths[0])
      return {
        path: filePaths[0],
        data: buffer.toString('base64'),
        name: filePaths[0].split(/[\\/]/).pop()
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('parse-pdf', async (_event, base64Data: string) => {
    try {
      const buffer = Buffer.from(base64Data, 'base64')
      const uint8Array = new Uint8Array(buffer)
      const parser = new PDFParse(uint8Array)
      const data = await parser.getText()
      return data.text
    } catch (err) {
      console.error('PDF parsing error:', err)
      return ''
    }
  })

  function gatewayHeaders(extra: Record<string, string> = {}, isMultipart = false): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    if (!isMultipart) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  function isWhisperPromptHallucination(text: string): boolean {
    if (!text) return false
    const lower = text.toLowerCase()
    const hallucinationPatterns = [
      /preserve hindi/i,
      /ignore background/i,
      /do not hallucinate/i,
      /multilingual speech/i,
      /speech detection/i,
      /technical interview/i,
      /verbatim in their/i,
      /without translating/i
    ]
    return hallucinationPatterns.some((pattern) => pattern.test(lower))
  }

  ipcMain.handle(
    'transcribe-audio',
    async (_event, { base64Audio, mimeType, language, systemPrompt, resumeText }) => {
      try {
        // Step 1: Transcribe via gateway STT
        const ext = (mimeType as string)?.includes('wav') ? 'wav'
          : (mimeType as string)?.includes('ogg') ? 'ogg'
          : (mimeType as string)?.includes('mp4') ? 'mp4'
          : (mimeType as string)?.includes('flac') ? 'flac' : 'webm'
        const buffer = Buffer.from(base64Audio, 'base64')
        const formData = new FormData()
        formData.append('file', new Blob([buffer], { type: mimeType }), `recording.${ext}`)
        formData.append('model', 'whisper-large-v3-turbo')
        const isHindi = language && (language.startsWith('hi') || language === 'hi-IN')
        // Force Whisper to use the correct language — prevents auto-translate to English
        if (language && language !== 'auto') {
          formData.append('language', language.split('-')[0])
        }
        const sttPrompt = isHindi
          ? 'यह एक हिंदी या हिंग्लिश तकनीकी इंटरव्यू है। जो भी बोला जाए उसे वैसे ही transcribe करें — Hindi में बोले हुए को Hindi/Hinglish में रखें, English में बोले को English में। कभी translate मत करें।'
          : 'Technical interview speech. Transcribe exactly what is spoken. May include English and Hindi (Hinglish). Keep technical terms like API, testing, QA, automation, sprint, Agile in English.'
        formData.append('prompt', sttPrompt)

        const sttRes = await withRetry(() =>
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, { method: 'POST', headers: gatewayHeaders({}, true), body: formData })
        )
        const sttData = await sttRes.json() as { text?: string }
        console.log(`[AI-STT] Received: "${sttData.text?.substring(0, 50)}..."`)
        const transcript = sttData.text || ''
        if (!transcript || isWhisperPromptHallucination(transcript)) {
          return { transcript: '', answer: '' }
        }

        const llmPayload = {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `TRANSCRIPT: ${transcript}\nRESUME: ${resumeText.substring(0, 3000)}` }
          ],
          temperature: 0.72,
          max_tokens: 1024,
          response_format: { type: 'json_object' }
        }

        // Step 2: Generate answer via gateway LLM
        const llmRes = await withRetry(() => 
          fetchWithTimeout(`${AI_GATEWAY}/gateway/llm`, {
            method: 'POST',
            headers: gatewayHeaders(),
            body: JSON.stringify(llmPayload),
            timeout: 45000
          })
        )
        const llmData = await llmRes.json() as { choices?: { message?: { content?: string } }[] }
        let answer = llmData.choices?.[0]?.message?.content || '{}'

        try { const p = JSON.parse(answer); answer = p.answer || answer } catch { /* use raw */ }
        return { transcript, answer }
      } catch (err: unknown) {
        console.error('[Gateway] transcribe-audio error:', err)
        throw err
      }
    }
  )

  ipcMain.handle(
    'transcribe-only',
    async (_event, { base64Audio, mimeType, language, context }) => {
      try {
        const ext = (mimeType as string)?.includes('wav') ? 'wav'
          : (mimeType as string)?.includes('ogg') ? 'ogg'
          : (mimeType as string)?.includes('mp4') ? 'mp4'
          : (mimeType as string)?.includes('flac') ? 'flac' : 'webm'
        const buffer = Buffer.from(base64Audio, 'base64')
        const formData = new FormData()
        formData.append('file', new Blob([buffer], { type: mimeType }), `recording.${ext}`)
        formData.append('model', 'whisper-large-v3-turbo')
        if (language && language !== 'auto') {
          formData.append('language', language.split('-')[0])
        }
        
        const isHindi = language && (language.startsWith('hi') || language === 'hi-IN')
        const defaultPrompt = isHindi
          ? 'यह एक हिंदी या हिंग्लिश तकनीकी इंटरव्यू है। जो भी बोला जाए उसे वैसे ही transcribe करें — Hindi/Hinglish में बोले को Hindi में रखें, translate मत करें। Technical terms जैसे testing, QA, sprint, Jira, automation English में रखें।'
          : 'Technical interview speech. May include Hindi and English (Hinglish). Transcribe exactly as spoken. Keep technical terms in English.'
        const finalPrompt = context 
          ? `${defaultPrompt} Context: ${context.slice(0, 120)}`
          : defaultPrompt
        formData.append('prompt', finalPrompt.slice(-300))

        const res = await withRetry(() =>
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, { method: 'POST', headers: gatewayHeaders({}, true), body: formData })
        )
        const data = await res.json() as { text?: string }
        const text = data.text || ''
        if (isWhisperPromptHallucination(text)) {
          console.log('[Main-STT] Discarded Whisper prompt hallucination:', text)
          return ''
        }
        return text
      } catch (err: unknown) {
        console.error('[Gateway] transcribe-only error:', err)
        throw err
      }
    }
  )

  ipcMain.handle(
    'generate-answer',
    async (
      _event,
      { transcript, systemPrompt, temperature, maxTokens, presencePenalty, frequencyPenalty }
    ) => {
      try {
        console.log(`[AI-LLM] Requesting answer... (Tokens: ${maxTokens})`)
        const res = await withRetry(() =>
          fetchWithTimeout(`${AI_GATEWAY}/gateway/llm`, {
            method: 'POST',
            headers: gatewayHeaders(),
            body: JSON.stringify({
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: transcript }
              ],
              temperature: temperature ?? 0.65,
              max_tokens: maxTokens ?? 1024,
              presence_penalty: presencePenalty ?? 0.4,
              frequency_penalty: frequencyPenalty ?? 0.4
            }),
            timeout: 45000
          })
        )
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        const content = data.choices?.[0]?.message?.content || ''
        console.log(`[AI-LLM] Answer received (${content.length} chars)`)
        return content || 'No response.'
      } catch (err: unknown) {
        console.error('[Gateway] generate-answer error:', err)
        throw err
      }
    }
  )

  ipcMain.handle('analyze-screen', async (_event, { systemPrompt, model: _model }) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      })
      const primarySource = sources[0]
      if (!primarySource) throw new Error('No screen source found')
      const base64Image = 'data:image/jpeg;base64,' + primarySource.thumbnail.toJPEG(85).toString('base64')

      const res = await withRetry(() => 
        fetchWithTimeout(`${AI_GATEWAY}/gateway/vision`, {
          method: 'POST',
          headers: gatewayHeaders(),
          body: JSON.stringify({
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Look at this screenshot. Identify ANY interview question visible (coding, MCQ, behavioral, HR, technical). Provide the answer the candidate should say out loud, per system prompt instructions.' },
                  { type: 'image_url', image_url: { url: base64Image } }
                ]
              }
            ],
            max_tokens: 1024
          }),
          timeout: 45000
        })
      )
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      return data.choices?.[0]?.message?.content || 'No content found on screen.'
    } catch (err: any) {
      console.error('[Gateway] analyze-screen error:', err)
      throw err
    }
  })

  ipcMain.handle('capture-screenshot', async () => {
    try {
      // ── Ghostly Micro-Blink Stealth Screenshot Protocol ──
      // Temporarily hide overlayWindow from GPU framebuffer before capture
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setOpacity(0)
      }

      // Wait 120ms for DWM / GPU compositor framebuffer to clear overlay pixels
      await new Promise((resolve) => setTimeout(resolve, 120))

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      })

      // Restore overlay visibility immediately after capturing screen
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setOpacity(1)
        nudgeRepaint(overlayWindow)
      }

      const primarySource = sources[0]
      if (!primarySource) throw new Error('No screen source found')
      const jpegBuffer = primarySource.thumbnail.toJPEG(85)
      return 'data:image/jpeg;base64,' + jpegBuffer.toString('base64')
    } catch (err) {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setOpacity(1)
      }
      console.error('[Gateway] capture-screenshot error:', err)
      throw err
    }
  })

  ipcMain.handle('query-vision', async (_event, { systemPrompt, base64Image }) => {
    try {
      const res = await withRetry(() => 
        fetchWithTimeout(`${AI_GATEWAY}/gateway/vision`, {
          method: 'POST',
          headers: gatewayHeaders(),
          body: JSON.stringify({
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Look at this screenshot. Identify ANY interview question visible (coding, MCQ, behavioral, HR, technical). Provide the answer the candidate should say out loud, per system prompt instructions.' },
                  { type: 'image_url', image_url: { url: base64Image } }
                ]
              }
            ],
            max_tokens: 1024
          }),
          timeout: 45000
        })
      )
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      return data.choices?.[0]?.message?.content || 'No response.'
    } catch (err: unknown) {
      console.error('[Gateway] query-vision error:', err)
      throw err
    }
  })

  ipcMain.handle('extract-question-from-image', async (_event, { base64Image }) => {
    try {
      const res = await withRetry(() => 
        fetchWithTimeout(`${AI_GATEWAY}/gateway/vision`, {
          method: 'POST',
          headers: gatewayHeaders(),
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analyze this screenshot. Identify the primary technical question, coding problem, or multiple-choice question visible on the screen. Extract and output ONLY the raw question text. Do NOT answer the question. If no question is visible, output an empty string.' },
                  { type: 'image_url', image_url: { url: base64Image } }
                ]
              }
            ],
            max_tokens: 256
          }),
          timeout: 45000
        })
      )
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      return data.choices?.[0]?.message?.content || ''
    } catch (err: unknown) {
      console.error('[Gateway] extract-question-from-image error:', err)
      throw err
    }
  })

  ipcMain.on('set-overlay-position', (_event, { x, y }) => {
    const s = screen.getPrimaryDisplay().workAreaSize
    const size = overlayWindow?.getSize()
    if (!overlayWindow || !size) return
    overlayWindow.setPosition(
      Math.max(0, Math.min(x, s.width - size[0])),
      Math.max(0, Math.min(y, s.height - size[1]))
    )
  })

  ipcMain.on('toggle-screen-protection', (_event, enabled?: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    screenProtectionEnabled = typeof enabled === 'boolean' ? enabled : !screenProtectionEnabled
    setStealthProtection(overlayWindow, screenProtectionEnabled)
    safeSend(overlayWindow, 'screen-protection-toggled', screenProtectionEnabled)
    console.log('[Main] Manual screen protection toggle:', screenProtectionEnabled ? 'ENABLED' : 'DISABLED')
  })

  ipcMain.on('set-overlay-size', (_event, { width, height }) => {
    overlayWindow?.setSize(width, height)
    overlayWindow?.setAlwaysOnTop(true, 'screen-saver')
  })

  ipcMain.on('set-bounds', (_event, bounds) => {
    overlayWindow?.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
  })

  ipcMain.on('set-ignore-mouse', (_event, ignore, options) => {
    overlayWindow?.setIgnoreMouseEvents(ignore, options)
  })

  ipcMain.on('toggle-compact', (_event, minimized: boolean) => {
    if (!overlayWindow) return
    const [w] = overlayWindow.getSize()
    overlayWindow.setSize(w, minimized ? 48 : 600, true)
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  })

  ipcMain.on('set-zoom', (_event, level: number) => {
    overlayWindow?.webContents.setZoomLevel(level)
  })

  ipcMain.handle('resize-main-window', async (_event, { width, height }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return

    if (activeResizeInterval) {
      clearInterval(activeResizeInterval)
      activeResizeInterval = null
    }

    const startBounds = mainWindow.getBounds()
    const startWidth = startBounds.width
    const startHeight = startBounds.height

    // If already at target dimensions, do nothing to prevent fight with user dragging!
    if (Math.abs(startWidth - width) < 2 && Math.abs(startHeight - height) < 2) {
      return
    }

    const deltaWidth = width - startWidth
    const deltaHeight = height - startHeight
    const startTime = Date.now()
    const durationMs = 280

    activeResizeInterval = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        if (activeResizeInterval) {
          clearInterval(activeResizeInterval)
          activeResizeInterval = null
        }
        return
      }

      const elapsed = Date.now() - startTime
      const progress = Math.min(1, elapsed / durationMs)

      // easeInOutCubic easing
      const ease = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2

      const currentWidth = Math.round(startWidth + deltaWidth * ease)
      const currentHeight = Math.round(startHeight + deltaHeight * ease)

      // Maintain live window origin when resizing
      const liveBounds = mainWindow.getBounds()
      const currentX = Math.round(liveBounds.x + (liveBounds.width - currentWidth) / 2)
      const currentY = Math.round(liveBounds.y + (liveBounds.height - currentHeight) / 2)

      mainWindow.setBounds({
        x: currentX,
        y: currentY,
        width: currentWidth,
        height: currentHeight
      })

      if (progress >= 1) {
        if (activeResizeInterval) {
          clearInterval(activeResizeInterval)
          activeResizeInterval = null
        }
      }
    }, 16)
  })

  ipcMain.on('reload-window', (): void => mainWindow?.reload())
  ipcMain.on('minimize-window', (): void => mainWindow?.minimize())
  ipcMain.on('close-window', (): void => mainWindow?.close())

  ipcMain.handle('install-update', (): void => {
    console.log('[Updater] User triggered install — quitting and installing...')
    // isSilent=true, isForceRunAfter=true → relaunches app after install
    autoUpdater.quitAndInstall(true, true)
  })

  // Manual download trigger (kept for compatibility, normally auto-downloaded)
  ipcMain.handle('download-update', async (): Promise<void> => {
    console.log('[Updater] Manual download triggered')
    await autoUpdater.downloadUpdate()
  })

  // ── AutoUpdater event pipeline ─────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
  })

  autoUpdater.on('update-available', (info): void => {
    console.log('[Updater] Update available:', info.version)
    // Notify renderer: shows a subtle banner with version info
    safeSend(mainWindow, 'update-available', info)
    // autoDownload=true means electron-updater starts downloading automatically
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] App is up to date:', info.version)
  })

  autoUpdater.on('download-progress', (progress): void => {
    const pct = Math.floor(progress.percent)
    console.log(`[Updater] Downloading... ${pct}% (${Math.floor(progress.bytesPerSecond / 1024)} KB/s)`)
    safeSend(mainWindow, 'update-progress', progress)
  })

  autoUpdater.on('update-downloaded', (info): void => {
    console.log('[Updater] Download complete. Version ready:', info.version)
    // Notify renderer: shows "Install & Relaunch" button
    safeSend(mainWindow, 'update-ready', info)
  })

  autoUpdater.on('error', (err): void => {
    console.error('[Updater] Error:', err?.message)
    // Only forward non-trivial errors (skip network timeouts on startup)
    if (!err?.message?.includes('net::ERR_INTERNET_DISCONNECTED') &&
        !err?.message?.includes('ENOTFOUND')) {
      safeSend(mainWindow, 'update-error', err.message)
    }
  })

  ipcMain.on('open-external', (_, url) => {
    shell.openExternal(url)
  })
}

// ─────────────────────────────────────────────
//  App lifecycle
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.security.hp')

  // We'll manage shortcuts manually or selectively to avoid global zoom in setup
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupIPC()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
