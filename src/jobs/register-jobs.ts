import { Queue } from 'bullmq';

import { logger } from '../core/logging';
import { registerBullBoardQueue } from './bull-board';
import { closeEmailQueue, initEmailQueue } from './email.queue';
import { createEmailWorker } from './email.worker';
import { closeRedisClient, producerRedisConnection } from './redis-connection';
import { createTokenCleanupWorker, TOKEN_CLEANUP_QUEUE_NAME } from './token-cleanup.worker';

export const TOKEN_CLEANUP_SCHEDULER_ID = 'hourly-token-cleanup';
export const TOKEN_CLEANUP_JOB_NAME = 'cleanup-expired-tokens';

let tokenCleanupQueue: Queue | null = null;
let tokenCleanupWorker: ReturnType<typeof createTokenCleanupWorker> | null = null;
let emailWorker: ReturnType<typeof createEmailWorker> | null = null;

export async function registerScheduledJobs(): Promise<void> {
  try {
    const emailQueue = initEmailQueue();
    registerBullBoardQueue(emailQueue);
    emailWorker = createEmailWorker();
    logger.info('Initialized BullMQ email worker and registered queue in Bull Board');

    tokenCleanupQueue = new Queue(TOKEN_CLEANUP_QUEUE_NAME, {
      connection: producerRedisConnection,
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

  await closeRedisClient();
}
