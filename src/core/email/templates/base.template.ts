export interface EmailTemplateResult {
  subject: string;
  text: string;
  html: string;
}

/**
 * Escapes common HTML special characters to prevent malformed tags in email clients.
 */
export function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export interface BaseLayoutOptions {
  title: string;
  content: string;
  footerNote?: string;
}

/**
 * Shared HTML wrapper providing consistent styling, branding, and layout for TechEniac LMS emails.
 */
export function renderBaseEmailLayout(options: BaseLayoutOptions): string {
  const { title, content, footerNote } = options;
  const footerNoteHtml = footerNote ? `<br>${footerNote}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; line-height: 1.5; }
    .container { max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-sizing: border-box; }
    .logo { font-size: 20px; font-weight: 700; color: #1e293b; margin-bottom: 24px; letter-spacing: -0.02em; }
    .heading { font-size: 18px; font-weight: 600; margin-top: 0; margin-bottom: 16px; color: #0f172a; }
    .btn-container { margin: 24px 0; }
    .btn { display: inline-block; background-color: #3b82f6; color: #ffffff !important; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 24px; border-radius: 8px; text-align: center; }
    .cred-box { background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0; font-family: monospace; font-size: 14px; border: 1px solid #e2e8f0; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #f1f5f9; font-size: 12px; color: #64748b; line-height: 1.5; }
    .url { word-break: break-all; color: #3b82f6; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">TechEniac LMS</div>
    ${content}
    <div class="footer">
      TechEniac LMS • Learning Management System${footerNoteHtml}
    </div>
  </div>
</body>
</html>`;
}
