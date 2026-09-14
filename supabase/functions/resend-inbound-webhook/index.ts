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

// Constant-time string compare (avoids leaking the signature via response timing).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Audit C5: verify Resend's svix signature BEFORE the payload is trusted ──
// Resend delivers inbound-email webhooks via Svix. Every request carries
// svix-id / svix-timestamp / svix-signature; the signature is
// base64(HMAC-SHA256(base64decode(signingSecret), `${id}.${ts}.${rawBody}`)).
// The check is fail-closed: without it anyone could forge a "customer reply",
// create tickets for arbitrary victims, or trigger the closed-ticket
// auto-responder from our domain.
async function verifySvixSignature(
  req: Request,
  rawBody: string
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET')
  if (!secret) {
    return { ok: false, status: 503, reason: 'RESEND_WEBHOOK_SECRET not configured — set it (Resend dashboard → Webhooks → Signing Secret) before inbound email can be processed' }
  }

  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, status: 401, reason: 'Missing svix signature headers' }
  }

  // Replay guard: reject timestamps more than 5 minutes from now (Svix recommendation).
  const ts = Number(svixTimestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, status: 401, reason: 'Stale svix timestamp' }
  }

  // Signature covers the RAW body bytes — parse/re-serialize would break it,
  // which is why rawBody is read once below and passed through.
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
  const secretBytes = Uint8Array.from(
    atob(secret.replace(/^whsec_/, '')),
    (ch) => ch.charCodeAt(0)
  )
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedContent))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

  // The header may carry several space-separated signatures, each "v1,<b64>".
  const provided = svixSignature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3))

  if (provided.length === 0 || !provided.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, status: 401, reason: 'Invalid svix signature' }
  }
  return { ok: true }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      serviceRoleKey()
    )

    // Read the RAW body first — the svix signature is computed over these exact
    // bytes — then verify, then parse. An unsigned/invalid request never reaches
    // any table.
    const rawBody = await req.text()
    const verification = await verifySvixSignature(req, rawBody)
    if (!verification.ok) {
      console.warn(`[Inbound Webhook] Rejected: ${verification.reason}`)
      return new Response(
        JSON.stringify({ error: verification.reason }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: verification.status }
      )
    }

    const payload = JSON.parse(rawBody)
    console.log('[Inbound Webhook] Received payload:', JSON.stringify(payload))

    // Parse email details from Resend / Mailgun / SendGrid / Custom Webhook payload
    const emailData = payload.data || payload
    const fromRaw = emailData.from || payload.from || payload.sender || payload['from_email'] || ''
    const subject = emailData.subject || payload.subject || ''
    const bodyText = emailData.text || emailData.plain || emailData.html || payload.text || payload.html || payload.body || ''
    const headers = emailData.headers || payload.headers || {}

    // Clean user email from "John Doe <john@example.com>" format
    const emailMatch = fromRaw.match(/<([^>]+)>/) || [null, fromRaw]
    const userEmail = (emailMatch[1] || fromRaw).trim().toLowerCase()

    if (!userEmail || !bodyText) {
      return new Response(
        JSON.stringify({ error: 'Missing user email or body text' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Clean body text (strip quoted reply history e.g. "On Mon, ... wrote:")
    let cleanMessage = bodyText.replace(/<[^>]*>?/gm, '') // Strip HTML tags if html payload

    const replyRegexes = [
      /On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[\s\S]{1,150}?wrote:/i,
      /On\s+.*wrote:/i,
      /From:\s+.+/i,
      /---------- Forwarded message ---------/i,
      /Zyro AI Support Desk/i,
      /Zyro AI Support Team/i,
      /Zyro Support Team/i
    ]

    for (const regex of replyRegexes) {
      cleanMessage = cleanMessage.split(regex)[0]
    }

    // Remove any leftover lines starting with '>'
    cleanMessage = cleanMessage
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith('>'))
      .join('\n')
      .trim() || bodyText.trim()

    let candidateTicketId: string | null = null

    // 1. Try to find Candidate Ticket ID from [Ticket #...] in subject
    const ticketTagMatch = subject.match(/\[Ticket\s+#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i) || subject.match(/\[Ticket\s+#([^\]\s]+)\]/i)
    if (ticketTagMatch) {
      candidateTicketId = ticketTagMatch[1]
    }

    // 2. Try to find candidate UUID pattern in subject
    if (!candidateTicketId) {
      const uuidMatch = subject.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      if (uuidMatch) {
        candidateTicketId = uuidMatch[0]
      }
    }

    // 3. Try to extract candidate ticketId from X-Entity-Ref-ID or In-Reply-To / References headers
    if (!candidateTicketId && headers) {
      const headerStr = typeof headers === 'string' ? headers : JSON.stringify(headers)
      const refMatch = headerStr.match(/ticket-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || headerStr.match(/X-Entity-Ref-ID["\s:]+([0-9a-f-]{36})/i) || headerStr.match(/ticket-([0-9a-f]{8})/i)
      if (refMatch) {
        candidateTicketId = refMatch[1]
      }
    }

    let ticketRecord: any = null

    // Verify candidate ticketId actually exists in support_tickets table (full UUID or short 8-char prefix)
    if (candidateTicketId) {
      if (candidateTicketId.length === 36) {
        const { data: foundTicket } = await supabaseClient
          .from('support_tickets')
          .select('*')
          .eq('id', candidateTicketId)
          .maybeSingle()

        if (foundTicket) ticketRecord = foundTicket
      } else {
        // Short prefix match
        const { data: foundTickets } = await supabaseClient
          .from('support_tickets')
          .select('*')
          .ilike('id', `${candidateTicketId}%`)
          .limit(1)

        if (foundTickets && foundTickets.length > 0) {
          ticketRecord = foundTickets[0]
        }
      }
    }

    // 4. If ticket is RESOLVED or CLOSED -> Block customer reply from reaching staff & send auto-responder email!
    if (ticketRecord && (ticketRecord.status === 'resolved' || ticketRecord.status === 'closed')) {
      console.log(`[Inbound Webhook] Ticket ${ticketRecord.id} is ${ticketRecord.status}. Blocking reply and sending auto-responder.`)

      const resendApiKey = Deno.env.get('RESEND_API_KEY')
      const closedHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 20px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
          
          <!-- Header Banner -->
          <div style="background: linear-gradient(135deg, #064e3b 0%, #065f46 100%); padding: 32px 24px; text-align: center;">
            <div style="display: inline-block; padding: 5px 14px; background: rgba(52, 211, 153, 0.2); border: 1px solid rgba(52, 211, 153, 0.4); border-radius: 999px; color: #6ee7b7; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">
              ✓ TICKET CLOSED
            </div>
            <h1 style="color: #ffffff; font-size: 22px; font-weight: 800; margin: 12px 0 4px 0;">
              Ticket #${ticketRecord.id.slice(0, 8)} is Closed
            </h1>
            <p style="color: #a7f3d0; font-size: 13px; margin: 0;">
              Zyro AI Support Desk
            </p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 28px; background-color: #ffffff;">
            <p style="font-size: 14px; color: #334155; margin: 0 0 16px 0;">Hello,</p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6; margin: 0 0 20px 0;">
              Thank you for reaching out. Support ticket <strong>#${ticketRecord.id.slice(0, 8)}</strong> was marked as <strong>${ticketRecord.status.toUpperCase()}</strong> by our Support Team and is no longer receiving new email replies.
            </p>

            <!-- Corporate Closed Notice -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 28px; text-align: center;">
              <p style="font-size: 13px; font-weight: 700; color: #334155; margin: 0 0 6px 0;">
                🔒 Need further assistance or have a new question?
              </p>
              <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin: 0 0 16px 0;">
                Please visit our website to submit a new support ticket. Our team will be happy to help you.
              </p>
              <a href="https://zyro-ai.in" style="display: inline-block; padding: 10px 24px; background: linear-gradient(135deg, #8b5cf6, #6366f1); color: #ffffff; font-size: 12px; font-weight: 700; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);">
                Submit New Request
              </a>
            </div>

            <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0;">
              Thank you for choosing Zyro AI.
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px 28px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="font-size: 12px; color: #64748b; margin: 0 0 4px 0; font-weight: 600;">
              Zyro AI Customer Support Team
            </p>
            <p style="font-size: 11px; color: #94a3b8; margin: 0;">
              © 2026 Zyro AI Inc. · <a href="https://zyro-ai.in" style="color: #8b5cf6; text-decoration: none;">zyro-ai.in</a>
            </p>
          </div>

        </div>
      </body>
      </html>
      `

      if (resendApiKey) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${resendApiKey}`,
            },
            body: JSON.stringify({
              from: 'Zyro AI Support Team <onboarding@resend.dev>',
              to: [userEmail],
              subject: `[Closed Ticket] Re: ${subject}`,
              html: closedHtml,
            }),
          })
        } catch (_e) {
          // ignore
        }
      }

      return new Response(
        JSON.stringify({ message: 'Ticket is closed/resolved. Reply blocked from staff client and auto-responder sent to customer.', ticketStatus: ticketRecord.status }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    let ticketId: string | null = ticketRecord ? ticketRecord.id : null

    // 5. If no candidate ticket ID match, query DB for user's latest open or in_progress ticket
    if (!ticketId) {
      const { data: tickets } = await supabaseClient
        .from('support_tickets')
        .select('id')
        .eq('user_email', userEmail)
        .neq('status', 'closed')
        .neq('status', 'resolved')
        .order('updated_at', { ascending: false })
        .limit(1)

      if (tickets && tickets.length > 0) {
        ticketId = tickets[0].id
      }
    }

    // 6. If still no open ticket found, create a brand new ticket for this user
    if (!ticketId) {
      const { data: newTicket, error: createErr } = await supabaseClient
        .from('support_tickets')
        .insert({
          user_email: userEmail,
          category: 'general',
          subject: subject.replace(/^Re:\s*/i, '').replace(/\[Ticket\s+#[^\]]+\]\s*/i, '').trim() || 'Email Inquiry',
          status: 'open',
          priority: 'medium'
        })
        .select('id')
        .single()

      if (createErr) throw createErr
      ticketId = newTicket.id
    }

    // 7. Insert message into ticket_messages (Triggers Supabase Realtime in Zyro Support Client App!)
    const { data: insertedMsg, error: msgErr } = await supabaseClient
      .from('ticket_messages')
      .insert({
        ticket_id: ticketId,
        sender_type: 'user',
        sender_email: userEmail,
        message: cleanMessage
      })
      .select()
      .single()

    if (msgErr) throw msgErr

    // Update ticket updated_at timestamp
    await supabaseClient
      .from('support_tickets')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', ticketId)

    console.log(`[Inbound Webhook] Successfully inserted customer message for ticket ${ticketId}`)

    return new Response(
      JSON.stringify({ success: true, ticketId, messageId: insertedMsg.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (err: any) {
    console.error('[Inbound Webhook] Error processing email:', err.message)
    return new Response(
      JSON.stringify({ error: err.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
