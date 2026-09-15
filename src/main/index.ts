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
  powerSaveBlocker,
  clipboard
} from 'electron'
import { join } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
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
import { prepareInterviewStart } from './interviewReadiness'
import { drainSseEvents, extractDelta, stripThinkBlocks, SSE_DONE } from './sseParser'

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
  'sb_publishable_RzCwEWjxwtqGclqY5SKCdQ_uoikKwsL'
// NOTE: service_role key removed — all privileged operations use Edge Functions

let supabaseAccessToken: string | null = null
let supabaseUserId: string | null = null
let supabaseRefreshToken: string | null = null

// ── External URL policy (audit H2) ──
// shell.openExternal hands a URL to the OS. Handlers like file://, smb:// and
// search-ms: let a crafted page abuse OS handlers (NTLM leak, malicious search
// scopes), so only https to a fixed set of hosts ever leaves the app.
const EXTERNAL_URL_HOSTS = new Set([
  'www.zyro-ai.in',
  'zyro-ai.in',
  'api.razorpay.com',
  'checkout.razorpay.com',
  'weqwxoihdfsvjwwcgtat.supabase.co'
])

function safeOpenExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !EXTERNAL_URL_HOSTS.has(parsed.hostname)) {
      console.warn(`[Main] Blocked external URL (scheme/host not allowed): ${parsed.protocol}//${parsed.hostname}`)
      return false
    }
    shell.openExternal(parsed.toString())
    return true
  } catch {
    console.warn('[Main] Blocked malformed external URL')
    return false
  }
}

// ── OAuth state (anti-CSRF for the zyroapp:// deep link) ──
// Generated when a Google login starts, echoed back by the website's callback
// page, and consumed exactly once by handleProtocolUrl. Without it, a crafted
// link carrying an attacker's tokens would silently log the victim into the
// attacker's account (audit H1).
let pendingAuthState: { value: string; expiresAt: number } | null = null
const AUTH_STATE_TTL_MS = 10 * 60 * 1000

function generateAuthState(): string {
  const value = randomBytes(32).toString('hex')
  pendingAuthState = { value, expiresAt: Date.now() + AUTH_STATE_TTL_MS }
  return value
}

/** Single-use: a valid state is consumed on first check, expired or wrong ones fail closed. */
function consumeAuthState(candidate: string | null): boolean {
  if (!candidate || !pendingAuthState) return false
  const expected = pendingAuthState
  pendingAuthState = null
  if (Date.now() > expected.expiresAt) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected.value)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── Gateway token state ──
// Short-lived HMAC token issued by the Supabase Edge Function.
// Used in every AI gateway request via gatewayHeaders().
// Refreshed automatically when < 10 minutes remain.
let gatewayToken: string | null = null
let gatewayTokenExpiresAt: number = 0

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
  // Clear gateway token too
  gatewayToken = null
  gatewayTokenExpiresAt = 0
  clearSecureSession()
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('session-expired')
  })
}

/**
 * Fetches a fresh HMAC gateway token from the Supabase Edge Function.
 * The token encodes {userId, expiry} and is signed with the shared HMAC secret.
 * Valid 2h for free/trial users, 6h for paid — avoids per-request Supabase calls.
 */
async function fetchGatewayToken(): Promise<string> {
  const accessToken = await ensureFreshSupabaseToken()
  if (!accessToken) {
    throw new Error('No Supabase token available')
  }
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/generate-gateway-token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY,
      },
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.warn('[GatewayToken] Failed to fetch token:', res.status, err)
    if (err?.error === 'trial_expired') {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('trial-expired')
      })
    }
    throw new Error(`Gateway token request failed (${res.status})`)
  }
  const data = await res.json() as { token?: string; expiresAt?: number; tier?: string }
  if (!data.token || !data.expiresAt) {
    throw new Error('Gateway token response was incomplete')
  }
  gatewayToken = data.token
  gatewayTokenExpiresAt = data.expiresAt
  console.log(`[GatewayToken] Token issued (tier: ${data.tier}, expires: ${new Date(gatewayTokenExpiresAt).toISOString()})`)
  return gatewayToken
}

/**
 * Returns the current gateway token, refreshing it if < 1 minute remains.
 * 1 minute threshold (not 10) because free user tokens are tightly scoped
 * to remaining trial time — a 10-minute threshold would cause refresh loops.
 */
let gatewayTokenPromise: Promise<string> | null = null

async function ensureFreshGatewayToken(): Promise<string> {
  const ONE_MINUTE = 60 * 1000
  if (!gatewayToken || Date.now() > gatewayTokenExpiresAt - ONE_MINUTE) {
    if (!gatewayTokenPromise) {
      gatewayTokenPromise = fetchGatewayToken().finally(() => {
        gatewayTokenPromise = null
      })
    }
    return gatewayTokenPromise
  }
  return gatewayToken
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
  // Never log the full URL — it carries session tokens.
  if (!url.includes('auth-callback')) {
    console.log('[Main] Received protocol URL (non-auth)')
    return
  }

  // H1: a token-bearing callback is only accepted when it echoes the single-use
  // state we generated when the login started. Crafted links fail closed here.
  const state = extractProtocolParam(url, 'state')
  if (!consumeAuthState(state)) {
    console.warn('[Main] Rejected auth-callback: missing, expired, or mismatched state')
    return
  }

  const accessToken: string | null = extractProtocolParam(url, 'access_token')
  const refreshToken: string | null = extractProtocolParam(url, 'refresh_token')

  if (accessToken) {
    console.log('[Main] OAuth token received (state valid), fetching user from Supabase...')
    // A fresh OAuth login always resets the dead-session guard (forceLogout may
    // have set it for the previous session)
    sessionPermanentlyDead = false
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
        // Still store the token — supabase-get-profile resolves the user itself
        supabaseAccessToken = accessToken
        supabaseRefreshToken = refreshToken
      }
    } catch (err) {
      console.error('[Main] Error resolving user from token:', err)
      supabaseAccessToken = accessToken
      supabaseRefreshToken = refreshToken
    }

    // Notify the renderer that login succeeded. No tokens in the payload (audit H4):
    // main already stored the session securely; the renderer pulls the profile via IPC.
    if (mainWindow) {
      safeSend(mainWindow, 'auth-callback-success', {})
    } else {
      console.log('[Main] mainWindow not ready — session stored, will be picked up on login screen')
    }
    // Fetch gateway token immediately after successful auth (fire-and-forget)
    fetchGatewayToken().catch((e) => console.warn('[GatewayToken] Initial fetch failed:', e))
  } else {
    console.warn('[Main] Auth-callback received without access_token')
  }
}

/**
 * Reads a param from a zyroapp:// URL, whether it sits in the query string
 * (`zyroapp://auth-callback?k=v`) or the legacy hash fragment (`…#k=v`).
 */
function extractProtocolParam(url: string, key: string): string | null {
  const queryStart = url.indexOf('?')
  if (queryStart !== -1) {
    const value = new URLSearchParams(url.substring(queryStart + 1)).get(key)
    if (value) return value
  }
  const hashStart = url.indexOf('#')
  if (hashStart !== -1) {
    return new URLSearchParams(url.substring(hashStart + 1)).get(key)
  }
  return null
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
    // H2: deny-by-default — only https to allowlisted hosts may reach the OS
    safeOpenExternal(details.url)
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
  const defaultOverlayW = 940
  const maxOverlayW = 1040
  const overlayH = 700

  overlayWindow = new BrowserWindow({
    width: defaultOverlayW,
    height: overlayH,
    minWidth: 720, // Responsive minimum width allowing flexible shrinking
    maxWidth: maxOverlayW, // Allow resizing up to 1040px max
    minHeight: 420,
    x: Math.floor((width - defaultOverlayW) / 2),
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

  // Clipboard write — navigator.clipboard.writeText() silently fails in overlay
  // windows (alwaysOnTop + skipTaskbar lose clipboard permission in Chromium).
  // Route through main process which always has access via Electron's clipboard module.
  ipcMain.handle('write-clipboard', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  // The renderer needs this for the live-STT WebSocket. Every other gateway call is
  // made from here in main, so the URL had no reason to leave this file before.
  ipcMain.handle('get-ai-gateway-url', () => AI_GATEWAY)

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
  // H4: the renderer gets the short-lived access token only — the refresh token
  // never crosses the IPC boundary, so a compromised renderer can't mint sessions.
  ipcMain.handle('get-supabase-session-data', async () => {
    const token = await ensureFreshSupabaseToken()
    return { accessToken: token }
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

  // Lightweight pre-warm: fetches the gateway token in the background while the user
  // is on the mic/speaker test screen, so the first LLM answer has zero token-fetch delay.
  ipcMain.handle('prewarm-gateway-token', async () => {
    ensureFreshGatewayToken().catch(err =>
      console.warn('[GatewayToken] Pre-warm (mic-test screen) failed:', err)
    )
    return { ok: true }
  })

  // The live STT WebSocket authenticates via `?token=` on the URL (browsers cannot
  // set headers on a WS handshake). The renderer asks for the token right here —
  // it never handles the Supabase session itself.
  ipcMain.handle('get-gateway-token', async () => {
    try {
      return await ensureFreshGatewayToken()
    } catch {
      return null
    }
  })

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

    const balanceData = await prepareInterviewStart({
      prewarmGatewayToken: ensureFreshGatewayToken,
      checkBalance: async () => {
        const balanceRes = await fetch(`${SUPABASE_URL}/functions/v1/check-balance`, {
          method: 'GET',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`
          }
        })
        if (!balanceRes.ok) throw new Error('Failed to check balance')
        return balanceRes.json()
      }
    })

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
      const { width } = screen.getPrimaryDisplay().workAreaSize
      // Reset a reused overlay back to the default size (940x700)
      overlayWindow.setBounds({
        x: Math.floor((width - 940) / 2),
        y: 12,
        width: 940,
        height: 700
      })
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
      // Left/Right page through already-answered Q&A (prev = older, next = newer).
      // Bare arrows match the existing bare Up/Down convention above, with the
      // numpad 4/6 aliases for keyboards where the arrow cluster is awkward.
      globalShortcut.register('Left', () => {
        safeSend(overlayWindow, 'history-nav', 'prev')
      })
      globalShortcut.register('Right', () => {
        safeSend(overlayWindow, 'history-nav', 'next')
      })
      globalShortcut.register('num4', () => {
        safeSend(overlayWindow, 'history-nav', 'prev')
      })
      globalShortcut.register('num6', () => {
        safeSend(overlayWindow, 'history-nav', 'next')
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

    // Clear cached gateway token so the next session fetches a fresh one.
    // Free user tokens now encode remaining trial time — keeping a stale token
    // would mean the next session starts with the wrong (already-used) expiry.
    gatewayToken = null
    gatewayTokenExpiresAt = 0

    // Release scroll + stealth shortcuts
    globalShortcut.unregister('Up')
    globalShortcut.unregister('Down')
    globalShortcut.unregister('Left')
    globalShortcut.unregister('Right')
    globalShortcut.unregister('Ctrl+B')
    globalShortcut.unregister('Ctrl+N')
    const numpadKeys = ['num8', 'num2', 'num9', 'num3', 'num7', 'num1', 'num4', 'num6']
    numpadKeys.forEach((key) => globalShortcut.unregister(key))

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
    // H1: the single-use state travels with the redirect and must come back on the
    // zyroapp:// callback — handleProtocolUrl rejects callbacks without it.
    const state = generateAuthState()
    const redirectUri = `https://www.zyro-ai.in/auth/callback?is_desktop=true&state=${state}`
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`

    console.log('[Main] Opening Google login in browser via Supabase directly (state issued)')
    safeOpenExternal(authUrl)
  })

  // H5: the old `supabase-manual-sync` handler was removed. It accepted
  // renderer-supplied tokens, which made it an injection point — and since H4
  // stopped handing tokens to the renderer, it had no legitimate caller left.
  // `supabase-get-profile` now resolves the user itself when the id is missing.

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
    const token = await ensureFreshSupabaseToken()
    if (!token) {
      console.warn('[Supabase] No access token available for profile fetch')
      return null
    }

    // Deep-link flow can land before the user fetch resolves the id — resolve it
    // from the token itself instead of failing (this replaced the manual-sync path).
    if (!supabaseUserId) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
        })
        if (userRes.ok) {
          supabaseUserId = ((await userRes.json()) as { id?: string }).id ?? null
          console.log('[Supabase] Resolved userId from token during profile fetch:', supabaseUserId)
        }
      } catch (err) {
        console.warn('[Supabase] Could not resolve userId during profile fetch:', err)
      }
      if (!supabaseUserId) {
        console.warn('[Supabase] No session found for profile fetch')
        return null
      }
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
        return null
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
      // The created row's id lets the transcript insert link back to its session.
      return Array.isArray(data) && data[0]?.id ? (data[0].id as string) : null
    }
  )

  /**
   * Persists the live-session Q&A record captured by the overlay.
   * Body lives in saveTranscriptInternal, shared with the exit flow.
   */
  ipcMain.handle('supabase-save-transcript', (_e, payload) => saveTranscriptInternal(payload))

  /**
   * End-of-interview handoff with a hard time budget.
   *
   * The renderer hands over the serialized Q&A record and session metadata and
   * returns; this handler performs every cloud write (trial/credit accounting,
   * session log, transcript + Drive copy) and only then exits the app. This
   * replaces the old renderer-orchestrated sequence whose final `app.exit(0)`
   * could kill in-flight network writes.
   */
  const logSessionReturningId = async (
    durationSeconds: number,
    startedAt: string,
    sessionType: string
  ): Promise<string | null> => {
    if (!supabaseUserId || !supabaseAccessToken) return null
    const token = (await ensureFreshSupabaseToken()) ?? supabaseAccessToken
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/session_logs`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
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
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows[0]?.id ? (rows[0].id as string) : null
    } catch {
      return null
    }
  }

  /** Shared body of 'supabase-save-transcript' — used by both the IPC handle and the exit flow. */
  const saveTranscriptInternal = async (args: {
    startedAt: string
    endedAt: string
    durationSeconds: number
    sessionType: string
    sessionId?: string
    qa: { id: string; question: string; answer: string; timestamp: string }[]
  }): Promise<{ ok: boolean; transcriptId?: string }> => {
    if (!supabaseUserId || !supabaseAccessToken) return { ok: false }
    try {
      const token = await ensureFreshSupabaseToken()
      if (!token) return { ok: false }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/session_transcripts`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          user_id: supabaseUserId,
          session_id: args.sessionId ?? null,
          session_type: args.sessionType,
          started_at: args.startedAt,
          ended_at: args.endedAt,
          duration_seconds: args.durationSeconds,
          qa: args.qa
        })
      })
      if (!res.ok) {
        console.error(`[Supabase] Transcript save failed: ${res.status}`)
        return { ok: false }
      }
      const rows = await res.json()
      const transcriptId = Array.isArray(rows) && rows[0]?.id ? (rows[0].id as string) : null
      console.log(`[Supabase] Transcript saved: ${transcriptId} (${args.qa.length} Q&A pairs)`)

      // Best-effort Drive copy. The edge function no-ops for users who are
      // not connected; failures here never affect the DB record.
      if (transcriptId) {
        fetch(`${SUPABASE_URL}/functions/v1/drive-sync-transcript`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ transcriptId })
        }).catch((err) => console.warn('[Supabase] Drive sync skipped:', err))
      }
      return { ok: true, transcriptId: transcriptId ?? undefined }
    } catch (err) {
      console.error('[Supabase] Transcript save error:', err)
      return { ok: false }
    }
  }

  /** Trial accounting for free users during the exit flow (delta seconds). */
  const invokeUpdateTrial = async (delta: number): Promise<void> => {
    if (delta <= 0) return
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) return
    await fetch(`${SUPABASE_URL}/functions/v1/update-trial`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ delta: Math.min(60, Math.max(0, delta)) })
    }).catch(() => {})
  }

  /**
   * Credit-hour accounting for premium users during the exit flow. Calls the
   * deduct-credit-hours edge function directly (the standalone IPC handler for
   * this was never registered, so the renderer's invoke path was dead anyway).
   */
  const invokeDeductCreditHours = async (args: {
    durationSeconds: number
    releaseHold?: boolean
  }): Promise<void> => {
    const token = await ensureFreshSupabaseToken()
    if (!supabaseUserId || !token) return
    await fetch(`${SUPABASE_URL}/functions/v1/deduct-credit-hours`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        durationSeconds: args.durationSeconds,
        releaseHold: args.releaseHold ?? false
      })
    }).catch(() => {})
  }

  ipcMain.on('end-interview-and-exit', async (_e, payload) => {
    const {
      elapsed,
      startedAt,
      sessionType,
      premium,
      releaseHold,
      qa
    } = payload as {
      elapsed: number
      startedAt: string
      sessionType: string
      premium: boolean
      releaseHold?: boolean
      qa: { id: string; question: string; answer: string; timestamp: string }[]
    }

    // Everything below runs against a 10s budget so a dead network can never
    // hang the exit — the app must always quit.
    await Promise.race([
      (async () => {
        try {
          if (premium) {
            await invokeDeductCreditHours({ durationSeconds: elapsed, releaseHold })
          } else {
            await invokeUpdateTrial(Math.max(0, elapsed))
          }
        } catch (err) {
          console.warn('[EndInterview] billing step failed:', err)
        }
        try {
          const sessionId = await logSessionReturningId(elapsed, startedAt, sessionType)
          if (qa.length > 0) {
            await saveTranscriptInternal({
              startedAt,
              endedAt: new Date().toISOString(),
              durationSeconds: elapsed,
              sessionType,
              sessionId: sessionId ?? undefined,
              qa
            })
          }
        } catch (err) {
          console.warn('[EndInterview] logging step failed:', err)
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, 10000))
    ])

    app.exit(0)
  })

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
    // Attach the HMAC gateway token so the Worker can authenticate this request.
    // Token may be null in dev mode (Worker runs open when GATEWAY_HMAC_SECRET is unset).
    if (gatewayToken) {
      headers['x-gateway-token'] = gatewayToken
    }
    return headers
  }

  // Only 'auto' asks Whisper to detect the language itself. Everything the user
  // explicitly picked — including `hi` and `en` — is pinned.
  //
  // Leaving `hi` and `en` unpinned was a hallucination source, not a feature:
  // Whisper decides the language from the first ~1s of the clip, so on the short
  // clips this pipeline sends it flips per chunk, and a Hindi clip detected as
  // English is decoded as fluent-but-invented English. Pinning does NOT translate —
  // that is `task=translate`, which we never send.
  function resolveSttLanguage(language?: string): string | null {
    if (!language) return null
    const base = language.split('-')[0].toLowerCase()
    if (!base || base === 'auto') return null
    return base
  }

  // Whisper's `prompt` is not an instruction channel — it is fed to the decoder as
  // *text preceding the audio*, so whatever it contains is something the model tries
  // to continue. It therefore holds a bare domain vocabulary list and nothing else:
  //
  //  - No instructions ("never translate", "write down exactly what is spoken").
  //    Those got transcribed into the output verbatim, which is why
  //    isWhisperPromptHallucination() below had to exist.
  //  - No previous transcript. Conditioning on the last utterance is precisely what
  //    makes Whisper repeat or continue it when the new audio is quiet or short —
  //    the reported "text from previous audio" symptom.
  //  - No Devanagari. A Devanagari prompt biases the decoder towards Hindi output
  //    even when the audio is pure English.
  const STT_VOCABULARY_PROMPT =
    'QA, regression testing, automation, Selenium, API, Jira, Agile, sprint, CI/CD, database, framework, deployment, test case, defect.'

  function buildSttPrompt(language?: string): string {
    const base = resolveSttLanguage(language)
    // The list is English/Hinglish technical vocabulary; sending it on an es/fr/ja
    // session would only bias that session's decoder towards English.
    if (base && base !== 'en' && base !== 'hi') return ''
    return STT_VOCABULARY_PROMPT
  }

  function isWhisperPromptHallucination(text: string): boolean {
    if (!text) return false
    const lower = text.toLowerCase()
    // Safety net for echoes of the STT prompt. The prompt no longer contains
    // instructions, so this should stop firing; the older phrasings are kept because
    // the deployed gateway may still be on the previous prompt for a while.
    // Deliberately narrow and phrase-specific — a broad pattern like
    // /technical interview/ also discards legitimate speech such as
    // "so this is a technical interview for the QA role".
    const hallucinationPatterns = [
      /preserve hindi/i,
      /ignore background/i,
      /do not hallucinate/i,
      /multilingual speech/i,
      /speech detection/i,
      /verbatim in their/i,
      /without translating/i,
      /never translate/i,
      /speakers mix hindi and english/i,
      /write down exactly what is spoken/i,
      /keep technical words in english/i,
      /^interview conversation[.,]/i,
      // Echo of the vocabulary list itself
      /regression testing, automation, selenium/i
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
        const sttLanguage = resolveSttLanguage(language)
        if (sttLanguage) {
          formData.append('language', sttLanguage)
        }
        const sttPrompt = buildSttPrompt(language)
        if (sttPrompt) formData.append('prompt', sttPrompt)

        const sttRes = await withRetry(() =>
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, {
            method: 'POST',
            // STT requires the gateway token like every other route (audit C7 —
            // the worker-side exemption is gone).
            headers: gatewayHeaders({}, true),
            body: formData
          })
        )
        const sttData = await sttRes.json() as { text?: string; language?: string }
        // Length only — transcript content is interview-sensitive and must not reach
        // a production log file.
        console.log(`[AI-STT] Received ${sttData.text?.length ?? 0} chars`)
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
    async (_event, { base64Audio, mimeType, language, isPartial }) => {
      try {
        const ext = (mimeType as string)?.includes('wav') ? 'wav'
          : (mimeType as string)?.includes('ogg') ? 'ogg'
          : (mimeType as string)?.includes('mp4') ? 'mp4'
          : (mimeType as string)?.includes('flac') ? 'flac' : 'webm'
        const buffer = Buffer.from(base64Audio, 'base64')
        const formData = new FormData()
        formData.append('file', new Blob([buffer], { type: mimeType }), `recording.${ext}`)
        formData.append('model', 'whisper-large-v3-turbo')
        const sttLanguage = resolveSttLanguage(language)
        if (sttLanguage) {
          formData.append('language', sttLanguage)
        }
        // Fixed-length vocabulary hint, sent whole. It used to be
        // `buildSttPrompt(language, context).slice(-300)`, which both fed Whisper the
        // previous transcript and cut the prompt mid-word, leaving a fragment as the
        // decoder's leading context.
        const prompt = buildSttPrompt(language)
        if (prompt) formData.append('prompt', prompt)

        // Partials feed the live transcript ticker and are superseded ~3x/sec, so a
        // retry/backoff on one of them is wasted work that only adds lag. Finals go
        // to the LLM and keep the full retry path.
        const doFetch = (): Promise<Response> =>
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, {
            method: 'POST',
            // STT requires the gateway token like every other route (audit C7).
            headers: gatewayHeaders({}, true),
            body: formData,
            timeout: isPartial ? 6000 : 15000
          })
        const res = isPartial ? await doFetch() : await withRetry(doFetch)
        if (!res.ok) return { text: '' }
        const data = await res.json() as { text?: string; language?: string }
        const text = data.text || ''
        if (isWhisperPromptHallucination(text)) {
          if (is.dev) console.log('[Main-STT] Discarded Whisper prompt hallucination:', text)
          return { text: '' }
        }
        return { text, language: data.language }
      } catch (err: unknown) {
        // Log dropped partials temporarily for debugging
        console.error('[Gateway] transcribe-only partial error:', err)
        if (isPartial) return { text: '' }
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
        // Ensure gateway token is fresh before every AI request
        await ensureFreshGatewayToken()
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
        if (res.headers.get('x-finish-reason') === 'length') {
          console.warn('[generate-answer] answer truncated by the token ceiling')
        }
        const content = data.choices?.[0]?.message?.content || ''
        console.log(`[AI-LLM] Answer received (${content.length} chars)`)
        return content || 'No response.'
      } catch (err: unknown) {
        console.error('[Gateway] generate-answer error:', err)
        throw err
      }
    }
  )

  const STREAM_FIRST_BYTE_MS = 20000
  const STREAM_IDLE_MS = 12000
  const STREAM_FLUSH_MS = 50

  /** Shared by the streaming text path and the streaming screenshot path. */
  const VISION_USER_PROMPT =
    'Look at this screenshot. Identify ANY interview question visible (coding, MCQ, behavioral, HR, technical). Provide the answer the candidate should say out loud, per system prompt instructions.'

  /**
   * One SSE reader for every streaming gateway route. The text-answer path and the
   * screenshot path differ only in URL and body; everything downstream — <think>
   * stripping, 50ms coalesced flushes, first-byte/idle timeouts and the `answer-chunk`
   * contract — has to behave identically, so it lives here once.
   */
  async function streamGatewayCompletion(
    event: Electron.IpcMainInvokeEvent,
    opts: { requestId: string; path: string; body: unknown; firstByteMs?: number }
  ): Promise<string> {
    const { requestId } = opts
    const send = (payload: Record<string, unknown>): void => {
      if (!event.sender.isDestroyed()) event.sender.send('answer-chunk', { requestId, ...payload })
    }

    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), opts.firstByteMs ?? STREAM_FIRST_BYTE_MS)
    const bumpIdle = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), STREAM_IDLE_MS)
    }

    // `raw` is what Groq sent; `visible` is what the user may see. They differ whenever
    // a <think> block is open, which is why only the sanitized text is ever sent.
    let raw = ''
    let lastSent = ''
    let flushTimer: NodeJS.Timeout | null = null

    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const visible = stripThinkBlocks(raw)
      if (visible === lastSent) return
      lastSent = visible
      send({ full: visible, done: false })
    }
    const scheduleFlush = (): void => {
      if (!flushTimer) flushTimer = setTimeout(flush, STREAM_FLUSH_MS)
    }
    try {
      await ensureFreshGatewayToken()
      const res = await fetch(`${AI_GATEWAY}${opts.path}`, {
        method: 'POST',
        headers: gatewayHeaders(),
        signal: controller.signal,
        body: JSON.stringify(opts.body)
      })

      if (!res.ok || !res.body) {
        clearTimeout(timer)
        send({ done: true, error: `Gateway ${res.status}`, full: '' })
        return ''
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false

      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        bumpIdle()
        buffer += decoder.decode(value, { stream: true })

        const drained = drainSseEvents(buffer)
        buffer = drained.rest

        for (const frame of drained.events) {
          if (frame === SSE_DONE) {
            finished = true
            break
          }
          // extractDelta reads delta.content only — a reasoning delta adds nothing.
          raw += extractDelta(frame)
        }
        scheduleFlush()
      }

      clearTimeout(timer)
      if (flushTimer) clearTimeout(flushTimer)
      const finalVisible = stripThinkBlocks(raw)
      send({ done: true, full: finalVisible })
      return finalVisible
    } catch (e: unknown) {
      clearTimeout(timer)
      if (flushTimer) clearTimeout(flushTimer)
      const err = e as { name?: string; message?: string }
      const aborted = err?.name === 'AbortError'
      const partial = stripThinkBlocks(raw)
      send({ done: true, error: aborted ? 'stream timed out' : String(err?.message || e), full: partial })
      return partial
    }
  }

  ipcMain.handle('generate-answer-stream', async (event, data) =>
    streamGatewayCompletion(event, {
      requestId: data.requestId,
      path: '/gateway/llm',
      body: {
        stream: true,
        model: data.model || 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: data.systemPrompt },
          { role: 'user', content: data.transcript }
        ],
        temperature: data.temperature ?? 0.65,
        max_completion_tokens: data.maxTokens ?? 1024,
        presence_penalty: data.presencePenalty ?? 0.4,
        frequency_penalty: data.frequencyPenalty ?? 0.4
      }
    })
  )

  // Streaming screenshot analysis. Same channel and same requestId contract as the text
  // path, so the renderer reuses onAnswerChunk untouched. The screenshot itself still
  // comes from `capture-screenshot` (stealth micro-blink) in the renderer.
  ipcMain.handle('analyze-screen-stream', async (event, data) =>
    streamGatewayCompletion(event, {
      requestId: data.requestId,
      path: '/gateway/vision',
      // Image prefill is heavier than text, so the first token needs more headroom than
      // the 20s text default before the abort fires.
      firstByteMs: 25000,
      body: {
        stream: true,
        max_completion_tokens: data.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: data.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: data.userPrompt || VISION_USER_PROMPT },
              { type: 'image_url', image_url: { url: data.base64Image } }
            ]
          }
        ]
      }
    })
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

      await ensureFreshGatewayToken()
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
                  // Same constant the streaming path sends, so the buffered fallback can
                  // never drift into asking for a differently-shaped answer.
                  { type: 'text', text: VISION_USER_PROMPT },
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
            max_tokens: 256,
            // Extraction, not generation: the gateway's 0.6 answer default would
            // paraphrase the question instead of transcribing it.
            temperature: 0.2
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

  ipcMain.on('toggle-compact', (_event, _minimized: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
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

  ipcMain.handle('install-update', async (): Promise<boolean> => {
    // H7: quitting and installing is destructive — the renderer can trigger it,
    // so the decision is confirmed by the user in a native dialog, not in page JS.
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const options = {
      type: 'question' as const,
      buttons: ['Install & Relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Zyro AI',
      message: 'A new version has been downloaded.',
      detail: 'The app will close and relaunch with the new version. Finish anything you are doing first.'
    }
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) {
      console.log('[Updater] User deferred the update install')
      return false
    }
    console.log('[Updater] User confirmed install — quitting and installing...')
    // isSilent=true, isForceRunAfter=true → relaunches app after install
    autoUpdater.quitAndInstall(true, true)
    return true
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
    if (typeof url === 'string') safeOpenExternal(url)
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
