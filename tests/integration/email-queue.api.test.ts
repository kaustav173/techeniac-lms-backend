import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

import { emailService } from '../../src/core/email';
import { closeEmailQueue, EMAIL_QUEUE_NAME, initEmailQueue } from '../../src/jobs/email.queue';
import type { EmailJobData } from '../../src/jobs/email.types';
import {
  closeRedisClient,
  producerRedisConnection,
  setRedisClient,
} from '../../src/jobs/redis-connection';

void describe('Email BullMQ Integration Tests', () => {
  let enqueuedJobs: Array<{ name: string; data: EmailJobData }> = [];
  let dispatchedDirectly: EmailJobData[] = [];
  let origDispatchDirectly: typeof emailService.dispatchDirectly;
  const inMemoryStore = new Map<string, string>();

  beforeEach(() => {
    enqueuedJobs = [];
    dispatchedDirectly = [];
    origDispatchDirectly = emailService.dispatchDirectly.bind(emailService);
    inMemoryStore.clear();

    const mockRedis = {
      set: (key: string, value: string) => {
        inMemoryStore.set(key, value);
        return Promise.resolve('OK');
      },
      get: (key: string) => Promise.resolve(inMemoryStore.get(key) ?? null),
      del: (key: string) => {
        inMemoryStore.delete(key);
        return Promise.resolve(1);
      },
      quit: () => Promise.resolve('OK'),
      disconnect: () => {},
      on: () => {},
    } as unknown as Redis;

    setRedisClient(mockRedis);

    emailService.dispatchDirectly = (job: EmailJobData): Promise<void> => {
      dispatchedDirectly.push(job);
      return Promise.resolve();
    };
  });

  afterEach(async () => {
    emailService.dispatchDirectly = origDispatchDirectly;
    setRedisClient(null);
    await closeRedisClient();
    await closeEmailQueue();
  });

  void it('exports producer connection with bounded maxRetriesPerRequest', () => {
    assert.equal(producerRedisConnection.maxRetriesPerRequest, 2);
  });

  void it('enqueues password reset email with scrubbed credential to BullMQ email-queue', async () => {
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
    const firstJob = enqueuedJobs[0];
    assert.ok(firstJob, 'Expected a job to be enqueued');
    assert.equal(firstJob.name, 'PASSWORD_RESET');
    assert.equal(firstJob.data.type, 'PASSWORD_RESET');
    assert.equal(firstJob.data.payload.to, 'reset@example.com');
    // Ensure raw resetToken is scrubbed and replaced with credentialKey
    const payload = firstJob.data.payload as { credentialKey?: string; resetToken?: string };
    assert.ok(payload.credentialKey, 'Expected credentialKey to be present');
    assert.equal(payload.resetToken, undefined, 'Expected raw resetToken to be scrubbed from job');
    assert.equal(inMemoryStore.get(`email:cred:${payload.credentialKey}`), 'test-token-456');

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
    const directJob = dispatchedDirectly[0];
    assert.ok(directJob, 'Expected fallback direct dispatch');
    assert.equal(directJob.type, 'PASSWORD_RESET');
    assert.equal(directJob.payload.to, 'fallback@example.com');
  });

  void it('routes multiple email types through the BullMQ queue and scrubs temporaryPassword', async () => {
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
    const inviteJob = enqueuedJobs[0];
    const courseJob = enqueuedJobs[1];
    assert.ok(inviteJob, 'Expected invite job to be enqueued');
    assert.ok(courseJob, 'Expected course allocated job to be enqueued');
    assert.equal(inviteJob.name, 'INVITE');
    assert.equal(inviteJob.data.type, 'INVITE');

    // Ensure temporaryPassword is scrubbed and stored in credential store
    const invitePayload = inviteJob.data.payload as {
      credentialKey?: string;
      temporaryPassword?: string;
    };
    assert.ok(invitePayload.credentialKey, 'Expected credentialKey on invite job');
    assert.equal(
      invitePayload.temporaryPassword,
      undefined,
      'Expected raw temporaryPassword to be scrubbed',
    );
    assert.equal(
      inMemoryStore.get(`email:cred:${invitePayload.credentialKey}`),
      'TempPassword123!',
    );

    assert.equal(courseJob.name, 'COURSE_ALLOCATED');
    assert.equal(courseJob.data.type, 'COURSE_ALLOCATED');
    assert.equal(dispatchedDirectly.length, 0);
  });

  void it('preserves PASSWORD_RESET credential on send failure and deletes it on success', async () => {
    const credentialKey = 'test-cred-uuid-123';
    inMemoryStore.set(`email:cred:${credentialKey}`, 'secret-reset-token');

    let simulateFailure = true;
    const origDispatchMail = (emailService as unknown as { dispatchMail: unknown })['dispatchMail'];
    (emailService as unknown as { dispatchMail: (options: unknown) => Promise<void> })[
      'dispatchMail'
    ] = () => {
      if (simulateFailure) {
        return Promise.reject(new Error('SMTP transient failure'));
      }
      return Promise.resolve();
    };

    try {
      // First attempt: delivery fails, should rethrow and PRESERVE the credential in Redis
      await assert.rejects(
        async () => {
          await origDispatchDirectly({
            type: 'PASSWORD_RESET',
            payload: {
              to: 'user@example.com',
              name: 'Test User',
              credentialKey,
            },
          });
        },
        {
          name: 'Error',
          message: 'SMTP transient failure',
        },
      );

      // Verify credential was NOT deleted
      assert.equal(
        inMemoryStore.get(`email:cred:${credentialKey}`),
        'secret-reset-token',
        'Credential must survive send failure to allow BullMQ/admin retry',
      );

      // Second attempt (retry): delivery succeeds
      simulateFailure = false;
      await origDispatchDirectly({
        type: 'PASSWORD_RESET',
        payload: {
          to: 'user@example.com',
          name: 'Test User',
          credentialKey,
        },
      });

      // Verify credential was now deleted after successful dispatch
      assert.equal(
        inMemoryStore.get(`email:cred:${credentialKey}`),
        undefined,
        'Credential must be deleted after successful delivery',
      );
    } finally {
      (emailService as unknown as { dispatchMail: unknown })['dispatchMail'] = origDispatchMail;
    }
  });

  void it('suppresses error in sendPasswordResetEmail when direct fallback fails', async () => {
    await closeEmailQueue();

    emailService.dispatchDirectly = () => Promise.reject(new Error('Direct fallback failure'));

    // Should not throw
    await emailService.sendPasswordResetEmail({
      to: 'fallback@example.com',
      name: 'Fallback User',
      resetToken: 'test-token',
    });

    assert.ok(true, 'Suppressed direct fallback error');
  });
});
