import { type Job, Worker } from 'bullmq';

import { logger } from '../core/logging';
import { allocationsService } from '../modules/allocations';
import { progressService } from '../modules/progress';
import { redisConnection } from './redis-connection';

export const OVERDUE_JOBS_QUEUE_NAME = 'overdue-jobs';
export const OVERDUE_DETECTION_JOB_NAME = 'detect-overdue';
export const DEADLINE_REMINDER_JOB_NAME = 'remind-deadlines';

export async function processOverdueJob(job: Job): Promise<Record<string, unknown>> {
  logger.info({ jobId: job.id, jobName: job.name }, 'Processing scheduled overdue job');

  if (job.name === OVERDUE_DETECTION_JOB_NAME) {
    const allocResult = await allocationsService.detectOverdueAllocations();
    const topicResult = await progressService.detectOverdueTopics();
    const result = {
      ...allocResult,
      ...topicResult,
    };
    logger.info({ jobId: job.id, ...result }, 'Overdue detection job completed');
    return result;
  }

  if (job.name === DEADLINE_REMINDER_JOB_NAME) {
    const result = await allocationsService.processDeadlineReminders();
    logger.info({ jobId: job.id, ...result }, 'Deadline reminder job completed');
    return result;
  }

  logger.warn({ jobId: job.id, jobName: job.name }, 'Unknown job name in overdue worker');
  throw new Error(`Unknown job name in overdue worker: ${job.name}`);
}

export function createOverdueWorker(): Worker {
  const worker = new Worker(
    OVERDUE_JOBS_QUEUE_NAME,
    async (job: Job) => {
      return await processOverdueJob(job);
    },
    {
      connection: redisConnection,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err }, 'Overdue worker job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Overdue worker encountered internal error');
  });

  return worker;
}
