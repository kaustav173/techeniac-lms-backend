import sgMail from '@sendgrid/mail';
import nodemailer, { Transporter } from 'nodemailer';

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

interface DispatchMailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  contextName: string;
  rethrowError?: boolean;
  metadata?: Record<string, unknown>;
}

function parseFromEmail(from: string): { email: string; name?: string } {
  const match = from.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
  if (match && match[2]) {
    const name = match[1]?.trim();
    const email = match[2].trim();
    return name ? { email, name } : { email };
  }
  return { email: from.trim() };
}

export class EmailService {
  private readonly transporter: Transporter | null = null;
  private readonly isSendGridConfigured: boolean = false;
  private readonly fromEmail: string;
  private readonly fromRecipient: { email: string; name?: string };

  constructor() {
    this.fromEmail = env.SENDGRID_FROM_EMAIL || env.SMTP_FROM;
    this.fromRecipient = parseFromEmail(this.fromEmail);

    if (env.EMAIL_PROVIDER === 'sendgrid' && env.SENDGRID_API_KEY) {
      sgMail.setApiKey(env.SENDGRID_API_KEY);
      this.isSendGridConfigured = true;
    } else if (env.SMTP_HOST) {
      // Port 465 requires direct SSL (secure: true); port 587 uses STARTTLS (secure: false)
      const secure = env.SMTP_PORT === 465 ? true : env.SMTP_SECURE && env.SMTP_PORT !== 587;
      this.transporter = nodemailer.createTransport({
        pool: true,
        maxConnections: 5,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure,
        requireTLS: true,
        auth:
          env.SMTP_USER && env.SMTP_PASS
            ? {
                user: env.SMTP_USER,
                pass: env.SMTP_PASS,
              }
            : undefined,
      });
    }
  }

  private async dispatchMail(options: DispatchMailOptions): Promise<void> {
    const { to, subject, text, html, contextName, rethrowError = false, metadata = {} } = options;

    if (this.isSendGridConfigured) {
      try {
        await sgMail.send({
          to,
          from: this.fromRecipient,
          subject,
          text,
          html,
        });

        logger.info(
          { ...metadata, service: 'sendgrid' },
          `${contextName} email dispatched successfully via SendGrid`,
        );
      } catch (error) {
        logger.error(
          { err: error, event: 'EMAIL_DISPATCH_FAILURE', service: 'sendgrid', ...metadata },
          `Failed to dispatch ${contextName} email via SendGrid`,
        );
        if (rethrowError) {
          throw error;
        }
      }
      return;
    }

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: this.fromEmail,
          to,
          subject,
          text,
          html,
        });

        logger.info(
          { ...metadata, service: 'smtp' },
          `${contextName} email dispatched successfully via SMTP`,
        );
      } catch (error) {
        logger.error(
          { err: error, event: 'EMAIL_DISPATCH_FAILURE', service: 'smtp', ...metadata },
          `Failed to dispatch ${contextName} email via SMTP`,
        );
        if (rethrowError) {
          throw error;
        }
      }
      return;
    }

    logger.info(
      metadata,
      `Email service not configured in environment. ${contextName} email skipped in development.`,
    );
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
      metadata: { to },
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
      metadata: { to, role },
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
