import { Resend } from 'resend';

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM_EMAIL || 'noreply@growmystock.com';

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'Reset your GrowMyStock password',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#017e3b;margin-top:0;">Reset Your Password</h2>
        <p>You requested a password reset for your GrowMyStock account.</p>
        <p>Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${resetUrl}"
           style="display:inline-block;background-color:#017e3b;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;margin:16px 0;">
          Reset Password
        </a>
        <p>If you didn't request this, you can safely ignore this email.</p>
        <p style="color:#666;font-size:13px;">If the button doesn't work, paste this link into your browser:<br/>
          <span style="word-break:break-all;">${resetUrl}</span>
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#999;font-size:12px;margin:0;">GrowMyStock &mdash; Your stock analysis platform</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  }
}
