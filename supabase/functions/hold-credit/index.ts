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

    // Call RPC to atomically hold 1 credit
    const { data, error } = await admin.rpc('hold_credit_for_session', {
      p_user_id: user.id
    })

    if (error) {
      console.error('[hold-credit] RPC error:', error)
      return new Response(JSON.stringify({ ok: false, reason: 'rpc_error', detail: error.message }), { status: 500, headers })
    }

    if (!data?.ok) {
      return new Response(
        JSON.stringify({ ok: false, reason: data?.reason ?? 'insufficient_balance', effective_balance: data?.effective_balance ?? 0 }),
        { status: 402, headers }
      )
    }

    return new Response(
      JSON.stringify({ ok: true, held_credits: data.held_credits, effective_balance: data.effective_balance }),
      { status: 200, headers }
    )

  } catch (err: any) {
    console.error('[hold-credit] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
