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

    // 2. Read the caller's balance — identity is from token, never from request body
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('sessions_balance, trial_seconds_used')
      .eq('id', user.id)
      .single()

    if (profileError) {
      return new Response(JSON.stringify({ error: profileError.message }), { status: 500, headers })
    }

    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 404, headers })
    }

    const TRIAL_LIMIT = 600
    const allowed =
      (profile.sessions_balance ?? 0) > 0 ||
      (profile.trial_seconds_used ?? 0) < TRIAL_LIMIT

    return new Response(
      JSON.stringify({
        allowed,
        sessions_balance: profile.sessions_balance,
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
