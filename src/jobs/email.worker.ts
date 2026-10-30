import { type Job, Worker } from 'bullmq';

import { emailService } from '../core/email';
import { logger } from '../core/logging';
import { EMAIL_QUEUE_NAME } from './email.queue';
import type { EmailJobData } from './email.types';
import { redisConnection } from './redis-connection';

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  logger.info({ jobId: job.id, jobType: job.data.type }, 'Processing BullMQ email job');
  await emailService.dispatchDirectly(job.data);
  logger.info(
    { jobId: job.id, jobType: job.data.type },
    'Email job dispatched successfully via worker',
  );
}

export function createEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      await processEmailJob(job);
    },
    {
      connection: redisConnection,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, jobType: job?.data?.type, attemptsMade: job?.attemptsMade, err },
      'Email worker job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Email worker encountered internal error');
  });

  return worker;
}
