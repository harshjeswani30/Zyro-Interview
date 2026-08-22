export {}

declare global {
  interface Window {
    // Current Electron-only properties (deprecated)
    adminEnv: {
      supabaseUrl: string
      supabaseServiceKey: string
      adminPassword: string
    }
    // Admin DB API exposed via Electron IPC
    adminDb: {
      listProfiles: () => Promise<any[]>
      listStaffPermissions: () => Promise<any[]>
      upsertStaffPermission: (perm: Record<string, unknown>) => Promise<{ success: boolean }>
      deleteStaffPermission: (staffId: string) => Promise<{ success: boolean }>
      deleteProfile: (userId: string) => Promise<{ success: boolean }>
      deleteAuthUser: (userId: string) => Promise<{ success: boolean }>
      listTickets: () => Promise<any[]>
      deleteTicket: (ticketId: string) => Promise<{ success: boolean }>
      updateUserBalance: (opts: { userId: string; field: string; value: number }) => Promise<{ success: boolean }>
      sendUserNotification: (opts: { userId: string; title: string; message: string; type?: string; metadata?: Record<string, unknown> }) => Promise<any>
      listNotifications: (userId?: string) => Promise<any[]>
    }
    // Stripe API exposed via Electron IPC
    stripeApi: {
      create: (opts: any) => Promise<{ couponId: string; promoId: string }>
      update: (opts: any) => Promise<{ success: boolean }>
      delete: (opts: { stripeCouponId: string }) => Promise<void>
      setActive: (opts: { stripePromoId: string; active: boolean }) => Promise<void>
      listRedemptions: () => Promise<any[]>
      listCoupons: () => Promise<any[]>
      syncUsages: () => Promise<any>
    }
    api: {
      reloadWindow: () => void
      closeWindow: () => void
      openExternal: (url: string) => void
    }
  }

  interface ImportMetaEnv {
    readonly MAIN_VITE_SUPABASE_URL: string
    readonly MAIN_VITE_SUPABASE_SERVICE_ROLE_KEY: string
    readonly MAIN_VITE_ADMIN_PASSWORD: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}
