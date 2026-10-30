import sgMail from '@sendgrid/mail';
import nodemailer, { Transporter } from 'nodemailer';

import type { EmailJobData } from '../../jobs/email.types';
import { env } from '../config';
import { logger } from '../logging';
import {
  MenteeReassignRecipientRole,
  renderAllocationCompletedEmail,
  renderAssignmentGradedEmail,
  renderCourseAllocatedEmail,
  renderCourseDeadlineChangedEmail,
  renderInviteEmail,
  renderMenteeReassignedEmail,
  renderMentorMappedEmail,
  renderPasswordResetEmail,
  renderResubmissionRequestedEmail,
  renderSubmissionReceivedEmail,
  renderTopicDeadlineChangedEmail,
} from './templates';

export interface SendPasswordResetOptions {
  to: string;
  name?: string;
  resetToken: string;
}

export interface SendCourseAllocatedOptions {
  to: string;
  userId?: string;
  recipientName: string;
  courseTitle: string;
  startDate: string;
  dueDate: string;
  batchName?: string;
}

export interface SendCourseDeadlineChangedOptions {
  to: string;
  userId?: string;
  recipientName: string;
  courseTitle: string;
  newDueDate: string;
}

export interface SendInviteEmailOptions {
  to: string;
  name: string;
  temporaryPassword: string;
  role: string;
}

export interface SendMentorMappedOptions {
  to: string;
  recipientName: string;
  isMentor: boolean;
  otherPartyName: string;
  batchName: string;
}

export interface SendMenteeReassignedOptions {
  to: string;
  recipientName: string;
  recipientRole: MenteeReassignRecipientRole;
  menteeName: string;
  mentorName: string;
  batchName: string;
  reason?: string;
}

export interface SendSubmissionReceivedOptions {
  to: string;
  recipientName: string;
  menteeName: string;
  assignmentTitle: string;
  courseTitle: string;
  version: number;
  submittedAt: Date;
}

export interface SendAssignmentGradedOptions {
  to: string;
  recipientName: string;
  assignmentTitle: string;
  courseTitle: string;
  marks: number;
  maxMarks: number;
  gradeLabel: string;
  feedback?: string | null;
}

export interface SendResubmissionRequestedOptions {
  to: string;
  recipientName: string;
  assignmentTitle: string;
  courseTitle: string;
  feedback: string;
}

export interface SendAllocationCompletedOptions {
  to: string;
  recipientName: string;
  menteeName: string;
  courseTitle: string;
  batchName?: string;
}

export interface SendTopicDeadlineChangedOptions {
  to: string;
  recipientName: string;
  topicTitle: string;
  courseTitle: string;
  deadline: string;
}

export interface EmailServiceConfig {
  emailProvider: 'sendgrid' | 'smtp';
  sendgridApiKey?: string;
  sendgridFromEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

interface DispatchMailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  contextName: string;
  rethrowError?: boolean;
  metadata?: Record<string, unknown>;
}

export function parseFromEmail(from: string): { email: string; name?: string } {
  const trimmed = from.trim();
  const match = trimmed.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
  if (match && match[2]) {
    const name = match[1]?.trim();
    const email = match[2].trim();
    return name ? { email, name } : { email };
  }
  return { email: trimmed };
}

export class EmailService {
  private readonly transporter: Transporter | null = null;
  private readonly isSendGridConfigured: boolean = false;
  private readonly fromHeaderValue: string;
  private readonly fromRecipient: { email: string; name?: string };

  constructor(customConfig?: Partial<EmailServiceConfig>) {
    const provider =
      customConfig && 'emailProvider' in customConfig
        ? customConfig.emailProvider!
        : env.EMAIL_PROVIDER;

    const apiKey =
      customConfig && 'sendgridApiKey' in customConfig
        ? customConfig.sendgridApiKey
        : env.SENDGRID_API_KEY;

    const sendgridFrom =
      customConfig && 'sendgridFromEmail' in customConfig
        ? customConfig.sendgridFromEmail
        : env.SENDGRID_FROM_EMAIL;

    const smtpFrom =
      customConfig && 'smtpFrom' in customConfig ? customConfig.smtpFrom : env.SMTP_FROM;

    const smtpHost =
      customConfig && 'smtpHost' in customConfig ? customConfig.smtpHost : env.SMTP_HOST;

    const smtpPort =
      customConfig && 'smtpPort' in customConfig ? customConfig.smtpPort : env.SMTP_PORT;

    const smtpSecure =
      customConfig && 'smtpSecure' in customConfig ? customConfig.smtpSecure : env.SMTP_SECURE;

    const smtpUser =
      customConfig && 'smtpUser' in customConfig ? customConfig.smtpUser : env.SMTP_USER;

    const smtpPass =
      customConfig && 'smtpPass' in customConfig ? customConfig.smtpPass : env.SMTP_PASS;

    if (provider === 'sendgrid' && apiKey) {
      this.fromHeaderValue = sendgridFrom || smtpFrom || 'Techeniac LMS <noreply@techeniac.com>';
      this.fromRecipient = parseFromEmail(this.fromHeaderValue);
      sgMail.setApiKey(apiKey);
      this.isSendGridConfigured = true;
    } else if (smtpHost) {
      this.fromHeaderValue = smtpFrom || 'Techeniac LMS <noreply@techeniac.com>';
      this.fromRecipient = parseFromEmail(this.fromHeaderValue);
      // Port 465 requires direct SSL (secure: true); port 587 uses STARTTLS (secure: false)
      const secure = smtpPort === 465 ? true : smtpSecure && smtpPort !== 587;
      this.transporter = nodemailer.createTransport({
        pool: true,
        maxConnections: 5,
        host: smtpHost,
        port: smtpPort,
        secure,
        requireTLS: true,
        auth:
          smtpUser && smtpPass
            ? {
                user: smtpUser,
                pass: smtpPass,
              }
            : undefined,
      });
    } else {
      this.fromHeaderValue = sendgridFrom || smtpFrom || 'Techeniac LMS <noreply@techeniac.com>';
      this.fromRecipient = parseFromEmail(this.fromHeaderValue);
    }
  }

  private async executeSend(
    sendFn: () => Promise<unknown>,
    service: 'sendgrid' | 'smtp',
    contextName: string,
    rethrowError: boolean,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await sendFn();
      logger.info(
        { ...metadata, service },
        `${contextName} email dispatched successfully via ${service === 'sendgrid' ? 'SendGrid' : 'SMTP'}`,
      );
    } catch (error) {
      logger.error(
        { err: error, event: 'EMAIL_DISPATCH_FAILURE', service, ...metadata },
        `Failed to dispatch ${contextName} email via ${service === 'sendgrid' ? 'SendGrid' : 'SMTP'}`,
      );
      if (rethrowError) {
        throw error;
      }
    }
  }

  private async dispatchMail(options: DispatchMailOptions): Promise<void> {
    const { to, subject, text, html, contextName, rethrowError = false, metadata = {} } = options;

    if (this.isSendGridConfigured) {
      await this.executeSend(
        () =>
          sgMail.send({
            to,
            from: this.fromRecipient,
            subject,
            text,
            html,
          }),
        'sendgrid',
        contextName,
        rethrowError,
        metadata,
      );
      return;
    }

    if (this.transporter) {
      await this.executeSend(
        () =>
          this.transporter!.sendMail({
            from: this.fromHeaderValue,
            to,
            subject,
            text,
            html,
          }),
        'smtp',
        contextName,
        rethrowError,
        metadata,
      );
      return;
    }

    logger.info(
      metadata,
      `Email service not configured in environment. ${contextName} email skipped in development.`,
    );
  }

  public async dispatchDirectly(job: EmailJobData): Promise<void> {
    switch (job.type) {
      case 'PASSWORD_RESET':
        await this.sendPasswordResetEmail(job.payload);
        break;
      case 'INVITE':
        await this.sendInviteEmail(job.payload);
        break;
      case 'COURSE_ALLOCATED':
        await this.sendCourseAllocatedEmail(job.payload);
        break;
      case 'COURSE_DEADLINE_CHANGED':
        await this.sendCourseDeadlineChangedEmail(job.payload);
        break;
      case 'MENTOR_MAPPED':
        await this.sendMentorMappedEmail(job.payload);
        break;
      case 'MENTEE_REASSIGNED':
        await this.sendMenteeReassignedEmail(job.payload);
        break;
      case 'SUBMISSION_RECEIVED':
        await this.sendSubmissionReceivedEmail(job.payload);
        break;
      case 'ASSIGNMENT_GRADED':
        await this.sendAssignmentGradedEmail(job.payload);
        break;
      case 'RESUBMISSION_REQUESTED':
        await this.sendResubmissionRequestedEmail(job.payload);
        break;
      case 'ALLOCATION_COMPLETED':
        await this.sendAllocationCompletedEmail(job.payload);
        break;
      case 'TOPIC_DEADLINE_CHANGED':
        await this.sendTopicDeadlineChangedEmail(job.payload);
        break;
    }
  }

  public async sendPasswordResetEmail(options: SendPasswordResetOptions): Promise<void> {
    const { to, name, resetToken } = options;
    const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const { subject, text, html } = renderPasswordResetEmail({ name, resetUrl });

    await this.dispatchMail({
      to,
      subject,
      text,
      html,
      contextName: 'Password reset',
      metadata: {},
    });
  }

  public async sendInviteEmail(options: SendInviteEmailOptions): Promise<void> {
    const { to, name, temporaryPassword, role } = options;
    const loginUrl = `${env.FRONTEND_URL}/login`;
    const { subject, text, html } = renderInviteEmail({
      name,
      email: to,
      temporaryPassword,
      role,
      loginUrl,
    });

    await this.dispatchMail({
      to,
      subject,
      text,
      html,
      contextName: 'User invitation',
      rethrowError: true,
      metadata: { role },
    });
  }

  public async sendMentorMappedEmail(options: SendMentorMappedOptions): Promise<void> {
    const portalUrl = options.isMentor
      ? `${env.FRONTEND_URL}/mentor`
      : `${env.FRONTEND_URL}/mentee`;

    const { subject, text, html } = renderMentorMappedEmail({
      recipientName: options.recipientName,
      isMentor: options.isMentor,
      otherPartyName: options.otherPartyName,
      batchName: options.batchName,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Mentor mapping',
      metadata: { isMentor: options.isMentor, batchName: options.batchName },
    });
  }

  public async sendMenteeReassignedEmail(options: SendMenteeReassignedOptions): Promise<void> {
    const portalUrl =
      options.recipientRole === MenteeReassignRecipientRole.MENTEE
        ? `${env.FRONTEND_URL}/mentee`
        : `${env.FRONTEND_URL}/mentor`;

    const { subject, text, html } = renderMenteeReassignedEmail({
      recipientName: options.recipientName,
      recipientRole: options.recipientRole,
      menteeName: options.menteeName,
      mentorName: options.mentorName,
      batchName: options.batchName,
      reason: options.reason,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Mentee reassignment',
      metadata: { role: options.recipientRole, batchName: options.batchName },
    });
  }

  public async sendSubmissionReceivedEmail(options: SendSubmissionReceivedOptions): Promise<void> {
    const istTimeStr =
      options.submittedAt.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }) + ' IST';
    const { subject, text, html } = renderSubmissionReceivedEmail({
      recipientName: options.recipientName,
      menteeName: options.menteeName,
      assignmentTitle: options.assignmentTitle,
      courseTitle: options.courseTitle,
      version: options.version,
      submittedAtFormatted: istTimeStr,
      portalUrl: `${env.FRONTEND_URL}/submissions`,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Submission received',
      metadata: { menteeName: options.menteeName, assignmentTitle: options.assignmentTitle },
    });
  }

  public async sendAssignmentGradedEmail(options: SendAssignmentGradedOptions): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentee/assignments`;
    const { subject, text, html } = renderAssignmentGradedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Assignment graded',
      metadata: { assignmentTitle: options.assignmentTitle },
    });
  }

  public async sendResubmissionRequestedEmail(
    options: SendResubmissionRequestedOptions,
  ): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentee/assignments`;
    const { subject, text, html } = renderResubmissionRequestedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Resubmission requested',
      metadata: { assignmentTitle: options.assignmentTitle },
    });
  }

  public async sendCourseAllocatedEmail(options: SendCourseAllocatedOptions): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
    const { subject, text, html } = renderCourseAllocatedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Course allocation',
      metadata: { userId: options.userId, courseTitle: options.courseTitle },
    });
  }

  public async sendCourseDeadlineChangedEmail(
    options: SendCourseDeadlineChangedOptions,
  ): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
    const { subject, text, html } = renderCourseDeadlineChangedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Course deadline change',
      metadata: { userId: options.userId, courseTitle: options.courseTitle },
    });
  }

  public async sendAllocationCompletedEmail(
    options: SendAllocationCompletedOptions,
  ): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentor/mentees`;
    const { subject, text, html } = renderAllocationCompletedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Course completion',
      metadata: { courseTitle: options.courseTitle },
    });
  }

  public async sendTopicDeadlineChangedEmail(
    options: SendTopicDeadlineChangedOptions,
  ): Promise<void> {
    const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
    const { subject, text, html } = renderTopicDeadlineChangedEmail({
      ...options,
      portalUrl,
    });

    await this.dispatchMail({
      to: options.to,
      subject,
      text,
      html,
      contextName: 'Topic deadline change',
      metadata: { courseTitle: options.courseTitle, topicTitle: options.topicTitle },
    });
  }
}

export const emailService = new EmailService();
