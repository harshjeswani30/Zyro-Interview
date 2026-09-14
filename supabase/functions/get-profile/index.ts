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

    // 2. Fetch the caller's own profile only — identity derived from token, never from request body
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      return new Response(JSON.stringify({ error: profileError.message }), { status: 500, headers })
    }

    // 3. Auto-initialize profile if it doesn't exist yet (first login)
    if (!profile) {
      const { data: newProfile, error: createError } = await admin
        .from('profiles')
        .insert({ id: user.id, sessions_balance: 0, trial_seconds_used: 0 })
        .select()
        .single()

      if (createError) {
        return new Response(JSON.stringify({ error: createError.message }), { status: 500, headers })
      }
      return new Response(JSON.stringify(newProfile), { status: 200, headers })
    }

    return new Response(JSON.stringify(profile), { status: 200, headers })

  } catch (err: any) {
    console.error('[get-profile] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
