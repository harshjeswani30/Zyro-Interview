import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../build/icon.png?asset'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

// Load .env from project root (dev) or app resources (prod)
const envPath = is.dev ? resolve(__dirname, '../../.env') : resolve(process.resourcesPath, '.env')
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
