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
    assert.equal(enqueuedJobs[0].name, 'PASSWORD_RESET');
    assert.equal(enqueuedJobs[0].data.type, 'PASSWORD_RESET');
    assert.equal(enqueuedJobs[0].data.payload.to, 'reset@example.com');
    // Ensure raw resetToken is scrubbed and replaced with credentialKey
    const payload = enqueuedJobs[0].data.payload as { credentialKey?: string; resetToken?: string };
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
    assert.equal(dispatchedDirectly[0].type, 'PASSWORD_RESET');
    assert.equal(dispatchedDirectly[0].payload.to, 'fallback@example.com');
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
    assert.equal(enqueuedJobs[0].name, 'INVITE');
    assert.equal(enqueuedJobs[0].data.type, 'INVITE');

    // Ensure temporaryPassword is scrubbed and stored in credential store
    const invitePayload = enqueuedJobs[0].data.payload as {
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

    assert.equal(enqueuedJobs[1].name, 'COURSE_ALLOCATED');
    assert.equal(enqueuedJobs[1].data.type, 'COURSE_ALLOCATED');
    assert.equal(dispatchedDirectly.length, 0);
  });
});
