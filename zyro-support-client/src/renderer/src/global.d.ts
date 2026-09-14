export {}

declare global {
  interface Window {
    // SECURITY (audit C3): the service-role key and admin password are no
    // longer part of the renderer surface. See src/preload/index.d.ts for the
    // authoritative window typings.
    adminEnv: {
      supabaseUrl: string
      supabaseAnonKey: string
    }
    staffApi: {
      login: (opts: { email: string; password: string }) => Promise<any>
      getPermissions: (staffId: string, email?: string) => Promise<any>
      listTickets: (categories: string[]) => Promise<any[]>
      getTicketMessages: (ticketId: string) => Promise<any[]>
      sendTicketReply: (opts: any) => Promise<{ success: boolean }>
      updateTicket: (opts: any) => Promise<{ success: boolean }>
      deleteTicket: (ticketId: string) => Promise<{ success: boolean }>
      notifyTicketEmail: (opts: any) => Promise<{ success: boolean }>
    }
    stripeApi: {
      create: (opts: any) => Promise<{ couponId: string; promoId: string }>
      delete: (opts: { stripeCouponId: string }) => Promise<void>
      setActive: (opts: { stripePromoId: string; active: boolean }) => Promise<void>
      listRedemptions: () => Promise<any[]>
      syncUsages: () => Promise<{ code: string; usedCount: number }[]>
    }
    api: {
      reloadWindow: () => void
      closeWindow: () => void
      minimizeWindow: () => void
      openExternal: (url: string) => void
    }
  }

  interface ImportMetaEnv {
    readonly MAIN_VITE_SUPABASE_URL: string
    readonly MAIN_VITE_SUPABASE_ANON_KEY: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}
