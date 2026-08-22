import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.1"

const ALLOWED_ORIGINS = ['https://zyro-ai.in', 'https://www.zyro-ai.in']

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

serve(async (req) => {
  const origin = req.headers.get('Origin')

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) })
  }

  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 1. Require Authorization header (safe — never throws on missing)
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
    }

    // 2. Verify the user session
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.slice(7)
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
    }

    // 3. Verify the caller is an admin — any authenticated user can reach this function,
    //    but only admins may actually send emails
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (profileError || !profile?.is_admin) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin access required' }), { status: 403, headers })
    }

    // 4. Parse body
    const { subject, html, testEmail } = await req.json()
    if (!subject?.trim() || !html?.trim()) {
      return new Response(JSON.stringify({ error: 'subject and html are required' }), { status: 400, headers })
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    if (!resendApiKey) {
      return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500, headers })
    }

    // 5. Resolve recipients
    let recipients: string[] = []
    if (testEmail) {
      recipients = [testEmail.trim()]
    } else {
      const { data: profiles, error: dbError } = await supabaseClient
        .from('profiles')
        .select('email')
      if (dbError) throw dbError
      recipients = (profiles ?? []).map((p: { email: string }) => p.email).filter(Boolean)
    }

    if (recipients.length === 0) {
      return new Response(JSON.stringify({ error: 'No recipients found' }), { status: 400, headers })
    }

    // 6. Send in batches of 50 (Resend batch limit)
    const BATCH_SIZE = 50
    let sent = 0
    let failed = 0
    const senderEmail = 'Zyro AI <hello@zyro-ai.in>'

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE)
      try {
        const response = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`,
          },
          body: JSON.stringify(batch.map(email => ({
            from: senderEmail,
            to: email,
            subject,
            html,
          }))),
        })
        const data = await response.json()
        if (response.ok) {
          sent += batch.length
        } else {
          console.error('[Broadcast] Batch error:', data)
          failed += batch.length
        }
      } catch (err) {
        console.error('[Broadcast] Batch exception:', err)
        failed += batch.length
      }
    }

    // 7. Return aggregate counts only — no recipient list leaked
    return new Response(
      JSON.stringify({ message: 'Broadcast complete', sent, failed, total: recipients.length }),
      { headers, status: 200 }
    )

  } catch (error: any) {
    console.error('[Broadcast] Unhandled error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { headers, status: 500 }
    )
  }
})
