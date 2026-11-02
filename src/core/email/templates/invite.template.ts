import { EmailTemplateResult, escapeHtml, renderBaseEmailLayout } from './base.template';

export interface InviteEmailParams {
  name: string;
  email: string;
  temporaryPassword: string;
  role: string;
  loginUrl: string;
}

/**
 * Generates subject, plain-text fallback, and HTML for account invitation emails.
 */
export function renderInviteEmail(params: InviteEmailParams): EmailTemplateResult {
  const recipientName = params.name?.trim() ? params.name.trim() : 'User';
  const safeName = escapeHtml(recipientName);
  const safeRole = escapeHtml(params.role);
  const safeEmail = escapeHtml(params.email);
  const safeTempPassword = escapeHtml(params.temporaryPassword);
  const loginUrl = params.loginUrl;

  const subject = 'Welcome to TechEniac LMS – Your Account Details';

  const text = `Hello ${recipientName},

Welcome to TechEniac LMS! An account has been created for you with the role: ${params.role}.

Your temporary credentials:
Email: ${params.email}
Temporary Password: ${params.temporaryPassword}

Please log in at ${loginUrl} to access your dashboard. You will be required to choose a new password upon your first sign in.

Best regards,
The TechEniac Team`;

  const content = `
    <h2 class="heading">Welcome to TechEniac LMS</h2>
    <p>Hello ${safeName},</p>
    <p>An account has been created for you with the role of <strong>${safeRole}</strong>.</p>
    <div class="cred-box">
      <div><strong>Email:</strong> ${safeEmail}</div>
      <div style="margin-top: 8px;"><strong>Temporary Password:</strong> <code>${safeTempPassword}</code></div>
    </div>
    <p>Click the button below to log in. You will be prompted to change your temporary password immediately upon your first sign in:</p>
    <div class="btn-container">
      <a href="${loginUrl}" class="btn" target="_blank" rel="noopener noreferrer">Log In to TechEniac LMS</a>
    </div>`;

  const html = renderBaseEmailLayout({
    title: 'Your TechEniac LMS Account',
    content,
    footerNote:
      'This is an automated notification with temporary credentials. Please do not reply directly.',
  });

  return { subject, text, html };
}
