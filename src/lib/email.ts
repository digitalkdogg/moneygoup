import { Resend } from 'resend';
import { createHmac } from 'crypto';

// Use "Name <email>" format so Gmail shows a human sender name, not a bare address.
// Set RESEND_FROM_EMAIL to e.g. "GrowMyStocks <accounts@growmystocks.com>"
const FROM = process.env.RESEND_FROM_EMAIL || process.env.resend_from_email || 'GrowMyStocks <accounts@growmystocks.com>';
const BASE_URL = (process.env.NEXTAUTH_URL || 'https://growmystocks.com').replace(/\/$/, '');

// RFC 8058 one-click unsubscribe headers. The recipient email must be in the
// URL because Gmail's POST body only contains "List-Unsubscribe=One-Click".
// The token is HMAC-SHA256(email) so the endpoint can verify the URL wasn't
// forged — without it anyone who knows an email address could deactivate accounts.
function unsubscribeToken(email: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not configured — cannot sign unsubscribe tokens');
  return createHmac('sha256', secret).update(email).digest('hex');
}

function unsubscribeHeaders(email: string) {
  const token = unsubscribeToken(email);
  const url = `${BASE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export async function sendRegistrationEmail(to: string, username: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_REG_API_KEY || process.env.resend_reg_api_key);

  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: 'Thanks for joining GrowMyStocks — your account is under review',
    headers: unsubscribeHeaders(to),
    text: [
      `Hi ${username},`,
      '',
      'Thanks for signing up for GrowMyStocks. Your account is currently being reviewed — this usually takes less than 24 hours.',
      '',
      "Once active you'll get access to AI-powered stock predictions, GPS scoring, and personalized portfolio tracking. We'll email you when you're good to go.",
      '',
      'Questions? Just reply to this email.',
      '',
      '---',
      'GrowMyStocks — AI-powered stock analysis',
      "You're receiving this because you created an account at growmystocks.com.",
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;">
        <h2 style="color:#017e3b;margin-top:0;">Thanks for signing up!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>We received your registration for GrowMyStocks. Your account is currently being reviewed — this usually takes less than 24 hours.</p>
        <p>Once your account is active you'll get access to AI-powered stock predictions, GPS scoring, and personalized portfolio tracking. We'll send you a separate email when you're good to go.</p>
        <p>In the meantime, feel free to reply to this email if you have any questions.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#94a3b8;font-size:12px;margin:0;">
          GrowMyStocks &mdash; AI-powered stock analysis<br/>
          You're receiving this because you created an account at growmystocks.com.
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  }
}

export async function sendApprovalEmail(to: string, username: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_REG_FINAL_API_KEY || process.env.resend_reg_final_api_key);
  const loginUrl = `${BASE_URL}/login`;

  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: 'Your GrowMyStocks account is ready',
    headers: unsubscribeHeaders(to),
    text: [
      `Hi ${username},`,
      '',
      'Your GrowMyStocks account has been reviewed and is now active.',
      '',
      `Log in here: ${loginUrl}`,
      '',
      'Once you log in you can explore stock predictions, GPS scores, and your personalized dashboard.',
      '',
      'Questions? Just reply to this email.',
      '',
      '---',
      'GrowMyStocks — AI-powered stock analysis',
      "You're receiving this because you created an account at growmystocks.com.",
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;">
        <h2 style="color:#017e3b;margin-top:0;">Your account is ready, ${username}!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your GrowMyStocks account has been reviewed and is now active. You can log in and start exploring stock predictions, GPS scores, and your personalized dashboard.</p>
        <p style="margin:24px 0;">
          <a href="${loginUrl}"
             style="display:inline-block;background-color:#017e3b;color:white;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
            Log in to GrowMyStocks
          </a>
        </p>
        <p style="color:#475569;">If the button above doesn't work, copy and paste this URL into your browser:</p>
        <p style="color:#475569;word-break:break-all;font-size:13px;">${loginUrl}</p>
        <p>If you have any questions getting started, just reply to this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#94a3b8;font-size:12px;margin:0;">
          GrowMyStocks &mdash; AI-powered stock analysis<br/>
          You're receiving this because you created an account at growmystocks.com.
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY || process.env.resend_api_key);

  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: 'Reset your GrowMyStocks password',
    headers: unsubscribeHeaders(to),
    text: [
      'You requested a password reset for your GrowMyStocks account.',
      '',
      'Use the link below to choose a new password. It expires in 1 hour.',
      '',
      resetUrl,
      '',
      "If you didn't request this, you can safely ignore this email — your password won't change.",
      '',
      '---',
      'GrowMyStocks — AI-powered stock analysis',
      "You're receiving this because a password reset was requested for your account.",
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;">
        <h2 style="color:#017e3b;margin-top:0;">Password reset request</h2>
        <p>We received a request to reset the password for your GrowMyStocks account.</p>
        <p>Click the button below to choose a new password. This link is valid for <strong>1 hour</strong>.</p>
        <p style="margin:24px 0;">
          <a href="${resetUrl}"
             style="display:inline-block;background-color:#017e3b;color:white;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
            Reset my password
          </a>
        </p>
        <p style="color:#475569;">If the button above doesn't work, copy and paste this URL into your browser:</p>
        <p style="color:#475569;word-break:break-all;font-size:13px;">${resetUrl}</p>
        <p style="color:#64748b;font-size:13px;">If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#94a3b8;font-size:12px;margin:0;">
          GrowMyStocks &mdash; AI-powered stock analysis<br/>
          You're receiving this because a password reset was requested for your account.
        </p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  }
}
