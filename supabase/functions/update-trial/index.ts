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

    // 2. Parse the elapsed seconds from the request
    const { delta } = await req.json().catch(() => ({ delta: null }))

    if (typeof delta !== 'number' || delta < 0 || delta > 60) {
      // Only accept small positive deltas (max 60 seconds per heartbeat)
      // This prevents the client from resetting the counter to 0 or setting arbitrary values
      return new Response(
        JSON.stringify({ error: 'Invalid delta: must be a number between 0 and 60' }),
        { status: 400, headers }
      )
    }

    // 3. Apply atomic monotonic bump — the RPC enforces the 600s ceiling
    //    server-side (LEAST clamp), so concurrent heartbeats cannot overshoot.
    //    (Audit M8: the previous non-RPC update serialized a PostgrestBuilder
    //    instead of a value and was silently wrong — removed.)
    const { data: rpcData, error: rpcError } = await admin.rpc('bump_trial_seconds', {
      p_user_id: user.id,
      p_delta: delta
    })

    if (rpcError) {
      return new Response(JSON.stringify({ error: rpcError.message }), { status: 500, headers })
    }

    return new Response(JSON.stringify({ trial_seconds_used: rpcData }), { status: 200, headers })

  } catch (err: any) {
    console.error('[update-trial] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
