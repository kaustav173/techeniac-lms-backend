import sgMail from '@sendgrid/mail';
import nodemailer, { Transporter } from 'nodemailer';

import { enqueueEmailJob, getEmailQueue } from '../../jobs/email.queue';
import type { EmailJobData } from '../../jobs/email.types';
import {
  deleteEmailCredential,
  retrieveEmailCredential,
  storeEmailCredential,
} from '../../jobs/redis-connection';
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
  resetToken?: string;
  credentialKey?: string;
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
  temporaryPassword?: string;
  role: string;
  credentialKey?: string;
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

  private async enqueueOrDispatch(job: EmailJobData): Promise<void> {
    const enqueued = await enqueueEmailJob(job);
    if (enqueued) {
      return;
    }

    logger.warn(
      { jobType: job.type },
      'BullMQ email queue unavailable; falling back to direct dispatch',
    );
    try {
      await this.dispatchDirectly(job);
    } catch (error) {
      logger.error({ err: error, jobType: job.type }, 'Direct fallback email dispatch failed');
      if (job.type === 'INVITE') {
        throw error;
      }
    }
  }

  public async dispatchDirectly(job: EmailJobData): Promise<void> {
    switch (job.type) {
      case 'PASSWORD_RESET': {
        const { to, name, resetToken: rawToken, credentialKey } = job.payload;
        let resetToken = rawToken;
        if (!resetToken && credentialKey) {
          resetToken = (await retrieveEmailCredential(credentialKey)) ?? undefined;
        }
        if (!resetToken) {
          throw new Error('Missing password reset token for dispatch');
        }
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
        if (credentialKey) {
          await deleteEmailCredential(credentialKey);
        }
        break;
      }
      case 'INVITE': {
        const { to, name, temporaryPassword: rawPassword, role, credentialKey } = job.payload;
        let temporaryPassword = rawPassword;
        if (!temporaryPassword && credentialKey) {
          temporaryPassword = (await retrieveEmailCredential(credentialKey)) ?? undefined;
        }
        if (!temporaryPassword) {
          throw new Error('Missing temporary password for user invitation dispatch');
        }
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
        if (credentialKey) {
          await deleteEmailCredential(credentialKey);
        }
        break;
      }
      case 'MENTOR_MAPPED': {
        const { to, recipientName, isMentor, otherPartyName, batchName } = job.payload;
        const portalUrl = isMentor ? `${env.FRONTEND_URL}/mentor` : `${env.FRONTEND_URL}/mentee`;
        const { subject, text, html } = renderMentorMappedEmail({
          recipientName,
          isMentor,
          otherPartyName,
          batchName,
          portalUrl,
        });
        await this.dispatchMail({
          to,
          subject,
          text,
          html,
          contextName: 'Mentor mapping',
          metadata: { isMentor, batchName },
        });
        break;
      }
      case 'MENTEE_REASSIGNED': {
        const { to, recipientName, recipientRole, menteeName, mentorName, batchName, reason } =
          job.payload;
        const portalUrl =
          recipientRole === MenteeReassignRecipientRole.MENTEE
            ? `${env.FRONTEND_URL}/mentee`
            : `${env.FRONTEND_URL}/mentor`;
        const { subject, text, html } = renderMenteeReassignedEmail({
          recipientName,
          recipientRole,
          menteeName,
          mentorName,
          batchName,
          reason,
          portalUrl,
        });
        await this.dispatchMail({
          to,
          subject,
          text,
          html,
          contextName: 'Mentee reassignment',
          metadata: { role: recipientRole, batchName },
        });
        break;
      }
      case 'SUBMISSION_RECEIVED': {
        const {
          to,
          recipientName,
          menteeName,
          assignmentTitle,
          courseTitle,
          version,
          submittedAt,
        } = job.payload;
        const submittedDate = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
        const istTimeStr =
          submittedDate.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'medium',
          }) + ' IST';
        const { subject, text, html } = renderSubmissionReceivedEmail({
          recipientName,
          menteeName,
          assignmentTitle,
          courseTitle,
          version,
          submittedAtFormatted: istTimeStr,
          portalUrl: `${env.FRONTEND_URL}/submissions`,
        });
        await this.dispatchMail({
          to,
          subject,
          text,
          html,
          contextName: 'Submission received',
          metadata: { menteeName, assignmentTitle },
        });
        break;
      }
      case 'ASSIGNMENT_GRADED': {
        const portalUrl = `${env.FRONTEND_URL}/mentee/assignments`;
        const { subject, text, html } = renderAssignmentGradedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Assignment graded',
          metadata: { assignmentTitle: job.payload.assignmentTitle },
        });
        break;
      }
      case 'RESUBMISSION_REQUESTED': {
        const portalUrl = `${env.FRONTEND_URL}/mentee/assignments`;
        const { subject, text, html } = renderResubmissionRequestedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Resubmission requested',
          metadata: { assignmentTitle: job.payload.assignmentTitle },
        });
        break;
      }
      case 'COURSE_ALLOCATED': {
        const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
        const { subject, text, html } = renderCourseAllocatedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Course allocation',
          metadata: { userId: job.payload.userId, courseTitle: job.payload.courseTitle },
        });
        break;
      }
      case 'COURSE_DEADLINE_CHANGED': {
        const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
        const { subject, text, html } = renderCourseDeadlineChangedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Course deadline change',
          metadata: { userId: job.payload.userId, courseTitle: job.payload.courseTitle },
        });
        break;
      }
      case 'ALLOCATION_COMPLETED': {
        const portalUrl = `${env.FRONTEND_URL}/mentor/mentees`;
        const { subject, text, html } = renderAllocationCompletedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Course completion',
          metadata: { courseTitle: job.payload.courseTitle },
        });
        break;
      }
      case 'TOPIC_DEADLINE_CHANGED': {
        const portalUrl = `${env.FRONTEND_URL}/mentee/courses`;
        const { subject, text, html } = renderTopicDeadlineChangedEmail({
          ...job.payload,
          portalUrl,
        });
        await this.dispatchMail({
          to: job.payload.to,
          subject,
          text,
          html,
          contextName: 'Topic deadline change',
          metadata: { courseTitle: job.payload.courseTitle, topicTitle: job.payload.topicTitle },
        });
        break;
      }
    }
  }

  public async sendPasswordResetEmail(options: SendPasswordResetOptions): Promise<void> {
    const queue = getEmailQueue();
    if (queue && options.resetToken) {
      try {
        const credentialKey = await storeEmailCredential(options.resetToken);
        const enqueued = await enqueueEmailJob({
          type: 'PASSWORD_RESET',
          payload: {
            to: options.to,
            name: options.name,
            credentialKey,
          },
        });
        if (enqueued) {
          return;
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to store reset token in credential store; falling back to direct dispatch',
        );
      }
    }

    logger.warn(
      'BullMQ email queue unavailable; falling back to direct dispatch for password reset',
    );
    await this.dispatchDirectly({ type: 'PASSWORD_RESET', payload: options });
  }

  public async sendInviteEmail(options: SendInviteEmailOptions): Promise<void> {
    const queue = getEmailQueue();
    if (queue && options.temporaryPassword) {
      try {
        const credentialKey = await storeEmailCredential(options.temporaryPassword);
        const enqueued = await enqueueEmailJob({
          type: 'INVITE',
          payload: {
            to: options.to,
            name: options.name,
            role: options.role,
            credentialKey,
          },
        });
        if (enqueued) {
          return;
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to store temporary password in credential store; falling back to direct dispatch',
        );
      }
    }

    logger.warn('BullMQ email queue unavailable; falling back to direct dispatch for user invite');
    try {
      await this.dispatchDirectly({ type: 'INVITE', payload: options });
    } catch (error) {
      logger.error({ err: error }, 'Direct fallback user invitation email dispatch failed');
      throw error;
    }
  }

  public async sendMentorMappedEmail(options: SendMentorMappedOptions): Promise<void> {
    await this.enqueueOrDispatch({ type: 'MENTOR_MAPPED', payload: options });
  }

  public async sendMenteeReassignedEmail(options: SendMenteeReassignedOptions): Promise<void> {
    await this.enqueueOrDispatch({ type: 'MENTEE_REASSIGNED', payload: options });
  }

  public async sendSubmissionReceivedEmail(options: SendSubmissionReceivedOptions): Promise<void> {
    await this.enqueueOrDispatch({ type: 'SUBMISSION_RECEIVED', payload: options });
  }

  public async sendAssignmentGradedEmail(options: SendAssignmentGradedOptions): Promise<void> {
    await this.enqueueOrDispatch({ type: 'ASSIGNMENT_GRADED', payload: options });
  }

  public async sendResubmissionRequestedEmail(
    options: SendResubmissionRequestedOptions,
  ): Promise<void> {
    await this.enqueueOrDispatch({ type: 'RESUBMISSION_REQUESTED', payload: options });
  }

  public async sendCourseAllocatedEmail(options: SendCourseAllocatedOptions): Promise<void> {
    await this.enqueueOrDispatch({ type: 'COURSE_ALLOCATED', payload: options });
  }

  public async sendCourseDeadlineChangedEmail(
    options: SendCourseDeadlineChangedOptions,
  ): Promise<void> {
    await this.enqueueOrDispatch({ type: 'COURSE_DEADLINE_CHANGED', payload: options });
  }

  public async sendAllocationCompletedEmail(
    options: SendAllocationCompletedOptions,
  ): Promise<void> {
    await this.enqueueOrDispatch({ type: 'ALLOCATION_COMPLETED', payload: options });
  }

  public async sendTopicDeadlineChangedEmail(
    options: SendTopicDeadlineChangedOptions,
  ): Promise<void> {
    await this.enqueueOrDispatch({ type: 'TOPIC_DEADLINE_CHANGED', payload: options });
  }
}

export const emailService = new EmailService();
