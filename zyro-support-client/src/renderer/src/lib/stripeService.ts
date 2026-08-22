import { supabase } from './supabase'

interface StripeCreateOpts {
  code: string
  type: 'percent' | 'fixed'
  discountValue: number
  maxUses: number | null
  expiresAt: string | null
  description: string | null
  limitPerUser: boolean
}

export const stripeService = {
  async create(opts: StripeCreateOpts) {
    if (window.stripeApi) {
      // Electron environment
      return window.stripeApi.create(opts)
    } else {
      // Mobile/Web environment - calling Supabase Edge Function
      const { data, error } = await supabase.functions.invoke('manage-coupon', {
        body: { action: 'create', ...opts }
      })
      if (error) throw error
      return data as { couponId: string; promoId: string }
    }
  },

  async update(opts: StripeCreateOpts & { id: string }) {
    if (window.stripeApi) {
      // Electron environment
      return window.stripeApi.update(opts)
    } else {
      // Mobile/Web environment - calling Supabase Edge Function
      const { data, error } = await supabase.functions.invoke('manage-coupon', {
        body: { action: 'update', ...opts }
      })
      if (error) throw error
      return data
    }
  },

  async delete(opts: { stripeCouponId: string }) {
    if (window.stripeApi) {
      return window.stripeApi.delete(opts)
    } else {
      const { error } = await supabase.functions.invoke('manage-coupon', {
        body: { action: 'delete', ...opts }
      })
      if (error) throw error
    }
  },

  async setActive(opts: { stripePromoId: string; active: boolean }) {
    if (window.stripeApi) {
      return window.stripeApi.setActive(opts)
    } else {
      const { error } = await supabase.functions.invoke('manage-coupon', {
        body: { action: 'set-active', ...opts }
      })
      if (error) throw error
    }
  },

  async listRedemptions() {
    if (window.stripeApi) {
      return window.stripeApi.listRedemptions()
    } else {
      const { data, error } = await supabase.functions.invoke('manage-coupon', {
        body: { action: 'list-redemptions' }
      })
      if (error) throw error
      return data
    }
  },

  async syncUsages(): Promise<{ code: string; usedCount: number }[]> {
    if (window.stripeApi) {
      return window.stripeApi.syncUsages()
    }
    return []
  }
}
