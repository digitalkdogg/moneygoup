import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { checkOrigin } from '@/utils/originCheck'
import { createLogger } from '@/utils/logger'
import { contactLimiter } from '@/utils/rateLimiter'
import { checkRateLimit } from '@/utils/rateLimitMiddleware'
import { escapeHtml } from '@/utils/sanitize'

const logger = createLogger('api/contact')

export async function POST(request: NextRequest) {
  const originCheckResponse = checkOrigin(request)
  if (originCheckResponse) return originCheckResponse

  const rateLimitResponse = await checkRateLimit(request, contactLimiter, 'contact')
  if (rateLimitResponse) return rateLimitResponse

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { name, email, subject, message } = body as Record<string, string>

  if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
    return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const safeName    = escapeHtml(name.trim().slice(0, 200))
  const safeEmail   = escapeHtml(email.trim().slice(0, 200))
  const safeSubject = escapeHtml(subject.trim().slice(0, 200))
  const safeMessage = escapeHtml(message.trim().slice(0, 2000))

  const adminEmail = process.env.CONTACT_RECIPIENT_EMAIL
  if (!adminEmail) {
    logger.error('CONTACT_RECIPIENT_EMAIL not configured')
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  const resend = new Resend(process.env.RESEND_CONTACT_API_KEY)
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'

  try {
    await resend.emails.send({
      from,
      to: adminEmail,
      replyTo: safeEmail,
      subject: `[GrowMyStocks Contact] ${safeSubject}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#015f2d;margin-top:0;">New Contact Form Submission</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
            <tr><td style="padding:8px 0;color:#666;width:90px;vertical-align:top;"><strong>From:</strong></td><td style="padding:8px 0;">${safeName}</td></tr>
            <tr><td style="padding:8px 0;color:#666;vertical-align:top;"><strong>Email:</strong></td><td style="padding:8px 0;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
            <tr><td style="padding:8px 0;color:#666;vertical-align:top;"><strong>Subject:</strong></td><td style="padding:8px 0;">${safeSubject}</td></tr>
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;"/>
          <p style="white-space:pre-wrap;line-height:1.6;">${safeMessage}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
          <p style="color:#999;font-size:12px;margin:0;">GrowMyStocks &mdash; Contact Form</p>
        </div>
      `,
    })

    logger.info(`Contact form submitted by ${safeEmail}`)
    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error('Contact email send failed', err as Record<string, any>)
    return NextResponse.json({ error: 'Failed to send message. Please try again.' }, { status: 500 })
  }
}
