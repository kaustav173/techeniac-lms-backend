import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';

import { EmailService, parseFromEmail } from '../../src/core/email/email.service';

void describe('EmailService Unit Tests - SendGrid & Unified Dispatch', () => {
  void describe('parseFromEmail', () => {
    void it('parses bare email address', () => {
      const parsed = parseFromEmail('test@techeniac.com');
      assert.deepStrictEqual(parsed, { email: 'test@techeniac.com' });
    });

    void it('parses formatted name and bracketed email', () => {
      const parsed = parseFromEmail('Techeniac LMS <test@techeniac.com>');
      assert.deepStrictEqual(parsed, { email: 'test@techeniac.com', name: 'Techeniac LMS' });
    });

    void it('trims leading and trailing whitespace on bracketed email', () => {
      const parsed = parseFromEmail('   Techeniac LMS <test@techeniac.com>  \n');
      assert.deepStrictEqual(parsed, { email: 'test@techeniac.com', name: 'Techeniac LMS' });
    });

    void it('trims whitespace on bare email', () => {
      const parsed = parseFromEmail('  test@techeniac.com   ');
      assert.deepStrictEqual(parsed, { email: 'test@techeniac.com' });
    });

    void it('handles quoted display names', () => {
      const parsed = parseFromEmail('"Techeniac Team" <test@techeniac.com>');
      assert.deepStrictEqual(parsed, { email: 'test@techeniac.com', name: 'Techeniac Team' });
    });
  });

  void describe('Constructor & Provider Activation', () => {
    void it('does not activate SendGrid when sendgridApiKey is missing', () => {
      const emailService = new EmailService({
        emailProvider: 'sendgrid',
        sendgridApiKey: undefined,
        smtpHost: undefined,
      });

      // Internal sendgrid activation is false, should skip dispatch without error
      assert.strictEqual(emailService['isSendGridConfigured'], false);
    });

    void it('activates SendGrid when emailProvider is sendgrid and api key is provided', () => {
      const emailService = new EmailService({
        emailProvider: 'sendgrid',
        sendgridApiKey: 'SG.test-api-key',
        sendgridFromEmail: 'Techeniac LMS <test@techeniac.com>',
      });

      assert.strictEqual(emailService['isSendGridConfigured'], true);
      assert.strictEqual(emailService['fromRecipient'].email, 'test@techeniac.com');
      assert.strictEqual(emailService['fromRecipient'].name, 'Techeniac LMS');
    });

    void it('configures SMTP transport when smtpHost is provided and sendgrid is not active', () => {
      const emailService = new EmailService({
        emailProvider: 'smtp',
        smtpHost: 'smtp.mailtrap.io',
        smtpPort: 587,
        smtpFrom: 'Techeniac LMS <noreply@techeniac.com>',
      });

      assert.strictEqual(emailService['isSendGridConfigured'], false);
      assert.notStrictEqual(emailService['transporter'], null);
    });
  });

  void describe('SendGrid Dispatch', () => {
    void it('dispatches password reset email via SendGrid when configured', async () => {
      let capturedPayload: unknown = null;
      const originalSend = sgMail.send.bind(sgMail);

      sgMail.send = (payload: Parameters<typeof sgMail.send>[0]) => {
        capturedPayload = payload;
        return Promise.resolve([{}, {}]) as ReturnType<typeof sgMail.send>;
      };

      try {
        const emailService = new EmailService({
          emailProvider: 'sendgrid',
          sendgridApiKey: 'SG.test-api-key',
          sendgridFromEmail: 'Techeniac LMS <test@techeniac.com>',
        });

        await emailService.sendPasswordResetEmail({
          to: 'user@example.com',
          name: 'John Doe',
          resetToken: 'test-token-123',
        });

        assert.notEqual(capturedPayload, null);
        const payload = capturedPayload as {
          to: string;
          from: { email: string; name?: string };
          subject: string;
          html: string;
        };
        assert.strictEqual(payload.to, 'user@example.com');
        assert.strictEqual(payload.from.email, 'test@techeniac.com');
        assert.strictEqual(payload.from.name, 'Techeniac LMS');
        assert.match(payload.subject, /reset.*password/i);
        assert.match(payload.html, /test-token-123/);
      } finally {
        sgMail.send = originalSend;
      }
    });

    void it('rethrows error on sendInviteEmail when SendGrid fails', async () => {
      const originalSend = sgMail.send.bind(sgMail);
      sgMail.send = () => {
        return Promise.reject(new Error('SendGrid API key invalid'));
      };

      try {
        const emailService = new EmailService({
          emailProvider: 'sendgrid',
          sendgridApiKey: 'SG.test-api-key',
          sendgridFromEmail: 'test@techeniac.com',
        });

        await assert.rejects(
          async () => {
            await emailService.sendInviteEmail({
              to: 'invitee@example.com',
              name: 'Alice',
              temporaryPassword: 'TempPassword123!',
              role: 'MENTEE',
            });
          },
          {
            name: 'Error',
            message: 'SendGrid API key invalid',
          },
        );
      } finally {
        sgMail.send = originalSend;
      }
    });

    void it('suppresses error on notification emails (sendCourseAllocatedEmail) when SendGrid fails', async () => {
      let sendCalled = false;
      const originalSend = sgMail.send.bind(sgMail);
      sgMail.send = () => {
        sendCalled = true;
        return Promise.reject(new Error('Rate limit exceeded'));
      };

      try {
        const emailService = new EmailService({
          emailProvider: 'sendgrid',
          sendgridApiKey: 'SG.test-api-key',
          sendgridFromEmail: 'test@techeniac.com',
        });

        await emailService.sendCourseAllocatedEmail({
          to: 'mentee@example.com',
          recipientName: 'Mentee Bob',
          courseTitle: 'Fullstack Next.js',
          startDate: '2026-11-01',
          dueDate: '2026-12-01',
        });

        assert.strictEqual(sendCalled, true, 'Expected SendGrid send to have been invoked');
      } finally {
        sgMail.send = originalSend;
      }
    });
  });

  void describe('SMTP Dispatch', () => {
    void it('dispatches password reset email via SMTP when configured', async () => {
      let capturedMail: unknown = null;
      const originalCreateTransport = nodemailer.createTransport;
      const mailer = nodemailer as unknown as {
        createTransport: (...args: unknown[]) => {
          sendMail: (options: unknown) => Promise<unknown>;
        };
      };

      mailer.createTransport = () => ({
        sendMail: (options: unknown) => {
          capturedMail = options;
          return Promise.resolve({ messageId: 'test-smtp-id' });
        },
      });

      try {
        const emailService = new EmailService({
          emailProvider: 'smtp',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpFrom: 'Techeniac LMS <noreply@techeniac.com>',
        });

        await emailService.sendPasswordResetEmail({
          to: 'smtpuser@example.com',
          name: 'Jane Doe',
          resetToken: 'smtp-token-456',
        });

        assert.notEqual(capturedMail, null);
        const mail = capturedMail as {
          to: string;
          from: string;
          subject: string;
          html: string;
        };
        assert.strictEqual(mail.to, 'smtpuser@example.com');
        assert.strictEqual(mail.from, 'Techeniac LMS <noreply@techeniac.com>');
        assert.match(mail.subject, /reset.*password/i);
        assert.match(mail.html, /smtp-token-456/);
      } finally {
        mailer.createTransport = originalCreateTransport;
      }
    });

    void it('rethrows error on sendInviteEmail when SMTP fails', async () => {
      const originalCreateTransport = nodemailer.createTransport;
      const mailer = nodemailer as unknown as {
        createTransport: (...args: unknown[]) => {
          sendMail: (options: unknown) => Promise<unknown>;
        };
      };

      mailer.createTransport = () => ({
        sendMail: () => Promise.reject(new Error('SMTP connection refused')),
      });

      try {
        const emailService = new EmailService({
          emailProvider: 'smtp',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpFrom: 'noreply@techeniac.com',
        });

        await assert.rejects(
          async () => {
            await emailService.sendInviteEmail({
              to: 'invitee@example.com',
              name: 'Alice',
              temporaryPassword: 'TempPassword123!',
              role: 'MENTEE',
            });
          },
          {
            name: 'Error',
            message: 'SMTP connection refused',
          },
        );
      } finally {
        mailer.createTransport = originalCreateTransport;
      }
    });

    void it('suppresses error on notification emails when SMTP fails', async () => {
      let sendCalled = false;
      const originalCreateTransport = nodemailer.createTransport;
      const mailer = nodemailer as unknown as {
        createTransport: (...args: unknown[]) => {
          sendMail: (options: unknown) => Promise<unknown>;
        };
      };

      mailer.createTransport = () => ({
        sendMail: () => {
          sendCalled = true;
          return Promise.reject(new Error('SMTP timeout'));
        },
      });

      try {
        const emailService = new EmailService({
          emailProvider: 'smtp',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpFrom: 'noreply@techeniac.com',
        });

        await emailService.sendCourseAllocatedEmail({
          to: 'mentee@example.com',
          recipientName: 'Mentee Bob',
          courseTitle: 'Fullstack Next.js',
          startDate: '2026-11-01',
          dueDate: '2026-12-01',
        });

        assert.strictEqual(sendCalled, true, 'Expected SMTP sendMail to have been invoked');
      } finally {
        mailer.createTransport = originalCreateTransport;
      }
    });
  });

  void describe('Unconfigured Fallback', () => {
    void it('skips email gracefully without crashing when neither SendGrid nor SMTP is configured', async () => {
      const emailService = new EmailService({
        emailProvider: 'smtp',
        smtpHost: undefined,
      });

      await emailService.sendMentorMappedEmail({
        to: 'mentor@example.com',
        recipientName: 'Mentor Dave',
        isMentor: true,
        otherPartyName: 'Mentee Eve',
        batchName: 'Cohort Alpha',
      });

      assert.ok(true, 'Skipped gracefully without error');
    });
  });
});
