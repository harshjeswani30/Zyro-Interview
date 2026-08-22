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

    // 2. Parse session type from request
    const { sessionType } = await req.json().catch(() => ({ sessionType: 'regular' }))
    const isPhone = sessionType === 'phone'

    // 3. Atomically decrement the correct balance column
    //    The WHERE clause (balance > 0) acts as a lock — Postgres serializes concurrent calls
    //    so there is no race condition. If two requests arrive simultaneously, only one wins.
    const balanceCol = isPhone ? 'phone_sessions_balance' : 'sessions_balance'

    const { data, error: rpcError } = await admin.rpc('consume_session_balance', {
      p_user_id: user.id,
      p_column: balanceCol
    })

    if (rpcError) {
      // If the function returns 'no_sessions_remaining', send a clean 402
      if (rpcError.message?.includes('no_sessions_remaining')) {
        return new Response(JSON.stringify({ error: 'No sessions remaining', newBalance: 0 }), { status: 402, headers })
      }
      return new Response(JSON.stringify({ error: rpcError.message }), { status: 500, headers })
    }

    return new Response(JSON.stringify({ newBalance: data }), { status: 200, headers })

  } catch (err: any) {
    console.error('[consume-session] Error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers })
  }
})
