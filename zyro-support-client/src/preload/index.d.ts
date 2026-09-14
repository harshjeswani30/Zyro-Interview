export interface AdminEnv {
  supabaseUrl: string
  supabaseAnonKey: string
}

export interface StaffSessionUser {
  id: string
  email?: string
}

export interface StaffApi {
  login: (opts: { email: string; password: string }) => Promise<{
    user: StaffSessionUser
    session: {
      access_token: string
      refresh_token: string
      expires_at?: number
      expires_in?: number
      token_type?: string
      user: unknown
    }
  }>
  getPermissions: (staffId: string, email?: string) => Promise<StaffPermissionRow | null>
  listTickets: (categories: string[]) => Promise<TicketRow[]>
  getTicketMessages: (ticketId: string) => Promise<TicketMessageRow[]>
  sendTicketReply: (opts: {
    ticketId: string
    senderId: string
    senderEmail: string
    message: string
  }) => Promise<{ success: boolean }>
  updateTicket: (opts: {
    ticketId: string
    status?: string
    assignedStaffEmail?: string | null
    resolvedByEmail?: string | null
  }) => Promise<{ success: boolean }>
  deleteTicket: (ticketId: string) => Promise<{ success: boolean }>
  notifyTicketEmail: (opts: {
    ticketId: string
    userEmail: string
    subject: string
    replyText: string
    isClosedOrResolved?: boolean
    staffJwt?: string
  }) => Promise<{ success: boolean }>
}

export interface StaffPermissionRow {
  id?: string
  staff_id: string
  staff_email: string
  can_access_general: boolean
  can_access_payment: boolean
  can_access_feature_request: boolean
}

export interface TicketRow {
  id: string
  user_email: string
  category: 'general' | 'payment' | 'feature_request'
  subject: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  created_at: string
  updated_at: string
  assigned_staff_email?: string | null
  resolved_by_email?: string | null
}

export interface TicketMessageRow {
  id: string
  ticket_id: string
  sender_email: string
  sender_type: 'user' | 'staff' | 'admin'
  message: string
  created_at: string
}

export interface StripeApi {
  create: (opts: {
    code: string
    type: 'percent' | 'fixed'
    discountValue: number
    maxUses: number | null
    expiresAt: string | null
    description: string | null
    limitPerUser: boolean
  }) => Promise<{ couponId: string; promoId: string }>
  delete: (opts: { stripeCouponId: string }) => Promise<void>
  setActive: (opts: { stripePromoId: string; active: boolean }) => Promise<void>
  listRedemptions: () => Promise<{
    id: string
    email: string
    name: string
    couponCode: string
    amountOff: number
    currency: string
    createdAt: string
    status: string
  }[]>
  syncUsages: () => Promise<{ code: string; usedCount: number }[]>
}

declare global {
  interface Window {
    adminEnv: AdminEnv
    staffApi: StaffApi
    stripeApi: StripeApi
    api: {
      reloadWindow: () => void
      closeWindow: () => void
      openExternal: (url: string) => void
    }
  }
}
