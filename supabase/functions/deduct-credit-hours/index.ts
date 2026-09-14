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

    const body = await req.json().catch(() => ({}))
    const durationSeconds: number = typeof body.durationSeconds === 'number' ? body.durationSeconds : 0
    const releaseHold: boolean = body.releaseHold === true

    if (durationSeconds < 0) {
      return new Response(JSON.stringify({ error: 'Invalid durationSeconds' }), { status: 400, headers })
    }

    // Calculate fractional credits: 1 credit = 1 hour = 3600 seconds
    // Minimum billable: exact time (no floor imposed server-side)
    const creditsToDeduct = Math.round((durationSeconds / 3600) * 10000) / 10000 // 4 decimal precision

    console.log(`[deduct-credit-hours] user=${user.id} duration=${durationSeconds}s credits=${creditsToDeduct} releaseHold=${releaseHold}`)

    const { data: newBalance, error: rpcError } = await admin.rpc('deduct_credit_hours', {
      p_user_id: user.id,
      p_credits_to_deduct: creditsToDeduct,
      p_release_hold: releaseHold
    })

    if (rpcError) {
      console.error('[deduct-credit-hours] RPC error:', rpcError)
      return new Response(JSON.stringify({ error: rpcError.message }), { status: 500, headers })
    }

    // Fetch updated profile to get credits_used_total
    const { data: profile } = await admin
      .from('profiles')
      .select('sessions_balance, credits_used_total, held_credits')
      .eq('id', user.id)
      .single()

    return new Response(
      JSON.stringify({
        newBalance: Number(newBalance ?? profile?.sessions_balance ?? 0),
        creditsDeducted: creditsToDeduct,
        creditsUsedTotal: Number(profile?.credits_used_total ?? 0),
        heldCredits: Number(profile?.held_credits ?? 0)
      }),
      { status: 200, headers }
    )

  } catch (err: any) {
    console.error('[deduct-credit-hours] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
