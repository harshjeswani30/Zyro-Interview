import { contextBridge, ipcRenderer } from 'electron'

// SECURITY (audit C3): the service-role key and admin password are no longer
// exposed to the renderer — privileged DB operations run in the main process
// behind the fixed-shape `staffApi` / `stripeApi` IPC handlers below.
contextBridge.exposeInMainWorld('adminEnv', {
  supabaseUrl: process.env.SUPABASE_URL ?? 'https://wzazigashanttpqbrfod.supabase.co',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? ''
})

contextBridge.exposeInMainWorld('api', {
  reloadWindow: () => ipcRenderer.send('reload-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url)
})

// Staff-desk operations — main process holds the service-role client (audit C3).
contextBridge.exposeInMainWorld('staffApi', {
  login: (opts: { email: string; password: string }) =>
    ipcRenderer.invoke('staff:login', opts),
  getPermissions: (staffId: string, email?: string) =>
    ipcRenderer.invoke('staff:get-permissions', staffId, email),
  listTickets: (categories: string[]) =>
    ipcRenderer.invoke('staff:list-tickets', categories),
  getTicketMessages: (ticketId: string) =>
    ipcRenderer.invoke('staff:get-ticket-messages', ticketId),
  sendTicketReply: (opts: { ticketId: string; senderId: string; senderEmail: string; message: string }) =>
    ipcRenderer.invoke('staff:send-ticket-reply', opts),
  updateTicket: (opts: {
    ticketId: string
    status?: string
    assignedStaffEmail?: string | null
    resolvedByEmail?: string | null
  }) => ipcRenderer.invoke('staff:update-ticket', opts),
  deleteTicket: (ticketId: string) => ipcRenderer.invoke('staff:delete-ticket', ticketId),
  notifyTicketEmail: (opts: {
    ticketId: string
    userEmail: string
    subject: string
    replyText: string
    isClosedOrResolved?: boolean
    staffJwt?: string
  }) => ipcRenderer.invoke('staff:notify-ticket-email', opts)
})

// Stripe/coupon operations — main process only (unchanged surface).
contextBridge.exposeInMainWorld('stripeApi', {
  create: (opts: {
    code: string
    type: 'percent' | 'fixed'
    discountValue: number
    maxUses: number | null
    expiresAt: string | null
    description: string | null
    limitPerUser: boolean
    allowedPlans?: string[]
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
