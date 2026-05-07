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

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 1. Verify User
    const authHeader = req.headers.get('Authorization')!
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''))
    
    if (authError || !user) {
      throw new Error('Unauthorized')
    }

    const { subject, html, testEmail } = await req.json()
    const resendApiKey = Deno.env.get('RESEND_API_KEY')

    if (!resendApiKey) {
      throw new Error('Missing RESEND_API_KEY environment variable')
    }

    // 2. Get Recipients
    let recipients: string[] = []
    if (testEmail) {
      recipients = [testEmail]
    } else {
      const { data: profiles, error: dbError } = await supabaseClient
        .from('profiles')
        .select('email')
      
      if (dbError) throw dbError
      recipients = profiles.map((p: { email: string }) => p.email).filter(Boolean)
    }

    // 3. Send Emails via Resend API
    const results = []
    const senderEmail = 'Zyro AI <hello@zyro-ai.in>'

    // Resend's API allows batching or single sends. 
    // To maintain existing logic of tracking individual status, we'll send sequentially or in small chunks.
    for (const email of recipients) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`,
          },
          body: JSON.stringify({
            from: senderEmail,
            to: email,
            subject: subject,
            html: html,
          }),
        })

        const data = await response.json()
        if (response.ok) {
          results.push({ email, status: 'sent', id: data.id })
        } else {
          results.push({ email, status: 'failed', error: data.message || 'Unknown error' })
        }
      } catch (err) {
        results.push({ email, status: 'failed', error: err.message })
      }
    }

    return new Response(
      JSON.stringify({ message: `Broadcast processed for ${recipients.length} recipients`, details: results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
