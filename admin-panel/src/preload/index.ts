import { contextBridge, ipcRenderer } from 'electron'

// Minimal preload – renderer uses Supabase JS directly (desktop-only admin tool)
contextBridge.exposeInMainWorld('adminEnv', {
  supabaseUrl: process.env.SUPABASE_URL ?? 'https://wzazigashanttpqbrfod.supabase.co',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'zyro-admin-2025'
})

contextBridge.exposeInMainWorld('api', {
  reloadWindow: () => ipcRenderer.send('reload-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url)
})

// Stripe API — secret key stays in main process, never exposed to renderer
contextBridge.exposeInMainWorld('stripeApi', {
  create: (opts: {
    code: string
    type: 'percent' | 'fixed'
    discountValue: number
    maxUses: number | null
    expiresAt: string | null
    description: string | null
  }) => ipcRenderer.invoke('stripe:create', opts),

  update: (opts: {
    id: string
    code: string
    type: 'percent' | 'fixed'
    discountValue: number
    maxUses: number | null
    expiresAt: string | null
    description: string | null
    limitPerUser: boolean
    allowedPlans?: string[]
  }) => ipcRenderer.invoke('stripe:update', opts),

  delete: (opts: { stripeCouponId: string }) => ipcRenderer.invoke('stripe:delete', opts),

  setActive: (opts: { stripePromoId: string; active: boolean }) =>
    ipcRenderer.invoke('stripe:set-active', opts),

  listRedemptions: () => ipcRenderer.invoke('stripe:list-redemptions'),

  syncUsages: () => ipcRenderer.invoke('stripe:sync-usages')
})
