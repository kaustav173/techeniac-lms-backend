import { type Job, Worker } from 'bullmq';

import { eventBus } from '../core/lifecycle';
import { logger } from '../core/logging';
import { allocationsRepository } from '../modules/allocations';
import { progressRepository } from '../modules/progress';
import { redisConnection } from './redis-connection';

export const OVERDUE_JOBS_QUEUE_NAME = 'overdue-jobs';
export const OVERDUE_DETECTION_JOB_NAME = 'detect-overdue';
export const DEADLINE_REMINDER_JOB_NAME = 'remind-deadlines';

export async function processOverdueDetection(
  allocRepo = allocationsRepository,
  topicRepo = progressRepository,
): Promise<{ overdueAllocationsCount: number; overdueTopicsCount: number }> {
  const overdueAllocations = await allocRepo.findOverdueAllocations();

  for (const ca of overdueAllocations) {
    eventBus.emitEvent('allocation.overdueDetected', {
      allocationId: ca.id,
      userId: ca.userId,
      courseId: ca.courseId,
      dueDate: ca.dueDate,
    });
  }

  const overdueTopics = await topicRepo.findOverdueTopics();

  for (const tp of overdueTopics) {
    if (tp.deadline) {
      eventBus.emitEvent('topic.overdueDetected', {
        topicProgressId: tp.id,
        courseAllocationId: tp.courseAllocationId,
        topicId: tp.topicId,
        deadline: tp.deadline,
      });
    }
  }

  return {
    overdueAllocationsCount: overdueAllocations.length,
    overdueTopicsCount: overdueTopics.length,
  };
}

export async function processDeadlineReminders(
  allocRepo = allocationsRepository,
): Promise<{ reminderAllocationsCount: number }> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 48 * 3600000);
  const upcomingAllocations = await allocRepo.findUpcomingDeadlines(now, windowEnd);

  for (const ca of upcomingAllocations) {
    const hoursRemaining = Math.max(
      0,
      Math.round((new Date(ca.dueDate).getTime() - now.getTime()) / 3600000),
    );

    eventBus.emitEvent('allocation.reminderDue', {
      allocationId: ca.id,
      userId: ca.userId,
      courseId: ca.courseId,
      dueDate: ca.dueDate,
      hoursRemaining,
    });
  }

  return {
    reminderAllocationsCount: upcomingAllocations.length,
  };
}

export function createOverdueWorker(): Worker {
  const worker = new Worker(
    OVERDUE_JOBS_QUEUE_NAME,
    async (job: Job) => {
      logger.info({ jobId: job.id, jobName: job.name }, 'Processing scheduled overdue job');
      if (job.name === OVERDUE_DETECTION_JOB_NAME) {
        const result = await processOverdueDetection();
        logger.info({ jobId: job.id, ...result }, 'Overdue detection job completed');
        return result;
      }
      if (job.name === DEADLINE_REMINDER_JOB_NAME) {
        const result = await processDeadlineReminders();
        logger.info({ jobId: job.id, ...result }, 'Deadline reminder job completed');
        return result;
      }
      logger.warn({ jobId: job.id, jobName: job.name }, 'Unknown job name in overdue worker');
      return {};
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
