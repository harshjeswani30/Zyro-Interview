export {}

declare global {
  interface Window {
    // Current Electron-only properties (deprecated)
    adminEnv: {
      supabaseUrl: string
      supabaseServiceKey: string
      adminPassword: string
    }
    // Stripe API exposed via Electron IPC
    stripeApi: {
      create: (opts: any) => Promise<{ couponId: string; promoId: string }>
      delete: (opts: { stripeCouponId: string }) => Promise<void>
      setActive: (opts: { stripePromoId: string; active: boolean }) => Promise<void>
      listRedemptions: () => Promise<any[]>
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
