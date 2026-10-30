import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Job } from 'bullmq';

import { emailService } from '../../src/core/email';
import { EMAIL_QUEUE_NAME } from '../../src/jobs/email.queue';
import type { EmailJobData } from '../../src/jobs/email.types';
import { createEmailWorker, processEmailJob } from '../../src/jobs/email.worker';

void describe('Email Worker Unit Tests', () => {
  void it('creates a BullMQ worker on the email-queue queue', async () => {
    const worker = createEmailWorker();
    try {
      assert.equal(worker.name, EMAIL_QUEUE_NAME);
    } finally {
      await worker.close();
    }
  });

  void it('processEmailJob forwards job payload to emailService.dispatchDirectly', async () => {
    let dispatchedJob: EmailJobData | null = null;
    const originalDispatch = emailService.dispatchDirectly?.bind(emailService);

    // Mock dispatchDirectly
    emailService.dispatchDirectly = (job: EmailJobData): Promise<void> => {
      dispatchedJob = job;
      return Promise.resolve();
    };

    const mockJob = {
      id: 'job-email-test-1',
      data: {
        type: 'PASSWORD_RESET',
        payload: {
          to: 'test@example.com',
          name: 'Tester',
          resetToken: 'token-abc',
        },
      },
    } as unknown as Job<EmailJobData>;

    try {
      await processEmailJob(mockJob);
      assert.deepEqual(dispatchedJob, mockJob.data);
    } finally {
      if (originalDispatch) {
        emailService.dispatchDirectly = originalDispatch;
      }
    }
  });
});
