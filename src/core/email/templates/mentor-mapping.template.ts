import { EmailTemplateResult, escapeHtml, renderBaseEmailLayout } from './base.template';

export interface MentorMappedEmailParams {
  recipientName: string;
  isMentor: boolean;
  otherPartyName: string;
  batchName: string;
  portalUrl: string;
}

export enum MenteeReassignRecipientRole {
  MENTEE = 'MENTEE',
  NEW_MENTOR = 'NEW_MENTOR',
  PREVIOUS_MENTOR = 'PREVIOUS_MENTOR',
}

export interface MenteeReassignedEmailParams {
  recipientName: string;
  recipientRole: MenteeReassignRecipientRole;
  menteeName: string;
  mentorName: string;
  batchName: string;
  reason?: string;
  portalUrl: string;
}

/**
 * Renders email template for new mentor-mentee mapping inside a batch (MAP-01).
 */
export function renderMentorMappedEmail(params: MentorMappedEmailParams): EmailTemplateResult {
  const safeRecipientName = escapeHtml(params.recipientName || 'User');
  const safeOtherPartyName = escapeHtml(params.otherPartyName);
  const safeBatchName = escapeHtml(params.batchName);
  const portalUrl = params.portalUrl;

  const subject = params.isMentor
    ? `TechEniac LMS – New Mentee Mapped in ${params.batchName}`
    : `TechEniac LMS – Mentor Assigned for ${params.batchName}`;

  const text = params.isMentor
    ? `Hello ${params.recipientName},\n\nYou have been assigned as the mentor for ${params.otherPartyName} in batch "${params.batchName}".\n\nYou can access your cohort dashboard and review learning progress at: ${portalUrl}\n\nBest regards,\nThe TechEniac Team`
    : `Hello ${params.recipientName},\n\n${params.otherPartyName} has been assigned as your mentor for batch "${params.batchName}".\n\nYou can access your learning portal at: ${portalUrl}\n\nBest regards,\nThe TechEniac Team`;

  const content = params.isMentor
    ? `
      <h2 class="heading">New Mentee Mapped</h2>
      <p>Hello ${safeRecipientName},</p>
      <p>You have been mapped as the mentor for <strong>${safeOtherPartyName}</strong> in batch <strong>${safeBatchName}</strong>.</p>
      <p>You can now guide this mentee, review their submissions, and track their course progress.</p>
      <div class="btn-container">
        <a href="${portalUrl}" class="btn" target="_blank" rel="noopener noreferrer">View Cohort Dashboard</a>
      </div>`
    : `
      <h2 class="heading">Mentor Assigned</h2>
      <p>Hello ${safeRecipientName},</p>
      <p><strong>${safeOtherPartyName}</strong> has been assigned as your mentor for batch <strong>${safeBatchName}</strong>.</p>
      <p>Your mentor will guide your learning journey, provide assignment feedback, and conduct reviews.</p>
      <div class="btn-container">
        <a href="${portalUrl}" class="btn" target="_blank" rel="noopener noreferrer">Open Learning Portal</a>
      </div>`;

  const html = renderBaseEmailLayout({
    title: subject,
    content,
    footerNote:
      'This is an automated notification from TechEniac LMS. Please do not reply directly.',
  });

  return { subject, text, html };
}

/**
 * Renders email template for mentee reassignment in a batch (MAP-02).
 */
export function renderMenteeReassignedEmail(
  params: MenteeReassignedEmailParams,
): EmailTemplateResult {
  const safeRecipientName = escapeHtml(params.recipientName || 'User');
  const safeMenteeName = escapeHtml(params.menteeName);
  const safeMentorName = escapeHtml(params.mentorName);
  const safeBatchName = escapeHtml(params.batchName);
  const safeReason = params.reason ? escapeHtml(params.reason) : 'Cohort structural update';
  const portalUrl = params.portalUrl;

  let subject = `TechEniac LMS – Mentor Reassignment in ${params.batchName}`;
  let text = '';
  let content = '';

  if (params.recipientRole === MenteeReassignRecipientRole.MENTEE) {
    subject = `TechEniac LMS – Your Mentor Has Been Updated for ${params.batchName}`;
    text = `Hello ${params.recipientName},\n\nYour mentor for batch "${params.batchName}" has been updated to ${params.mentorName}.\nReason: ${params.reason || 'Cohort structural update'}\n\nAccess portal: ${portalUrl}\n\nBest regards,\nThe TechEniac Team`;
    content = `
      <h2 class="heading">Mentor Updated</h2>
      <p>Hello ${safeRecipientName},</p>
      <p>Your mentor for batch <strong>${safeBatchName}</strong> has been updated to <strong>${safeMentorName}</strong>.</p>
      <p><strong>Reason:</strong> ${safeReason}</p>
      <div class="btn-container">
        <a href="${portalUrl}" class="btn" target="_blank" rel="noopener noreferrer">Go to Portal</a>
      </div>`;
  } else if (params.recipientRole === MenteeReassignRecipientRole.NEW_MENTOR) {
    subject = `TechEniac LMS – Mentee Reassigned to You in ${params.batchName}`;
    text = `Hello ${params.recipientName},\n\nMentee ${params.menteeName} has been reassigned to you in batch "${params.batchName}".\nReason: ${params.reason || 'Cohort structural update'}\n\nAccess portal: ${portalUrl}\n\nBest regards,\nThe TechEniac Team`;
    content = `
      <h2 class="heading">Mentee Reassigned to You</h2>
      <p>Hello ${safeRecipientName},</p>
      <p>Mentee <strong>${safeMenteeName}</strong> has been reassigned to you in batch <strong>${safeBatchName}</strong>.</p>
      <p><strong>Reason:</strong> ${safeReason}</p>
      <div class="btn-container">
        <a href="${portalUrl}" class="btn" target="_blank" rel="noopener noreferrer">View Mentees</a>
      </div>`;
  } else {
    // PREVIOUS_MENTOR
    subject = `TechEniac LMS – Mentee Transition Notice for ${params.batchName}`;
    text = `Hello ${params.recipientName},\n\nMentee ${params.menteeName} in batch "${params.batchName}" has been transitioned to ${params.mentorName}.\nReason: ${params.reason || 'Cohort structural update'}\n\nBest regards,\nThe TechEniac Team`;
    content = `
      <h2 class="heading">Mentee Transition Notice</h2>
      <p>Hello ${safeRecipientName},</p>
      <p>Mentee <strong>${safeMenteeName}</strong> in batch <strong>${safeBatchName}</strong> has been reassigned to <strong>${safeMentorName}</strong>.</p>
      <p><strong>Reason:</strong> ${safeReason}</p>
      <p>Pending reviews and allocations have been transitioned accordingly.</p>`;
  }

  const html = renderBaseEmailLayout({
    title: subject,
    content,
    footerNote:
      'This is an automated notification from TechEniac LMS. Please do not reply directly.',
  });

  return { subject, text, html };
}
