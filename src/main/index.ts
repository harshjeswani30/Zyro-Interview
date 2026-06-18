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
import icon from '../../resources/icon.png?asset'
import { loadSecureSession, storeSecureSession, clearSecureSession } from './secureStorage'
import { autoUpdater } from 'electron-updater'

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
const SUPABASE_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlcXd4b2loZGZzdmp3d2NndGF0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mjk3Mjk0OSwiZXhwIjoyMDg4NTQ4OTQ5fQ.Vwx6J3X1ffVocTAIpiFqbXaklYT8Nox8TW2zqT7M5Qg'

let supabaseAccessToken: string | null = null
let supabaseUserId: string | null = null

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
          supabaseUserId = userId
          storeSecureSession({ accessToken, userId })
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

  overlayWindow.setContentProtection(true)
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

  ipcMain.handle('get-session', () => pendingSessionData)

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
    console.log(`[Supabase] Restored session for user: ${supabaseUserId}`)
  }

  ipcMain.handle('start-interview', async (_event, sessionData: unknown) => {
    if (!supabaseUserId) throw new Error('Not logged in')
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}&select=sessions_balance,trial_seconds_used`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    const rows = await profileRes.json()
    const profile = rows?.[0]
    const balance = profile?.sessions_balance ?? 0
    const trialUsed = profile?.trial_seconds_used ?? 0
    const TRIAL_LIMIT = 600

    if (balance <= 0 && trialUsed >= TRIAL_LIMIT) {
      console.warn(
        `[Main] Blocked start-interview for ${supabaseUserId}: Balance 0, Trial exhausted.`
      )
      return { allowed: false, reason: 'insufficient_balance' }
    }

    const sessionDataWithProfile = {
      ...(sessionData as Record<string, unknown>),
      trial_seconds_used: trialUsed,
      sessions_balance: balance
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
        if (!overlayWindow!.isDestroyed()) overlayWindow!.show()
      })
    }

    // Prevent OS from suspending or throttling CPU while interview is active
    if (activeBlockerId === null) {
      activeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      console.log('[Main] Power save blocker started, ID:', activeBlockerId)
    }

    mainWindow?.hide()
    return { allowed: true }
  })

  ipcMain.on('end-interview', () => {
    pendingSessionData = null

    // Release only scroll shortcuts so global Alt+Space/Alt+S remain active
    const scrollKeys = ['num8', 'num2', 'num9', 'num3', 'num7', 'num1']
    scrollKeys.forEach((key) => globalShortcut.unregister(key))

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
    console.log(`[Supabase] Attempting login for: ${email}`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password })
    })
    console.log(`[Supabase] Login response status: ${res.status}`)
    const data = await res.json()
    if (!res.ok) {
      console.error(`[Supabase] Login failed:`, data)
      throw new Error(data.error_description || data.msg || 'Login failed')
    }
    console.log(`[Supabase] Login successful for user: ${data.user?.id}`)
    supabaseAccessToken = data.access_token
    supabaseUserId = data.user?.id
    storeSecureSession({
      accessToken: data.access_token,
      userId: data.user?.id
    })
    return { user: data.user, accessToken: data.access_token }
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
    console.log(`[Supabase] Verifying OTP for: ${phone}`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ type: 'sms', phone, token })
    })
    console.log(`[Supabase] Verify OTP response status: ${res.status}`)
    const data = await res.json()
    if (!res.ok) {
      console.error(`[Supabase] Verify OTP failed:`, data)
      throw new Error(data.error_description || data.msg || 'Verification failed')
    }
    console.log(`[Supabase] OTP verification successful for user: ${data.user?.id}`)
    supabaseAccessToken = data.access_token
    supabaseUserId = data.user?.id
    storeSecureSession({
      accessToken: data.access_token,
      userId: data.user?.id
    })
    return { user: data.user, accessToken: data.access_token }
  })

  ipcMain.handle('supabase-login-google', async () => {
    // Initiate OAuth directly via Supabase, but redirect back to our React web app
    // so we can show a nice "Success! You can close this tab" screen to avoid a hanging blank tab.
    const redirectUri = 'https://www.zyro-ai.in/auth/callback?is_desktop=true'
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`
    
    console.log('[Main] Opening Google login in browser via Supabase directly:', authUrl)
    shell.openExternal(authUrl)
  })

  ipcMain.on('supabase-manual-sync', (_e, { accessToken, userId }) => {
    console.log('[Main] Manually syncing session for user:', userId)
    supabaseAccessToken = accessToken
    supabaseUserId = userId
    storeSecureSession({ accessToken, userId })
  })

  ipcMain.handle('supabase-logout', async () => {
    if (supabaseAccessToken) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${supabaseAccessToken}` }
      })
    }
    supabaseAccessToken = null
    supabaseUserId = null
    clearSecureSession()
  })

  ipcMain.handle('supabase-get-profile', async () => {
    console.log(`[Supabase] Fetching profile for: ${supabaseUserId}`)
    if (!supabaseUserId || !supabaseAccessToken) {
      console.warn('[Supabase] No session found for profile fetch')
      return null
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}&select=*`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    })
    console.log(`[Supabase] Profile fetch status: ${res.status}`)
    let rows = await res.json()
    if (res.ok && rows.length === 0) {
      console.log(`[Supabase] Profile missing, initializing default for: ${supabaseUserId}`)
      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          id: supabaseUserId,
          sessions_balance: 0,
          trial_seconds_used: 0
        })
      })
      if (createRes.ok) {
        rows = await createRes.json()
        console.log('[Supabase] Profile initialized successfully')
      } else {
        const err = await createRes.json()
        console.error('[Supabase] Profile initialization failed:', err)
      }
    }
    if (res.ok) {
      console.log(`[Supabase] Profile data:`, rows?.[0])
    } else {
      console.error(`[Supabase] Profile fetch error:`, rows)
    }
    return rows?.[0] ?? null
  })

  ipcMain.handle('supabase-deduct-session', async () => {
    if (!supabaseUserId || !supabaseAccessToken) throw new Error('Not logged in')
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}&select=sessions_balance`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    const rows = await profileRes.json()
    const current = rows?.[0]?.sessions_balance ?? 0
    if (current <= 0) throw new Error('No sessions remaining')
    const newBalance = current - 1
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ sessions_balance: newBalance })
    })
    return { newBalance }
  })

  ipcMain.handle('supabase-deduct-phone-session', async () => {
    if (!supabaseUserId || !supabaseAccessToken) throw new Error('Not logged in')
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}&select=phone_sessions_balance`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    const rows = await profileRes.json()
    const current = rows?.[0]?.phone_sessions_balance ?? 0
    if (current <= 0) throw new Error('No sessions remaining')
    const newBalance = current - 1
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ phone_sessions_balance: newBalance })
    })
    return { newBalance }
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

  ipcMain.handle('supabase-update-trial', async (_e, seconds) => {
    console.log(`[Supabase] Updating trial for ${supabaseUserId}: ${seconds}s`)
    if (!supabaseUserId || !supabaseAccessToken) {
      console.warn('[Supabase] No session for trial update')
      return
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supabaseUserId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ trial_seconds_used: seconds })
    })
    console.log(`[Supabase] Update trial status: ${res.status}`)
    const data = await res.json()
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

  function gatewayHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Content-Type': 'application/json', ...extra }
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
        formData.append('language', language.split('-')[0])
        formData.append('prompt', 'Technical interview. IMPORTANT: Ignore background noise, silence, or music. Do NOT hallucinate words like "You", "Thank you", "Subscribe", "Subtitle". If no clear speech is detected, return an empty string.')

        const sttHeaders: Record<string, string> = {}
        console.log(`[AI-STT] Requesting transcription...`)
        const sttRes = await withRetry(() => 
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, { method: 'POST', headers: sttHeaders, body: formData })
        )
        const sttData = await sttRes.json() as { text?: string }
        console.log(`[AI-STT] Received: "${sttData.text?.substring(0, 50)}..."`)
        const transcript = sttData.text || ''
        if (!transcript) return { transcript: 'Audio captured', answer: 'Could not transcribe.' }

        const llmPayload = {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `TRANSCRIPT: ${transcript}\nRESUME: ${resumeText.substring(0, 3000)}` }
          ],
          temperature: 0.72,
          max_tokens: 400,
          response_format: { type: 'json_object' }
        }

        // Step 2: Generate answer via gateway LLM
        const llmRes = await withRetry(() => 
          fetchWithTimeout(`${AI_GATEWAY}/gateway/llm`, {
            method: 'POST',
            headers: gatewayHeaders(),
            body: JSON.stringify(llmPayload)
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
        formData.append('language', language.split('-')[0])
        
        const defaultPrompt = 'Technical interview. IMPORTANT: Ignore background noise, silence, or music. Do NOT hallucinate words like "You", "Thank you", "Subscribe", "Subtitle". If no clear speech is detected, return an empty string.'
        const finalPrompt = context 
          ? `${defaultPrompt} Context: ${context}`
          : defaultPrompt
        formData.append('prompt', finalPrompt.slice(-1000))

        const sttHeaders: Record<string, string> = {}
        const res = await withRetry(() => 
          fetchWithTimeout(`${AI_GATEWAY}/gateway/stt`, { method: 'POST', headers: sttHeaders, body: formData })
        )
        const data = await res.json() as { text?: string }
        return data.text || ''
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
              max_tokens: maxTokens ?? 280,
              presence_penalty: presencePenalty ?? 0.4,
              frequency_penalty: frequencyPenalty ?? 0.4
            })
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
        thumbnailSize: screen.getPrimaryDisplay().size
      })
      const primarySource = sources[0]
      if (!primarySource) throw new Error('No screen source found')
      const base64Image = primarySource.thumbnail.toDataURL()

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
            ]
          })
        })
      )
      const data = await res.json() as { choices?: { message?: { content?: string } }[] }
      return data.choices?.[0]?.message?.content || 'No content found on screen.'
    } catch (err: any) {
      console.error('[Gateway] analyze-screen error:', err)
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
    const deltaWidth = width - startWidth
    const deltaHeight = height - startHeight
    const startTime = Date.now()
    const durationMs = 650

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

      const currentX = Math.round(startBounds.x + (startBounds.width - currentWidth) / 2)
      const currentY = Math.round(startBounds.y + (startBounds.height - currentHeight) / 2)

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
    }, 20)
  })

  ipcMain.on('reload-window', (): void => mainWindow?.reload())
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
