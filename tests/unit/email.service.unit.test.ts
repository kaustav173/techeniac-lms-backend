import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sgMail from '@sendgrid/mail';

import { EmailService } from '../../src/core/email/email.service';

void describe('EmailService Unit Tests - SendGrid & Unified Dispatch', () => {
  void it('dispatches password reset email via SendGrid when configured', async () => {
    let capturedPayload: unknown = null;
    const originalSend = sgMail.send.bind(sgMail);

    sgMail.send = (payload: Parameters<typeof sgMail.send>[0]) => {
      capturedPayload = payload;
      return Promise.resolve([{}, {}]) as ReturnType<typeof sgMail.send>;
    };

    try {
      const emailService = new EmailService();
      Object.assign(emailService, {
        isSendGridConfigured: true,
        fromEmail: 'test@techeniac.com',
        fromRecipient: { email: 'test@techeniac.com', name: 'Techeniac LMS' },
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
      const emailService = new EmailService();
      Object.assign(emailService, { isSendGridConfigured: true, fromEmail: 'test@techeniac.com' });

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
    const originalSend = sgMail.send.bind(sgMail);
    sgMail.send = () => {
      return Promise.reject(new Error('Rate limit exceeded'));
    };

    try {
      const emailService = new EmailService();
      Object.assign(emailService, { isSendGridConfigured: true, fromEmail: 'test@techeniac.com' });

      await emailService.sendCourseAllocatedEmail({
        to: 'mentee@example.com',
        recipientName: 'Mentee Bob',
        courseTitle: 'Fullstack Next.js',
        startDate: '2026-11-01',
        dueDate: '2026-12-01',
      });
      assert.ok(true, 'Successfully caught and logged error without throwing to caller');
    } finally {
      sgMail.send = originalSend;
    }
  });

  void it('skips email gracefully without crashing when neither SendGrid nor SMTP is configured', async () => {
    const emailService = new EmailService();
    Object.assign(emailService, { isSendGridConfigured: false, transporter: null });

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
