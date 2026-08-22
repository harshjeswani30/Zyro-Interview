export interface AdminEnv {
  supabaseUrl: string
  supabaseServiceKey: string
  adminPassword: string
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
    stripeApi: StripeApi
    api: {
      reloadWindow: () => void
      closeWindow: () => void
      openExternal: (url: string) => void
    }
  }
}
