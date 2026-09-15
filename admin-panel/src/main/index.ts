import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../build/icon.png?asset'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

// Prevent multiple instances from running simultaneously and locking the Chromium cache
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}

// Load .env from project root (dev) or a per-machine location (prod).
// SECURITY (audit C2): the packaged app must NOT ship a .env inside its
// resources — that practice leaked the service_role key in distributed
// installers. Operators place credentials at userData/.env on each machine
// instead; if neither location has them, fail with instructions.
const envPath = is.dev ? resolve(__dirname, '../../.env') : resolve(app.getPath('userData'), '.env')
console.log('[Main] Loading .env from:', envPath)
dotenvConfig({ path: envPath })

// ─── Supabase client (service role — main process only) ───────────────────────
let supabaseInstance: ReturnType<typeof createClient> | null = null

function getSupabase() {
  if (supabaseInstance) return supabaseInstance

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  console.log('[Main] Initializing Supabase client...')
  if (!url || !key) {
    console.error('[Main] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env')
  }
  supabaseInstance = createClient(url, key)
  return supabaseInstance
}

// ─── Admin session gate (audit H6) ───────────────────────────────────────────
// The renderer logs in with Supabase and hands its JWT to main via
// `admin:set-session`. Main verifies the account really is an admin (against
// the service-role client, so a tampered renderer can't self-promote) and
// holds the session; every privileged IPC handler below refuses to run
// without one. This means an XSS or injected script in the renderer can no
// longer drive the service-role client directly.
let adminSession: { token: string; expiresAt: number } | null = null

ipcMain.handle('admin:set-session', async (_event, token: unknown) => {
  if (typeof token !== 'string' || token.length < 20) {
    throw new Error('Invalid session token')
  }
  // Verify the token with Supabase auth — identity comes from the server, never
  // from renderer-supplied claims.
  const url = process.env.SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL not set')
  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!userRes.ok) {
    throw new Error('Session token rejected')
  }
  // is_admin check via the service-role client — RLS can't be trusted here
  // because this client bypasses it by design.
  const supabase = getSupabase()
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', (await userRes.json()).id)
    .single()
  if (error || !profile?.is_admin) {
    console.warn('[Main] admin:set-session refused: account is not an admin')
    throw new Error('This account does not have admin permissions.')
  }
  // Read the JWT exp so the gate expires with the session itself.
  let expiresAt = Math.floor(Date.now() / 1000) + 3600
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
    if (typeof payload.exp === 'number') expiresAt = payload.exp
  } catch {
    /* default 1h above */
  }
  adminSession = { token, expiresAt }
  console.log(
    '[Main] Admin session established (expires',
    new Date(expiresAt * 1000).toISOString(),
    ')'
  )
  return { ok: true }
})

ipcMain.handle('admin:clear-session', () => {
  adminSession = null
  console.log('[Main] Admin session cleared')
})

function requireAdminSession(): void {
  if (!adminSession) {
    throw new Error('Not authenticated — admin session required')
  }
  if (Date.now() / 1000 >= adminSession.expiresAt) {
    adminSession = null
    throw new Error('Admin session expired — log in again')
  }
}

// ── External URL policy (audit H2) ──
// Only https to a fixed set of hosts ever reaches the OS — file://, smb:// and
// search-ms: handlers are what make unrestricted openExternal dangerous.
const EXTERNAL_URL_HOSTS = new Set(['www.zyro-ai.in', 'zyro-ai.in'])

function safeOpenExternal(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !EXTERNAL_URL_HOSTS.has(parsed.hostname)) {
      console.warn(`[Main] Blocked external URL: ${parsed.protocol}//${parsed.hostname}`)
      return false
    }
    shell.openExternal(parsed.toString())
    return true
  } catch {
    console.warn('[Main] Blocked malformed external URL')
    return false
  }
}

// ─── Admin DB IPC Handlers (all use service role) ────────────────────────────

// Fetch all profiles
ipcMain.handle('admin:list-profiles', async () => {
  requireAdminSession()
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, email, full_name, sessions_balance, phone_sessions_balance, trial_seconds_used, is_admin, created_at, updated_at'
    )
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
})

// Fetch all staff permissions
ipcMain.handle('admin:list-staff-permissions', async () => {
  requireAdminSession()
  const supabase = getSupabase()
  const { data, error } = await supabase.from('staff_permissions').select('*')
  if (error) throw new Error(error.message)
  return data ?? []
})

// Upsert staff permission
ipcMain.handle('admin:upsert-staff-permission', async (_event, perm: Record<string, unknown>) => {
  requireAdminSession()
  const supabase = getSupabase()
  const { error } = await supabase
    .from('staff_permissions')
    .upsert(perm, { onConflict: 'staff_id' })
  if (error) throw new Error(error.message)
  return { success: true }
})

// Delete staff permission
ipcMain.handle('admin:delete-staff-permission', async (_event, staffId: string) => {
  requireAdminSession()
  const supabase = getSupabase()
  const { error } = await supabase.from('staff_permissions').delete().eq('staff_id', staffId)
  if (error) throw new Error(error.message)
  return { success: true }
})

// Delete profile
ipcMain.handle('admin:delete-profile', async (_event, userId: string) => {
  requireAdminSession()
  const supabase = getSupabase()
  const { error } = await supabase.from('profiles').delete().eq('id', userId)
  if (error) throw new Error(error.message)
  return { success: true }
})

// Delete auth user (admin)
ipcMain.handle('admin:delete-auth-user', async (_event, userId: string) => {
  requireAdminSession()
  const supabase = getSupabase()
  const { error } = await supabase.auth.admin.deleteUser(userId)
  if (error) throw new Error(error.message)
  return { success: true }
})

// Fetch support tickets
ipcMain.handle('admin:list-tickets', async () => {
  requireAdminSession()
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
})

// Delete support ticket (and its messages)
ipcMain.handle('admin:delete-ticket', async (_event, ticketId: string) => {
  requireAdminSession()
  const supabase = getSupabase()
  await supabase.from('ticket_messages').delete().eq('ticket_id', ticketId).catch(console.warn)
  const { error } = await supabase.from('support_tickets').delete().eq('id', ticketId)
  if (error) throw new Error(error.message)
  return { success: true }
})

// Update user balance (sessions or phone sessions)
ipcMain.handle(
  'admin:update-user-balance',
  async (_event, { userId, field, value }: { userId: string; field: string; value: number }) => {
    requireAdminSession()
    const supabase = getSupabase()
    const { error } = await supabase
      .from('profiles')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('id', userId)
    if (error) throw new Error(error.message)
    return { success: true }
  }
)

// Send in-app notification to user
ipcMain.handle(
  'admin:send-user-notification',
  async (
    _event,
    {
      userId,
      title,
      message,
      type = 'session_credit',
      metadata = {}
    }: {
      userId: string
      title: string
      message: string
      type?: string
      metadata?: Record<string, unknown>
    }
  ) => {
    requireAdminSession()
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title: title.trim(),
        message: message.trim(),
        type,
        metadata,
        is_read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  }
)

// List notifications (admin overview or per user)
ipcMain.handle('admin:list-notifications', async (_event, userId?: string) => {
  requireAdminSession()
  const supabase = getSupabase()
  try {
    let query = supabase
      .from('notifications')
      .select('*, profiles:user_id(email, full_name)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (userId) query = query.eq('user_id', userId)
    const { data, error } = await query
    if (error) throw error
    return data ?? []
  } catch (_e) {
    let query = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (userId) query = query.eq('user_id', userId)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return data ?? []
  }
})

// ─── Coupon IPC handlers (Supabase-only, no Razorpay API needed) ─────────────
// Discounts are calculated server-side in razorpay-create-order edge function.
// The admin panel only manages the coupons table in Supabase.

// Create a coupon record in Supabase
ipcMain.handle(
  'stripe:create', // keep same IPC channel name so renderer doesn't need changes
  async (
    _event,
    opts: {
      code: string
      type: 'percent' | 'fixed'
      discountValue: number
      maxUses: number | null
      expiresAt: string | null
      description: string | null
      limitPerUser: boolean
      allowedPlans?: string[]
    }
  ) => {
    requireAdminSession()
    const supabase = getSupabase()

    // Upsert coupon into Supabase coupons table
    const { data, error } = await supabase
      .from('coupons')
      .insert({
        code: opts.code.trim().toUpperCase(),
        type: opts.type,
        discount_value: opts.discountValue,
        max_uses: opts.maxUses,
        expires_at: opts.expiresAt,
        description: opts.description,
        once_per_user: opts.limitPerUser,
        allowed_plans: opts.allowedPlans ?? [],
        is_active: true,
        used_count: 0
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)

    // Return shape matching what CouponsPage renderer expects
    return { couponId: data.id, promoId: data.id }
  }
)

// Update a coupon record in Supabase
ipcMain.handle(
  'stripe:update',
  async (
    _event,
    opts: {
      id: string
      code: string
      type: 'percent' | 'fixed'
      discountValue: number
      maxUses: number | null
      expiresAt: string | null
      description: string | null
      limitPerUser: boolean
      allowedPlans?: string[]
    }
  ) => {
    requireAdminSession()
    const supabase = getSupabase()

    const { error } = await supabase
      .from('coupons')
      .update({
        code: opts.code.trim().toUpperCase(),
        type: opts.type,
        discount_value: opts.discountValue,
        max_uses: opts.maxUses,
        expires_at: opts.expiresAt,
        description: opts.description,
        once_per_user: opts.limitPerUser,
        allowed_plans: opts.allowedPlans ?? []
      })
      .eq('id', opts.id)

    if (error) throw new Error(error.message)
    return { success: true }
  }
)

// Delete a coupon from Supabase (by supabase row id stored as stripeCouponId)
ipcMain.handle('stripe:delete', async (_event, opts: { stripeCouponId: string }) => {
  requireAdminSession()
  if (!opts.stripeCouponId) return
  const supabase = getSupabase()
  const { error } = await supabase.from('coupons').delete().eq('id', opts.stripeCouponId)
  if (error) throw new Error(error.message)
})

// Enable or disable a coupon (stripePromoId = supabase row id)
ipcMain.handle(
  'stripe:set-active',
  async (_event, opts: { stripePromoId: string; active: boolean }) => {
    requireAdminSession()
    if (!opts.stripePromoId) return
    const supabase = getSupabase()
    const { error } = await supabase
      .from('coupons')
      .update({ is_active: opts.active })
      .eq('id', opts.stripePromoId)
    if (error) throw new Error(error.message)
  }
)

// List all coupons
ipcMain.handle('stripe:list-coupons', async () => {
  requireAdminSession()
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
})

// List redemptions: reads from Supabase transactions table, joined with profiles
ipcMain.handle('stripe:list-redemptions', async () => {
  requireAdminSession()
  const supabase = getSupabase()

  // Fetch redemptions with user details from the profiles table
  const { data, error } = await supabase
    .from('transactions')
    .select(
      `
      id, 
      amount, 
      currency, 
      coupon_code, 
      discount_amount, 
      created_at, 
      status, 
      plan_name, 
      razorpay_order_id,
      profiles (
        full_name,
        email
      )
    `
    )
    .eq('status', 'completed')
    .not('coupon_code', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw new Error(error.message)

  return (data ?? []).map((tx: any) => ({
    id: tx.razorpay_order_id ?? tx.id,
    email: tx.profiles?.email || 'N/A',
    name: tx.profiles?.full_name || 'Customer',
    couponCode: tx.coupon_code,
    amountOff: Number(tx.discount_amount ?? 0),
    paidAmount: Number(tx.amount ?? 0),
    planName: tx.plan_name || 'standard',
    currency: tx.currency ?? 'inr',
    createdAt: tx.created_at,
    status: tx.status
  }))
})
// ─────────────────────────────────────────────────────────────────────────────

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Zyro Admin Panel',
    icon,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  ipcMain.on('reload-window', (event) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    win?.reload()
  })

  ipcMain.on('close-window', (event) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    win?.close()
  })

  ipcMain.on('open-external', (_event, url) => {
    safeOpenExternal(url)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // No logout UI exists — window close is the only exit, so drop the session
  // gate with it (reopening demands a fresh login).
  mainWindow.on('closed', () => {
    adminSession = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // H2: deny-by-default — only https to allowlisted hosts may reach the OS
    safeOpenExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    console.log('[Main] Loading URL:', process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    console.log('[Main] Loading Fallback HTML')
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason)
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.zyro.adminpanel')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
