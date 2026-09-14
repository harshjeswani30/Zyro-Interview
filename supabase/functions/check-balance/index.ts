import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0"

// New sb_secret_ keys ship as SUPABASE_SECRET_KEYS, a JSON dict keyed by
// name. Fall back to the legacy service_role JWT until it is deactivated.
function serviceRoleKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const key = (JSON.parse(raw) as Record<string, string>)['default']
      if (key) return key
    } catch { /* malformed JSON — fall back to the legacy key */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const headers = { ...corsHeaders, 'Content-Type': 'application/json' }

  try {
    // 1. Verify the caller's user token
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey()
    )

    const { data: { user }, error: authError } = await admin.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
    }

    // 2. Read the caller's balance — identity is from token, never from request body
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('sessions_balance, trial_seconds_used, held_credits, credits_used_total')
      .eq('id', user.id)
      .single()

    if (profileError) {
      return new Response(JSON.stringify({ error: profileError.message }), { status: 500, headers })
    }

    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 404, headers })
    }

    const TRIAL_LIMIT = 600
    const rawBalance = Number(profile.sessions_balance ?? 0)
    const heldCredits = Number(profile.held_credits ?? 0)
    // effective_balance = balance minus already-reserved scheduled session credits
    const effectiveBalance = Math.max(0, rawBalance - heldCredits)

    const allowed =
      effectiveBalance > 0 ||
      (profile.trial_seconds_used ?? 0) < TRIAL_LIMIT

    return new Response(
      JSON.stringify({
        allowed,
        sessions_balance: rawBalance,
        effective_balance: effectiveBalance,
        held_credits: heldCredits,
        credits_used_total: Number(profile.credits_used_total ?? 0),
        trial_seconds_used: profile.trial_seconds_used,
        reason: allowed ? null : 'insufficient_balance'
      }),
      { status: 200, headers }
    )

  } catch (err: any) {
    console.error('[check-balance] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
