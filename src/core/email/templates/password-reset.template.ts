import { EmailTemplateResult, escapeHtml, renderBaseEmailLayout } from './base.template';

export interface PasswordResetEmailParams {
  name?: string;
  resetUrl: string;
}

/**
 * Generates subject, plain-text fallback, and HTML for password reset emails.
 */
export function renderPasswordResetEmail(params: PasswordResetEmailParams): EmailTemplateResult {
  const recipientName = params.name?.trim() ? params.name.trim() : 'User';
  const safeName = escapeHtml(recipientName);
  const resetUrl = params.resetUrl;

  const subject = 'Reset Your TechEniac LMS Password';

  const text = `Hello ${recipientName},

You requested to reset your password for TechEniac LMS. Please click the link below or copy and paste it into your browser to choose a new password:

${resetUrl}

This link is valid for 30 minutes and can only be used once. If you did not request this, please ignore this email and your password will remain unchanged.

Best regards,
The TechEniac Team`;

  const content = `
    <h2 class="heading">Password Reset Request</h2>
    <p>Hello ${safeName},</p>
    <p>We received a request to reset your password. Click the button below to choose a new password:</p>
    <div class="btn-container">
      <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
    </div>
    <p style="font-size: 13px; color: #475569;">Or copy and paste this link into your browser:</p>
    <p><a href="${resetUrl}" class="url">${resetUrl}</a></p>
    <p style="font-size: 13px; color: #64748b;">This link will expire in 30 minutes. If you did not request a password reset, you can safely ignore this email.</p>`;

  const html = renderBaseEmailLayout({
    title: 'Reset Your Password',
    content,
    footerNote: 'This is an automated notification, please do not reply directly.',
  });

  return { subject, text, html };
}
