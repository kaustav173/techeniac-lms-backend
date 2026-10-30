import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Queue } from 'bullmq';

import { emailService } from '../../src/core/email';
import { closeEmailQueue, EMAIL_QUEUE_NAME, initEmailQueue } from '../../src/jobs/email.queue';
import type { EmailJobData } from '../../src/jobs/email.types';

void describe('Email BullMQ Integration Tests', () => {
  let enqueuedJobs: Array<{ name: string; data: EmailJobData }> = [];
  let dispatchedDirectly: EmailJobData[] = [];
  let origDispatchDirectly: typeof emailService.dispatchDirectly;

  beforeEach(() => {
    enqueuedJobs = [];
    dispatchedDirectly = [];
    origDispatchDirectly = emailService.dispatchDirectly.bind(emailService);

    emailService.dispatchDirectly = (job: EmailJobData): Promise<void> => {
      dispatchedDirectly.push(job);
      return Promise.resolve();
    };
  });

  afterEach(async () => {
    emailService.dispatchDirectly = origDispatchDirectly;
    await closeEmailQueue();
  });

  void it('enqueues password reset email to BullMQ email-queue when queue is initialized', async () => {
    const mockQueue = {
      name: EMAIL_QUEUE_NAME,
      add: (name: string, data: EmailJobData) => {
        enqueuedJobs.push({ name, data });
        return Promise.resolve({ id: 'test-job-id' });
      },
      close: () => Promise.resolve(),
    } as unknown as Queue<EmailJobData>;

    initEmailQueue(mockQueue);

    await emailService.sendPasswordResetEmail({
      to: 'reset@example.com',
      name: 'Reset User',
      resetToken: 'test-token-456',
    });

    assert.equal(enqueuedJobs.length, 1);
    assert.equal(enqueuedJobs[0].name, 'PASSWORD_RESET');
    assert.equal(enqueuedJobs[0].data.type, 'PASSWORD_RESET');
    assert.equal(enqueuedJobs[0].data.payload.to, 'reset@example.com');
    // Ensure direct dispatch was skipped because enqueuing succeeded
    assert.equal(dispatchedDirectly.length, 0);
  });

  void it('falls back to direct dispatch when BullMQ queue is unavailable', async () => {
    // Ensure queue is closed/null
    await closeEmailQueue();

    await emailService.sendPasswordResetEmail({
      to: 'fallback@example.com',
      name: 'Fallback User',
      resetToken: 'fallback-token-789',
    });

    // Nothing enqueued to BullMQ
    assert.equal(enqueuedJobs.length, 0);
    // Direct dispatch was invoked as fallback
    assert.equal(dispatchedDirectly.length, 1);
    assert.equal(dispatchedDirectly[0].type, 'PASSWORD_RESET');
    assert.equal(dispatchedDirectly[0].payload.to, 'fallback@example.com');
  });

  void it('routes multiple email types through the BullMQ queue', async () => {
    const mockQueue = {
      name: EMAIL_QUEUE_NAME,
      add: (name: string, data: EmailJobData) => {
        enqueuedJobs.push({ name, data });
        return Promise.resolve({ id: 'test-job-id' });
      },
      close: () => Promise.resolve(),
    } as unknown as Queue<EmailJobData>;

    initEmailQueue(mockQueue);

    await emailService.sendInviteEmail({
      to: 'invite@example.com',
      name: 'Invited User',
      temporaryPassword: 'TempPassword123!',
      role: 'MENTEE',
    });

    await emailService.sendCourseAllocatedEmail({
      to: 'course@example.com',
      recipientName: 'Mentee Student',
      courseTitle: 'TypeScript Mastery',
      startDate: '2026-11-01',
      dueDate: '2026-12-01',
    });

    assert.equal(enqueuedJobs.length, 2);
    assert.equal(enqueuedJobs[0].name, 'INVITE');
    assert.equal(enqueuedJobs[0].data.type, 'INVITE');
    assert.equal(enqueuedJobs[1].name, 'COURSE_ALLOCATED');
    assert.equal(enqueuedJobs[1].data.type, 'COURSE_ALLOCATED');
    assert.equal(dispatchedDirectly.length, 0);
  });
});
