import { type JobsOptions, Queue } from 'bullmq';

import { logger } from '../core/logging';
import type { EmailJobData } from './email.types';
import { redisConnection } from './redis-connection';

export const EMAIL_QUEUE_NAME = 'email-queue';

export const DEFAULT_EMAIL_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
};

let emailQueueInstance: Queue<EmailJobData> | null = null;

export function initEmailQueue(existingQueue?: Queue<EmailJobData>): Queue<EmailJobData> {
  if (existingQueue) {
    emailQueueInstance = existingQueue;
    return emailQueueInstance;
  }

  if (!emailQueueInstance) {
    emailQueueInstance = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: DEFAULT_EMAIL_JOB_OPTS,
    });
  }

  return emailQueueInstance;
}

export function getEmailQueue(): Queue<EmailJobData> | null {
  return emailQueueInstance;
}

export async function enqueueEmailJob(job: EmailJobData): Promise<boolean> {
  if (!emailQueueInstance) {
    return false;
  }

  try {
    await emailQueueInstance.add(job.type, job, DEFAULT_EMAIL_JOB_OPTS);
    return true;
  } catch (error) {
    logger.warn({ err: error, jobType: job.type }, 'Failed to enqueue email job to BullMQ');
    return false;
  }
}

export async function closeEmailQueue(): Promise<void> {
  if (emailQueueInstance) {
    await emailQueueInstance.close();
    emailQueueInstance = null;
  }
}
