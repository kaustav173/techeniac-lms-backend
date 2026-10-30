import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Queue } from 'bullmq';

import {
  closeEmailQueue,
  EMAIL_QUEUE_NAME,
  enqueueEmailJob,
  getEmailQueue,
  initEmailQueue,
} from '../../src/jobs/email.queue';
import type { EmailJobData } from '../../src/jobs/email.types';

void describe('Email Queue Unit Tests', () => {
  void it('exports the correct queue name', () => {
    assert.equal(EMAIL_QUEUE_NAME, 'email-queue');
  });

  void it('returns false when enqueuing to uninitialized queue', async () => {
    await closeEmailQueue();
    const result = await enqueueEmailJob({
      type: 'PASSWORD_RESET',
      payload: { to: 'test@example.com', resetToken: 'tok123' },
    });
    assert.equal(result, false);
  });

  void it('adds job with retry options when queue is initialized', async () => {
    let addedName = '';
    let addedData: EmailJobData | null = null;
    let addedOpts: Record<string, unknown> | null = null;

    const mockQueue = {
      name: EMAIL_QUEUE_NAME,
      add: (name: string, data: EmailJobData, opts: Record<string, unknown>) => {
        addedName = name;
        addedData = data;
        addedOpts = opts;
        return Promise.resolve({ id: 'job-1' });
      },
      close: () => Promise.resolve(),
    } as unknown as Queue<EmailJobData>;

    // Inject mock queue directly or test through custom initializer
    initEmailQueue(mockQueue);
    assert.equal(getEmailQueue(), mockQueue);

    const testJob: EmailJobData = {
      type: 'INVITE',
      payload: {
        to: 'user@example.com',
        name: 'John Doe',
        temporaryPassword: 'TempPassword123!',
        role: 'MENTEE',
      },
    };

    const success = await enqueueEmailJob(testJob);
    assert.equal(success, true);
    assert.equal(addedName, 'INVITE');
    assert.deepEqual(addedData, testJob);
    assert.equal((addedOpts as { attempts: number })?.attempts, 3);
    assert.deepEqual((addedOpts as { backoff: unknown })?.backoff, {
      type: 'exponential',
      delay: 2000,
    });

    await closeEmailQueue();
    assert.equal(getEmailQueue(), null);
  });
});
