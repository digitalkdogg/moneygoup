import { Resend } from 'resend';

export async function sendRegistrationEmail(to: string, username: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_REG_API_KEY || process.env.resend_reg_api_key);
  const from = process.env.RESEND_FROM_EMAIL || process.env.resend_from_email || 'noreply@growmystock.com';

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Welcome to GrowMyStock — Account Pending Approval',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#017e3b;margin-top:0;">Registration Complete!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Thank you for registering with GrowMyStock. Your account has been created and is currently <strong>pending admin approval</strong>.</p>
        <p>Here's what happens next:</p>
        <ol style="line-height:1.8;">
          <li>An admin will review your account.</li>
          <li>Once approved, you'll be able to log in and access all features.</li>
        </ol>
        <p>You do not need to do anything at this time. We'll be in touch once your account is approved.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
        <p style="color:#999;font-size:12px;margin:0;">GrowMyStock &mdash; Your stock analysis platform</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend API error: ${JSON.stringify(error)}`);
  }
}

export async function sendApprovalEmail(to: string, username: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_REG_FINAL_API_KEY || process.env.resend_reg_final_api_key);
  const from = process.env.RESEND_FROM_EMAIL || process.env.resend_from_email || 'noreply@growmystock.com';

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Your GrowMyStock Account Has Been Approved!',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#017e3b;margin-top:0;">You're Approved!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Great news — your GrowMyStock account has been <strong>approved</strong>. You can now log in and start using all of our features.</p>
        <a href="https://growmystock.com/login"
           style="display:inline-block;background-color:#017e3b;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;margin:16px 0;">
          Log In Now
        </a>
        <p>If the button doesn't work, paste this link into your browser:<br/>
          <span style="word-break:break-all;">https://growmystock.com/login</span>
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

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY || process.env.resend_api_key);
  const from = process.env.RESEND_FROM_EMAIL || process.env.resend_from_email || 'noreply@growmystock.com';

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
