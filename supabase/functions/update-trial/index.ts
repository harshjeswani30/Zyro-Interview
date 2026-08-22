import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.1"

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
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
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

    // 3. Apply atomic monotonic bump — server enforces the ceiling (600s = 10min trial)
    //    The LEAST() ensures the value never exceeds the limit even if multiple requests arrive
    const { data, error: updateError } = await admin
      .from('profiles')
      .update({ trial_seconds_used: admin.rpc('LEAST', [600, admin.rpc('trial_seconds_used + delta')]) })
      .eq('id', user.id)
      .select('trial_seconds_used')
      .single()

    // Use raw SQL via rpc for the atomic update to avoid JS race conditions
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
