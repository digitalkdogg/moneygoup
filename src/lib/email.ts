import { Resend } from 'resend';

const UNSUBSCRIBE_FROM = process.env.RESEND_FROM_EMAIL || process.env.resend_from_email || 'accounts@growmystocks.com';
const BASE_URL = process.env.NEXTAUTH_URL || 'https://growmystocks.com';

// RFC 8058 one-click unsubscribe headers. The recipient email must be in the
// URL because Gmail's POST body only contains "List-Unsubscribe=One-Click".
function unsubscribeHeaders(email: string) {
  const url = `${BASE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}`;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export async function sendRegistrationEmail(to: string, username: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_REG_API_KEY || process.env.resend_reg_api_key);
  const from = UNSUBSCRIBE_FROM;

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Thanks for joining GrowMyStocks — your account is under review',
    headers: unsubscribeHeaders(to),
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
  const from = UNSUBSCRIBE_FROM;

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Your GrowMyStocks account is ready',
    headers: unsubscribeHeaders(to),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;">
        <h2 style="color:#017e3b;margin-top:0;">Your account is ready, ${username}!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your GrowMyStocks account has been reviewed and is now active. You can log in and start exploring stock predictions, GPS scores, and your personalized dashboard.</p>
        <p style="margin:24px 0;">
          <a href="https://growmystocks.com/login"
             style="display:inline-block;background-color:#017e3b;color:white;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
            Log in to GrowMyStocks
          </a>
        </p>
        <p style="color:#475569;">If the button above doesn't work, copy and paste this URL into your browser:</p>
        <p style="color:#475569;word-break:break-all;font-size:13px;">https://growmystocks.com/login</p>
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
  const from = UNSUBSCRIBE_FROM;

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Reset your GrowMyStocks password',
    headers: unsubscribeHeaders(to),
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
