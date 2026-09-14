// supabase/functions/generate-gateway-token/index.ts
// Issues a short-lived HMAC-signed gateway token after verifying the user's
// Supabase JWT and checking their subscription/trial status.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// Must match GATEWAY_HMAC_SECRET in your Cloudflare Worker secrets
const HMAC_SECRET = Deno.env.get('GATEWAY_HMAC_SECRET')!

const TRIAL_LIMIT_SECONDS = 600 // 10 minutes free trial

// Token validity: dynamic for ALL users (remaining time + 5 min buffer for mic/speaker test)
// 1 credit = 1 hour = 3600 seconds (same rate used by deduct-credit-hours edge function)
const BUFFER_SECONDS       = 5 * 60        // 5 minute buffer for mic/speaker test screen
const SECONDS_PER_CREDIT   = 3600          // 1 credit = 1 hour
const MAX_TOKEN_SECONDS    = 24 * 3600     // Hard cap: never issue a token > 24 hours

async function hmacSign(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  // 1. Extract user JWT from Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 })
  }
  const userJwt = authHeader.slice(7)

  // 2. Verify JWT by fetching user from Supabase auth.
  // New sb_publishable_ keys ship as SUPABASE_PUBLISHABLE_KEYS, a JSON dict
  // keyed by name. Fall back to the legacy anon JWT until it is deactivated.
  const publishableKey = (() => {
    const raw = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
    if (raw) {
      try {
        const key = (JSON.parse(raw) as Record<string, string>)['default']
        if (key) return key
      } catch { /* fall back to the legacy key */ }
    }
    return Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  })()
  const supabase = createClient(SUPABASE_URL, publishableKey, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } }
  })

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) {
    console.error('Invalid token:', userError)
    return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 })
  }

  const userId = userData.user.id

  // 3. Check subscription / trial status
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('trial_seconds_used, sessions_balance')
    .eq('id', userId)
    .single()

  if (profileError || !profile) {
    console.error(`Profile fetch failed for user ${userId}:`, profileError)
    return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 403 })
  }

  // Live schema has no subscription_status column (verified 2026-09-12) —
  // paid status is derived solely from sessions_balance (Razorpay grants
  // credits only). Do not add a subscription_status read here: it would 42703.
  const isPaid = (profile.sessions_balance ?? 0) > 0
  const trialUsed = profile.trial_seconds_used ?? 0
  const trialExpired = !isPaid && trialUsed >= TRIAL_LIMIT_SECONDS

  if (trialExpired) {
    return new Response(
      JSON.stringify({ error: 'trial_expired', message: 'Free trial has ended. Please upgrade.' }),
      { status: 403 }
    )
  }

  // 4. Issue HMAC token: "userId:expiryEpoch:signature"
  // TTL = exact remaining time + 5 min buffer (for mic/speaker test screen), capped at 24h.
  // • Free/trial users: remaining trial seconds (TRIAL_LIMIT - used) + buffer.
  // • Paid users:       sessions_balance credits × 3600 s/credit + buffer.
  // Keeping tokens tightly scoped prevents hoarding long-lived tokens and ensures
  // that if a user ends and restarts a session, the new token reflects updated balance.
  let availableSeconds: number
  if (isPaid) {
    const creditsRemaining = profile.sessions_balance ?? 0
    availableSeconds = creditsRemaining * SECONDS_PER_CREDIT
  } else {
    availableSeconds = Math.max(0, TRIAL_LIMIT_SECONDS - trialUsed)
  }

  const ttlSeconds = Math.min(availableSeconds + BUFFER_SECONDS, MAX_TOKEN_SECONDS)
  const expiry = Date.now() + ttlSeconds * 1000
  const payload = `${userId}:${expiry}`
  const signature = await hmacSign(payload, HMAC_SECRET)
  const token = `${payload}:${signature}`

  return new Response(
    JSON.stringify({
      token,
      expiresAt: expiry,
      tier: isPaid ? 'paid' : 'trial',
      ttlSeconds,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  )
})
