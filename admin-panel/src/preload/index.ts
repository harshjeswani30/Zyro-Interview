import { contextBridge, ipcRenderer } from 'electron'

// Only expose the non-secret public URL to the renderer.
// service_role key and admin password are NEVER sent to the renderer —
// all privileged DB operations go through IPC handlers in main (where the key lives).
contextBridge.exposeInMainWorld('adminEnv', {
  supabaseUrl: process.env.SUPABASE_URL ?? 'https://weqwxoihdfsvjwwcgtat.supabase.co',
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

  listCoupons: () => ipcRenderer.invoke('stripe:list-coupons'),

  syncUsages: () => ipcRenderer.invoke('stripe:sync-usages')
})

// Admin DB API — all operations use service role key in main process
contextBridge.exposeInMainWorld('adminDb', {
  listProfiles: () => ipcRenderer.invoke('admin:list-profiles'),
  listStaffPermissions: () => ipcRenderer.invoke('admin:list-staff-permissions'),
  upsertStaffPermission: (perm: Record<string, unknown>) => ipcRenderer.invoke('admin:upsert-staff-permission', perm),
  deleteStaffPermission: (staffId: string) => ipcRenderer.invoke('admin:delete-staff-permission', staffId),
  deleteProfile: (userId: string) => ipcRenderer.invoke('admin:delete-profile', userId),
  deleteAuthUser: (userId: string) => ipcRenderer.invoke('admin:delete-auth-user', userId),
  listTickets: () => ipcRenderer.invoke('admin:list-tickets'),
  deleteTicket: (ticketId: string) => ipcRenderer.invoke('admin:delete-ticket', ticketId),
  updateUserBalance: (opts: { userId: string; field: string; value: number }) => ipcRenderer.invoke('admin:update-user-balance', opts),
  sendUserNotification: (opts: { userId: string; title: string; message: string; type?: string; metadata?: Record<string, unknown> }) =>
    ipcRenderer.invoke('admin:send-user-notification', opts),
  listNotifications: (userId?: string) => ipcRenderer.invoke('admin:list-notifications', userId)
})
