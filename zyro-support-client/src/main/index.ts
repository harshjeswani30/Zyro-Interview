import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../build/icon.png?asset'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

// Load .env from project root (dev) or a per-machine location (prod).
// SECURITY (audit C2): the packaged app must NOT ship a .env inside its
// resources — that practice leaked the service_role key in distributed
// installers. Operators place credentials at userData/.env on each machine
// instead; if neither location has them, fail with instructions.
const envPath = is.dev
  ? resolve(__dirname, '../../.env')
  : resolve(app.getPath('userData'), '.env')
console.log('[Main] Loading .env from:', envPath)
dotenvConfig({ path: envPath })

// ─── Supabase client (service role — main process only) ───────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  console.log('[Main] Validating Supabase config...')
  if (!url || !key) {
    console.error('[Main] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env')
  }
  return createClient(url, key)
}

// ─── Coupon IPC handlers (Supabase-only, no Razorpay API needed) ─────────────
// Discounts are calculated server-side in razorpay-create-order edge function.
// The admin panel only manages the coupons table in Supabase.

// Create a coupon record in Supabase
ipcMain.handle(
  'stripe:create',   // keep same IPC channel name so renderer doesn't need changes
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
    const supabase = getSupabase()

    // Upsert coupon into Supabase coupons table
    const { data, error } = await supabase
      .from('coupons')
      .insert({
        code:           opts.code.trim().toUpperCase(),
        type:           opts.type,
        discount_value: opts.discountValue,
        max_uses:       opts.maxUses,
        expires_at:     opts.expiresAt,
        description:    opts.description,
        once_per_user:  opts.limitPerUser,
        allowed_plans:  opts.allowedPlans ?? [],
        is_active:      true,
        used_count:     0,
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
    const supabase = getSupabase()

    const { error } = await supabase
      .from('coupons')
      .update({
        code:           opts.code.trim().toUpperCase(),
        type:           opts.type,
        discount_value: opts.discountValue,
        max_uses:       opts.maxUses,
        expires_at:     opts.expiresAt,
        description:    opts.description,
        once_per_user:  opts.limitPerUser,
        allowed_plans:  opts.allowedPlans ?? [],
      })
      .eq('id', opts.id)

    if (error) throw new Error(error.message)
    return { success: true }
  }
)

// Delete a coupon from Supabase (by supabase row id stored as stripeCouponId)
ipcMain.handle('stripe:delete', async (_event, opts: { stripeCouponId: string }) => {
  if (!opts.stripeCouponId) return
  const supabase = getSupabase()
  const { error } = await supabase
    .from('coupons')
    .delete()
    .eq('id', opts.stripeCouponId)
  if (error) throw new Error(error.message)
})

// Enable or disable a coupon (stripePromoId = supabase row id)
ipcMain.handle(
  'stripe:set-active',
  async (_event, opts: { stripePromoId: string; active: boolean }) => {
    if (!opts.stripePromoId) return
    const supabase = getSupabase()
    const { error } = await supabase
      .from('coupons')
      .update({ is_active: opts.active })
      .eq('id', opts.stripePromoId)
    if (error) throw new Error(error.message)
  }
)

// List redemptions: reads from Supabase transactions table, joined with profiles
ipcMain.handle('stripe:list-redemptions', async () => {
  const supabase = getSupabase()

  // Fetch redemptions with user details from the profiles table
  const { data, error } = await supabase
    .from('transactions')
    .select(`
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
    `)
    .eq('status', 'completed')
    .not('coupon_code', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw new Error(error.message)

  return (data ?? []).map((tx: any) => ({
    id:          tx.razorpay_order_id ?? tx.id,
    email:       tx.profiles?.email || 'N/A',
    name:        tx.profiles?.full_name || 'Customer',
    couponCode:  tx.coupon_code,
    amountOff:   Number(tx.discount_amount ?? 0),
    paidAmount:  Number(tx.amount ?? 0),
    planName:    tx.plan_name || 'standard',
    currency:    tx.currency ?? 'inr',
    createdAt:   tx.created_at,
    status:      tx.status,
  }))
})
// ─────────────────────────────────────────────────────────────────────────────
// ── Staff-desk IPC handlers (audit C3/C10) ────────────────────────────────────
// The service-role client never leaves the main process. The renderer gets
// fixed-shape operations only — no generic query passthrough, no key exposure.
// NOTE (audit C10): there is deliberately NO handler that creates staff
// accounts or inserts staff_permissions rows for a new signup — staff are
// provisioned by an admin in the admin panel.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const isEmail = (v: unknown): v is string =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

// Email+password login for the staff member (runs in main so the renderer
// never needs the service key; returns the user's own session).
ipcMain.handle(
  'staff:login',
  async (_event, opts: { email: string; password: string }) => {
    if (!isEmail(opts?.email) || typeof opts?.password !== 'string' || !opts.password) {
      throw new Error('Invalid credentials')
    }
    const supabase = getSupabase()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: opts.email.trim().toLowerCase(),
      password: opts.password
    })
    if (error) throw new Error(error.message)
    return { user: data.user, session: data.session }
  }
)

// Load the staff member's own permission row (by staff_id, healing by email).
ipcMain.handle('staff:get-permissions', async (_event, staffId: string, email?: string) => {
  if (!isUuid(staffId)) throw new Error('Invalid staff id')
  const supabase = getSupabase()

  const { data: byId } = await supabase
    .from('staff_permissions')
    .select('*')
    .eq('staff_id', staffId)
    .maybeSingle()

  if (byId) return byId

  // Heal-by-email: the row may predate the staff member's auth id.
  if (isEmail(email)) {
    const normalized = email.toLowerCase().trim()
    const { data: byEmail } = await supabase
      .from('staff_permissions')
      .select('id, staff_id')
      .ilike('staff_email', normalized)
      .maybeSingle()

    if (byEmail) {
      const { data: healed } = await supabase
        .from('staff_permissions')
        .update({ staff_id: staffId, updated_at: new Date().toISOString() })
        .eq('id', byEmail.id)
        .select('*')
        .maybeSingle()
      return healed ?? null
    }
  }
  return null
})

// List support tickets for the given categories (only the staff member's
// permitted categories should be passed; main trusts the caller's list but
// the shape is fixed — read-only).
ipcMain.handle(
  'staff:list-tickets',
  async (_event, categories: string[]) => {
    if (
      !Array.isArray(categories) ||
      categories.length === 0 ||
      categories.some((c) => typeof c !== 'string')
    ) {
      throw new Error('Invalid categories')
    }
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .in('category', categories)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  }
)

// Fetch the message thread of one ticket.
ipcMain.handle('staff:get-ticket-messages', async (_event, ticketId: string) => {
  if (!isUuid(ticketId)) throw new Error('Invalid ticket id')
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('ticket_messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
})

// Insert a staff reply into a ticket thread.
ipcMain.handle(
  'staff:send-ticket-reply',
  async (
    _event,
    opts: {
      ticketId: string
      senderId: string
      senderEmail: string
      message: string
    }
  ) => {
    if (!isUuid(opts?.ticketId) || !isUuid(opts?.senderId)) throw new Error('Invalid ids')
    if (!isEmail(opts?.senderEmail)) throw new Error('Invalid sender email')
    if (typeof opts?.message !== 'string' || !opts.message.trim() || opts.message.length > 8000) {
      throw new Error('Invalid message')
    }
    const supabase = getSupabase()
    const { error } = await supabase.from('ticket_messages').insert({
      ticket_id: opts.ticketId,
      sender_id: opts.senderId,
      sender_email: opts.senderEmail.trim().toLowerCase(),
      sender_type: 'staff',
      message: opts.message.trim()
    })
    if (error) throw new Error(error.message)
    return { success: true }
  }
)

// Update a ticket's status/assignment. Fields are whitelisted; status is
// validated; assignment stays an email.
ipcMain.handle(
  'staff:update-ticket',
  async (
    _event,
    opts: {
      ticketId: string
      status?: string
      assignedStaffEmail?: string | null
      resolvedByEmail?: string | null
    }
  ) => {
    if (!isUuid(opts?.ticketId)) throw new Error('Invalid ticket id')
    const allowedStatus = ['open', 'in_progress', 'resolved', 'closed']
    if (opts.status !== undefined && !allowedStatus.includes(opts.status)) {
      throw new Error('Invalid status')
    }
    if (
      opts.assignedStaffEmail !== undefined &&
      opts.assignedStaffEmail !== null &&
      !isEmail(opts.assignedStaffEmail)
    ) {
      throw new Error('Invalid assigned email')
    }
    if (opts.resolvedByEmail !== undefined && opts.resolvedByEmail !== null && !isEmail(opts.resolvedByEmail)) {
      throw new Error('Invalid resolver email')
    }
    const supabase = getSupabase()
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (opts.status !== undefined) payload.status = opts.status
    if (opts.assignedStaffEmail !== undefined) payload.assigned_staff_email = opts.assignedStaffEmail
    if (opts.resolvedByEmail !== undefined) payload.resolved_by_email = opts.resolvedByEmail

    const { error } = await supabase
      .from('support_tickets')
      .update(payload)
      .eq('id', opts.ticketId)
    if (error) throw new Error(error.message)
    return { success: true }
  }
)

// Delete a ticket and its message thread (spam removal).
ipcMain.handle('staff:delete-ticket', async (_event, ticketId: string) => {
  if (!isUuid(ticketId)) throw new Error('Invalid ticket id')
  const supabase = getSupabase()
  const { error: msgErr } = await supabase
    .from('ticket_messages')
    .delete()
    .eq('ticket_id', ticketId)
  if (msgErr) throw new Error(msgErr.message)

  const { error } = await supabase.from('support_tickets').delete().eq('id', ticketId)
  if (error) throw new Error(error.message)
  return { success: true }
})

// Invoke a ticket-email edge function (send-ticket-reply notification).
// Body shape is fixed; the function name is not caller-controlled.
// The caller's staff JWT is forwarded as a Bearer token — send-ticket-reply
// now verifies a real Supabase JWT + a staff_permissions row (audit C4), so
// the service key alone is no longer accepted.
ipcMain.handle(
  'staff:notify-ticket-email',
  async (
    _event,
    opts: {
      ticketId: string
      userEmail: string
      subject: string
      replyText: string
      isClosedOrResolved?: boolean
      staffJwt?: string
    }
  ) => {
    if (!isUuid(opts?.ticketId) || !isEmail(opts?.userEmail)) throw new Error('Invalid input')
    if (typeof opts?.replyText !== 'string' || opts.replyText.length > 8000) {
      throw new Error('Invalid reply text')
    }
    if (typeof opts?.staffJwt !== 'string' || opts.staffJwt.length < 50) {
      throw new Error('Missing staff session')
    }
    // Direct fetch (not supabase.functions.invoke): supabase-js may override a
    // caller-supplied Authorization header with the client's own key, which
    // send-ticket-reply now rejects. The staff JWT must reach the function.
    const supabaseUrl = process.env.SUPABASE_URL
    if (!supabaseUrl) throw new Error('SUPABASE_URL not configured')
    const res = await fetch(`${supabaseUrl}/functions/v1/send-ticket-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.staffJwt}`
      },
      body: JSON.stringify({
        ticketId: opts.ticketId,
        userEmail: opts.userEmail.trim().toLowerCase(),
        subject: typeof opts.subject === 'string' ? opts.subject.slice(0, 200) : '',
        replyText: opts.replyText,
        ...(opts.isClosedOrResolved ? { isClosedOrResolved: true } : {})
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `send-ticket-reply failed: ${res.status}`)
    }
    return { success: true }
  }
)
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

  ipcMain.on('minimize-window', (event) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    win?.minimize()
  })

  ipcMain.on('open-external', (_event, url) => {
    shell.openExternal(url)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
  electronApp.setAppUserModelId('com.zyro.supportclient')
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
