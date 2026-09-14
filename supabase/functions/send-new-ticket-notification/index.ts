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

import nodemailer from "npm:nodemailer@6.9.13"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Caller-controlled text is interpolated into the notification email's HTML —
// escape it so a crafted subject/message cannot inject markup (audit C4).
function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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

    // 1. Verify Authorization (audit C4: the old "any token >20 chars" check
       // let anyone send branded emails — replaced with real Supabase JWT
    // verification; this function is invoked by the logged-in submitter).
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized')
    }
    const token = authHeader.slice(7).trim()

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token)
    if (authError || !user) {
      throw new Error('Unauthorized')
    }

    const { ticketId, userEmail, category, subject, message } = await req.json()

    if (!userEmail || !message) {
      throw new Error('Missing userEmail or message')
    }

    const gmailUser = Deno.env.get('GMAIL_USER')
    const gmailAppPass = Deno.env.get('GMAIL_APP_PASS')
    const resendApiKey = Deno.env.get('RESEND_API_KEY')

    const htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #4f46e5; margin-top: 0;">📩 New Customer Ticket / Feedback Received</h2>
        <p>A customer has submitted a new inquiry on the website:</p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; width: 120px; color: #64748b;">Customer Email:</td>
            <td style="padding: 8px; color: #1e293b;">${escapeHtml(userEmail)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #64748b;">Category:</td>
            <td style="padding: 8px; color: #1e293b;"><span style="background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 12px; font-size: 12px;">${escapeHtml(category || 'General')}</span></td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #64748b;">Subject:</td>
            <td style="padding: 8px; color: #1e293b;">${escapeHtml(subject || 'Website Feedback')}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; color: #64748b;">Ticket ID:</td>
            <td style="padding: 8px; font-family: monospace; color: #64748b;">${escapeHtml(ticketId)}</td>
          </tr>
        </table>

        <div style="background-color: #f8fafc; padding: 16px; border-left: 4px solid #4f46e5; border-radius: 4px; margin: 16px 0;">
          <p style="margin: 0; white-space: pre-wrap; color: #0f172a;">${escapeHtml(message)}</p>
        </div>

        <p style="font-size: 13px; color: #94a3b8; margin-top: 24px;">
          This ticket is also available in real-time inside your <strong>Zyro Support Client App</strong>.
        </p>
      </div>
    `

    let sentVia = ''
    let messageId = ''

    // 1. Try Resend API (Deliver directly to your owner Gmail Inbox)
    if (resendApiKey) {
      try {
        console.log('[send-new-ticket-notification] Sending via Resend API...')
        const targetEmail = (gmailUser || 'zyroaiinterview@gmail.com').trim()

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`,
          },
          body: JSON.stringify({
            from: 'Zyro System <onboarding@resend.dev>',
            to: [targetEmail],
            reply_to: userEmail,
            subject: `[New Ticket] ${subject || category || 'Customer Feedback'} - ${userEmail}`,
            html: htmlContent,
          }),
        })

        const data = await response.json()

        if (response.ok) {
          sentVia = `Resend API (${targetEmail})`
          messageId = data.id
          console.log('[send-new-ticket-notification] Sent successfully via Resend:', messageId)
        } else {
          console.warn('[send-new-ticket-notification] Resend response error:', data)
        }
      } catch (err: any) {
        console.warn('[send-new-ticket-notification] Resend exception:', err.message)
      }
    }

    // 2. Try Gmail SMTP Fallback
    if (!sentVia && gmailUser && gmailAppPass) {
      try {
        console.log('[send-new-ticket-notification] Sending via Gmail SMTP...')
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser.trim(),
            pass: gmailAppPass.trim().replace(/\s+/g, ''),
          },
        })

        const info = await transporter.sendMail({
          from: `Zyro System <${gmailUser.trim()}>`,
          replyTo: userEmail,
          to: gmailUser.trim(),
          subject: `[New Ticket] ${subject || category || 'Customer Feedback'} - ${userEmail}`,
          html: htmlContent,
        })

        sentVia = `Gmail SMTP (${gmailUser})`
        messageId = info.messageId
        console.log('[send-new-ticket-notification] Sent successfully via Gmail SMTP:', messageId)
      } catch (gmailErr: any) {
        console.warn('[send-new-ticket-notification] Gmail SMTP error:', gmailErr.message)
      }
    }

    if (!sentVia) {
      throw new Error('All email engines failed. Check RESEND_API_KEY or GMAIL_USER/GMAIL_APP_PASS in Supabase secrets.')
    }

    return new Response(
      JSON.stringify({ message: 'New ticket notification sent', id: messageId, sentVia }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error: any) {
    console.error('[send-new-ticket-notification] Exception:', error.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
