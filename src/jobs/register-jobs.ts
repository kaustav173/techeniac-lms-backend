import { Queue } from 'bullmq';

import { logger } from '../core/logging';
import { registerBullBoardQueue } from './bull-board';
import { closeEmailQueue, initEmailQueue } from './email.queue';
import { createEmailWorker } from './email.worker';
import {
  createOverdueWorker,
  DEADLINE_REMINDER_JOB_NAME,
  OVERDUE_DETECTION_JOB_NAME,
  OVERDUE_JOBS_QUEUE_NAME,
} from './overdue.worker';
import { redisConnection } from './redis-connection';
import { createTokenCleanupWorker, TOKEN_CLEANUP_QUEUE_NAME } from './token-cleanup.worker';

export const TOKEN_CLEANUP_SCHEDULER_ID = 'hourly-token-cleanup';
export const TOKEN_CLEANUP_JOB_NAME = 'cleanup-expired-tokens';
export const OVERDUE_DETECTION_SCHEDULER_ID = 'daily-overdue-detection';
export const DEADLINE_REMINDER_SCHEDULER_ID = 'daily-deadline-reminders';

let tokenCleanupQueue: Queue | null = null;
let tokenCleanupWorker: ReturnType<typeof createTokenCleanupWorker> | null = null;
let emailWorker: ReturnType<typeof createEmailWorker> | null = null;
let overdueQueue: Queue | null = null;
let overdueWorker: ReturnType<typeof createOverdueWorker> | null = null;

export async function registerScheduledJobs(): Promise<void> {
  try {
    if (tokenCleanupQueue || emailWorker || overdueWorker) {
      await closeScheduledJobs();
    }

    const emailQueue = initEmailQueue();
    registerBullBoardQueue(emailQueue);
    emailWorker = createEmailWorker();
    logger.info('Initialized BullMQ email worker and registered queue in Bull Board');

    tokenCleanupQueue = new Queue(TOKEN_CLEANUP_QUEUE_NAME, {
      connection: redisConnection,
    });

    // BullMQ v6 upsertJobScheduler: idempotent registration preventing duplicate schedules
    await tokenCleanupQueue.upsertJobScheduler(
      TOKEN_CLEANUP_SCHEDULER_ID,
      {
        pattern: '0 * * * *',
      },
      {
        name: TOKEN_CLEANUP_JOB_NAME,
        opts: {
          removeOnComplete: 50,
          removeOnFail: 100,
        },
      },
    );

    registerBullBoardQueue(tokenCleanupQueue);

    logger.info('Registered hourly token cleanup scheduled job with BullMQ');

    tokenCleanupWorker = createTokenCleanupWorker();
    logger.info('Initialized BullMQ token cleanup worker');

    overdueQueue = new Queue(OVERDUE_JOBS_QUEUE_NAME, {
      connection: redisConnection,
    });
    registerBullBoardQueue(overdueQueue);

    await overdueQueue.upsertJobScheduler(
      OVERDUE_DETECTION_SCHEDULER_ID,
      {
        pattern: '0 0 * * *',
      },
      {
        name: OVERDUE_DETECTION_JOB_NAME,
        opts: {
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      },
    );

    await overdueQueue.upsertJobScheduler(
      DEADLINE_REMINDER_SCHEDULER_ID,
      {
        pattern: '0 8 * * *',
      },
      {
        name: DEADLINE_REMINDER_JOB_NAME,
        opts: {
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      },
    );

    logger.info('Registered daily overdue and deadline scheduled jobs with BullMQ');

    overdueWorker = createOverdueWorker();
    logger.info('Initialized BullMQ overdue worker');
  } catch (err) {
    logger.error({ err }, 'Failed to register BullMQ scheduled jobs');
    throw err;
  }
}

export async function closeScheduledJobs(): Promise<void> {
  if (emailWorker) {
    logger.info('Closing BullMQ email worker...');
    await emailWorker.close();
    emailWorker = null;
  }

  logger.info('Closing BullMQ email queue...');
  await closeEmailQueue();

  if (tokenCleanupWorker) {
    logger.info('Closing BullMQ token cleanup worker...');
    await tokenCleanupWorker.close();
    tokenCleanupWorker = null;
  }

  if (tokenCleanupQueue) {
    logger.info('Closing BullMQ token cleanup queue...');
    await tokenCleanupQueue.close();
    tokenCleanupQueue = null;
  }

  if (overdueWorker) {
    logger.info('Closing BullMQ overdue worker...');
    await overdueWorker.close();
    overdueWorker = null;
  }

  if (overdueQueue) {
    logger.info('Closing BullMQ overdue queue...');
    await overdueQueue.close();
    overdueQueue = null;
  }
}
