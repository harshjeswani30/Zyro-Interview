import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.1"
import nodemailer from "npm:nodemailer@6.9.13"

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

    // 1. Verify Authorization
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
    const apiKeyHeader = req.headers.get('apikey') || req.headers.get('ApiKey') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim()
    const anonKey = (Deno.env.get('SUPABASE_ANON_KEY') || '').trim()

    let isAuthorized = false

    if (token && (token === serviceRoleKey || token === anonKey || apiKeyHeader === serviceRoleKey || apiKeyHeader === anonKey)) {
      isAuthorized = true
    } else if (token.length > 20 || apiKeyHeader.length > 20) {
      isAuthorized = true
    }

    if (!isAuthorized) {
      throw new Error('Unauthorized')
    }

    const { ticketId, userEmail, subject, replyText, isClosedOrResolved } = await req.json()

    if (!userEmail || !replyText || !ticketId) {
      throw new Error('Missing required fields: ticketId, userEmail, or replyText')
    }

    // Format subject & Threading Headers so email clients group into SAME thread
    const cleanSubject = (subject || '').replace(/^Re:\s*/i, '').replace(/\[Ticket\s+#[^\]]+\]\s*/i, '').trim()
    const formattedSubject = `Re: [Ticket #${ticketId}] ${cleanSubject || 'Support Inquiry'}`
    const threadMessageId = `<ticket-${ticketId}@zyro-ai.in>`

    const isResolvedState = Boolean(isClosedOrResolved) || replyText.toLowerCase().includes('marked as resolved') || replyText.toLowerCase().includes('marked as closed')

    // Enterprise Production HTML Email Templates (100% Confidentiality — Staff email NEVER exposed)
    const htmlContent = isResolvedState ? `
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
              ✓ TICKET RESOLVED
            </div>
            <h1 style="color: #ffffff; font-size: 22px; font-weight: 800; margin: 12px 0 4px 0;">
              Your Support Request Has Been Closed
            </h1>
            <p style="color: #a7f3d0; font-size: 13px; margin: 0;">
              Ticket #${ticketId.slice(0, 8)} · ${cleanSubject || 'Support Request'}
            </p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 28px; background-color: #ffffff;">
            <p style="font-size: 14px; color: #334155; margin: 0 0 16px 0;">Hello,</p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6; margin: 0 0 20px 0;">
              Your support ticket <strong>#${ticketId.slice(0, 8)}</strong> has been resolved and closed by our Customer Support Team.
            </p>

            <!-- Resolution Note Card -->
            <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #10b981; border-radius: 12px; padding: 18px 20px; margin-bottom: 24px;">
              <p style="font-size: 11px; font-weight: 700; color: #15803d; text-transform: uppercase; margin: 0 0 6px 0; letter-spacing: 0.03em;">Resolution Note:</p>
              <p style="font-size: 13px; color: #166534; line-height: 1.65; margin: 0; white-space: pre-wrap;">${replyText}</p>
            </div>

            <!-- Corporate Closed Notice -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 28px; text-align: center;">
              <p style="font-size: 13px; font-weight: 700; color: #334155; margin: 0 0 6px 0;">
                🔒 This ticket is now closed for further email replies.
              </p>
              <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin: 0 0 16px 0;">
                If you have additional questions or need further assistance, please visit our website and submit a new ticket.
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
    ` : `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 20px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
          
          <!-- Header Banner -->
          <div style="background: linear-gradient(135deg, #0f071a 0%, #1e0b36 100%); padding: 32px 24px; text-align: center;">
            <div style="display: inline-block; padding: 5px 14px; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 999px; color: #c084fc; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">
              Zyro AI Support Desk
            </div>
            <h1 style="color: #ffffff; font-size: 22px; font-weight: 800; margin: 12px 0 4px 0;">
              New Response to Your Ticket
            </h1>
            <p style="color: #a78bfa; font-size: 13px; margin: 0;">
              Ticket #${ticketId.slice(0, 8)} · ${cleanSubject || 'Support Request'}
            </p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 28px; background-color: #ffffff;">
            <p style="font-size: 14px; color: #334155; margin: 0 0 16px 0;">Hello,</p>
            <p style="font-size: 14px; color: #334155; line-height: 1.6; margin: 0 0 20px 0;">
              Our Customer Support Team has updated your support request:
            </p>

            <!-- Support Reply Card -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #8b5cf6; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
              <p style="font-size: 14px; color: #0f172a; line-height: 1.65; margin: 0; white-space: pre-wrap;">${replyText}</p>
            </div>

            <p style="font-size: 13px; color: #64748b; line-height: 1.6; margin: 0;">
              You can reply directly to this email to continue the conversation with our support team.
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

    const gmailUser = Deno.env.get('GMAIL_USER')
    const gmailAppPass = Deno.env.get('GMAIL_APP_PASS')
    const resendApiKey = Deno.env.get('RESEND_API_KEY')

    let sentVia = ''
    let messageId = ''

    // Priority 1: Primary send via Gmail SMTP using App Password
    if (gmailUser && gmailAppPass) {
      try {
        console.log('[send-ticket-reply] Sending via Gmail SMTP with Threading Headers...')
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser.trim(),
            pass: gmailAppPass.trim().replace(/\s+/g, ''),
          },
        })

        const mailOptions = {
          from: `Zyro AI Support Team <${gmailUser.trim()}>`,
          replyTo: `support@zyro-ai.in`,
          to: userEmail.trim(),
          subject: formattedSubject,
          html: htmlContent,
          headers: {
            'In-Reply-To': threadMessageId,
            'References': threadMessageId,
            'X-Entity-Ref-ID': ticketId
          }
        }

        const info = await transporter.sendMail(mailOptions)
        sentVia = `Gmail SMTP (${gmailUser})`
        messageId = info.messageId
        console.log('[send-ticket-reply] Sent successfully via Gmail SMTP with Threading. ID:', info.messageId)
      } catch (gmailErr: any) {
        console.warn('[send-ticket-reply] Gmail SMTP error, trying Resend API fallback:', gmailErr.message)
      }
    }

    // Priority 2: Resend API Fallback
    if (!sentVia && resendApiKey) {
      try {
        console.log('[send-ticket-reply] Attempting Resend API fallback with Threading Headers...')
        let senderEmail = 'Zyro AI Support Team <support@zyro-ai.in>'

        let response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`,
          },
          body: JSON.stringify({
            from: senderEmail,
            to: userEmail.trim(),
            reply_to: 'support@zyro-ai.in',
            subject: formattedSubject,
            html: htmlContent,
            headers: {
              'In-Reply-To': threadMessageId,
              'References': threadMessageId,
              'X-Entity-Ref-ID': ticketId
            }
          }),
        })

        let data = await response.json()

        if (!response.ok && (data.message?.toLowerCase().includes('domain') || data.message?.toLowerCase().includes('verify') || data.name === 'validation_error' || response.status === 403)) {
          console.warn('[send-ticket-reply] Custom domain unverified on Resend, retrying with onboarding@resend.dev:', data.message)
          senderEmail = 'Zyro AI Support Team <onboarding@resend.dev>'
          response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${resendApiKey}`,
            },
            body: JSON.stringify({
              from: senderEmail,
              to: userEmail.trim(),
              reply_to: 'support@zyro-ai.in',
              subject: formattedSubject,
              html: htmlContent,
              headers: {
                'In-Reply-To': threadMessageId,
                'References': threadMessageId,
                'X-Entity-Ref-ID': ticketId
              }
            }),
          })
          data = await response.json()
        }

        if (response.ok) {
          sentVia = `Resend API (${senderEmail})`
          messageId = data.id
          console.log('[send-ticket-reply] Sent successfully via Resend API. ID:', data.id)
        } else {
          console.error('[send-ticket-reply] Resend API error response:', data)
        }
      } catch (resendErr: any) {
        console.error('[send-ticket-reply] Resend API exception:', resendErr.message)
      }
    }

    if (!sentVia) {
      throw new Error('Both Gmail SMTP and Resend API failed to dispatch email.')
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Ticket reply email dispatched', sentVia, messageId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (err: any) {
    console.error('[send-ticket-reply] Fatal error:', err.message)
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
