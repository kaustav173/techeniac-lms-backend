import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Job } from 'bullmq';

import {
  type AllocationOverdueDetectedEvent,
  type AllocationReminderDueEvent,
  eventBus,
  type TopicOverdueDetectedEvent,
} from '../../src/core/lifecycle/event-bus';
import {
  createOverdueWorker,
  DEADLINE_REMINDER_JOB_NAME,
  OVERDUE_DETECTION_JOB_NAME,
  OVERDUE_JOBS_QUEUE_NAME,
  processOverdueJob,
} from '../../src/jobs/overdue.worker';
import {
  allocationsPolicy,
  type AllocationsRepository,
  AllocationsService,
  allocationsService,
  CourseAllocation,
  CourseAllocationStatus,
} from '../../src/modules/allocations';
import {
  progressPolicy,
  type ProgressRepository,
  ProgressService,
  progressService,
  TopicProgress,
  TopicProgressStatus,
} from '../../src/modules/progress';

void describe('Overdue Worker & Job Processors Unit Tests', () => {
  void it('exports expected queue and job names', () => {
    assert.equal(OVERDUE_JOBS_QUEUE_NAME, 'overdue-jobs');
    assert.equal(OVERDUE_DETECTION_JOB_NAME, 'detect-overdue');
    assert.equal(DEADLINE_REMINDER_JOB_NAME, 'remind-deadlines');
  });

  void it('AllocationsService.detectOverdueAllocations finds overdue allocations and emits events', async () => {
    const overdueAllocation = {
      id: 'alloc-1',
      userId: 'user-1',
      courseId: 'course-1',
      status: CourseAllocationStatus.IN_PROGRESS,
      dueDate: new Date(Date.now() - 3600000), // 1 hour ago
      deletedAt: null,
    } as unknown as CourseAllocation;

    const mockAllocRepo = {
      findOverdueAllocations: () => Promise.resolve([overdueAllocation]),
    } as unknown as AllocationsRepository;

    const service = new AllocationsService(mockAllocRepo, allocationsPolicy);
    const detectedAllocations: AllocationOverdueDetectedEvent[] = [];

    const allocHandler = (payload: AllocationOverdueDetectedEvent) => {
      detectedAllocations.push(payload);
    };

    eventBus.on('allocation.overdueDetected', allocHandler);

    try {
      const summary = await service.detectOverdueAllocations();
      assert.equal(summary.overdueAllocationsCount, 1);

      assert.equal(detectedAllocations.length, 1);
      assert.equal(detectedAllocations[0].allocationId, 'alloc-1');
      assert.equal(detectedAllocations[0].userId, 'user-1');
      assert.equal(detectedAllocations[0].courseId, 'course-1');
    } finally {
      eventBus.removeListener('allocation.overdueDetected', allocHandler);
    }
  });

  void it('ProgressService.detectOverdueTopics finds overdue topics and emits events', async () => {
    const overdueTopic = {
      id: 'tp-1',
      courseAllocationId: 'alloc-1',
      topicId: 'topic-1',
      status: TopicProgressStatus.IN_PROGRESS,
      deadline: new Date(Date.now() - 7200000), // 2 hours ago
      deletedAt: null,
    } as unknown as TopicProgress;

    const mockTopicRepo = {
      findOverdueTopics: () => Promise.resolve([overdueTopic]),
    } as unknown as ProgressRepository;

    const service = new ProgressService(mockTopicRepo, progressPolicy);
    const detectedTopics: TopicOverdueDetectedEvent[] = [];

    const topicHandler = (payload: TopicOverdueDetectedEvent) => {
      detectedTopics.push(payload);
    };

    eventBus.on('topic.overdueDetected', topicHandler);

    try {
      const summary = await service.detectOverdueTopics();
      assert.equal(summary.overdueTopicsCount, 1);

      assert.equal(detectedTopics.length, 1);
      assert.equal(detectedTopics[0].topicProgressId, 'tp-1');
      assert.equal(detectedTopics[0].topicId, 'topic-1');
      assert.equal(detectedTopics[0].courseAllocationId, 'alloc-1');
    } finally {
      eventBus.removeListener('topic.overdueDetected', topicHandler);
    }
  });

  void it('AllocationsService.processDeadlineReminders detects upcoming deadlines within 48h and emits events', async () => {
    const upcomingAllocation = {
      id: 'alloc-upcoming',
      userId: 'user-2',
      courseId: 'course-2',
      status: CourseAllocationStatus.ASSIGNED,
      dueDate: new Date(Date.now() + 30 * 3600000), // 30 hours in the future
      deletedAt: null,
    } as unknown as CourseAllocation;

    const mockAllocRepo = {
      findUpcomingDeadlines: () => Promise.resolve([upcomingAllocation]),
    } as unknown as AllocationsRepository;

    const service = new AllocationsService(mockAllocRepo, allocationsPolicy);
    const reminders: AllocationReminderDueEvent[] = [];
    const reminderHandler = (payload: AllocationReminderDueEvent) => {
      reminders.push(payload);
    };

    eventBus.on('allocation.reminderDue', reminderHandler);

    try {
      const summary = await service.processDeadlineReminders();
      assert.equal(summary.reminderAllocationsCount, 1);

      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].allocationId, 'alloc-upcoming');
      assert.equal(reminders[0].userId, 'user-2');
      assert.ok(reminders[0].hoursRemaining > 0 && reminders[0].hoursRemaining <= 48);
    } finally {
      eventBus.removeListener('allocation.reminderDue', reminderHandler);
    }
  });

  void it('processOverdueJob routes detect-overdue to allocations and progress services', async () => {
    const originalDetectAlloc =
      allocationsService.detectOverdueAllocations?.bind(allocationsService);
    const originalDetectTopic = progressService.detectOverdueTopics?.bind(progressService);

    let allocCalled = false;
    let topicCalled = false;

    allocationsService.detectOverdueAllocations = () => {
      allocCalled = true;
      return Promise.resolve({ overdueAllocationsCount: 5 });
    };

    progressService.detectOverdueTopics = () => {
      topicCalled = true;
      return Promise.resolve({ overdueTopicsCount: 3 });
    };

    try {
      const fakeJob = {
        id: 'job-detect-1',
        name: OVERDUE_DETECTION_JOB_NAME,
      } as Job;

      const result = await processOverdueJob(fakeJob);

      assert.equal(allocCalled, true);
      assert.equal(topicCalled, true);
      assert.deepEqual(result, {
        overdueAllocationsCount: 5,
        overdueTopicsCount: 3,
      });
    } finally {
      if (originalDetectAlloc) {
        allocationsService.detectOverdueAllocations = originalDetectAlloc;
      }
      if (originalDetectTopic) {
        progressService.detectOverdueTopics = originalDetectTopic;
      }
    }
  });

  void it('processOverdueJob routes remind-deadlines to allocations service', async () => {
    const originalReminders = allocationsService.processDeadlineReminders?.bind(allocationsService);
    let remindersCalled = false;

    allocationsService.processDeadlineReminders = () => {
      remindersCalled = true;
      return Promise.resolve({ reminderAllocationsCount: 7 });
    };

    try {
      const fakeJob = {
        id: 'job-remind-1',
        name: DEADLINE_REMINDER_JOB_NAME,
      } as Job;

      const result = await processOverdueJob(fakeJob);

      assert.equal(remindersCalled, true);
      assert.deepEqual(result, {
        reminderAllocationsCount: 7,
      });
    } finally {
      if (originalReminders) {
        allocationsService.processDeadlineReminders = originalReminders;
      }
    }
  });

  void it('processOverdueJob throws error on unrecognized job name', async () => {
    const fakeJob = {
      id: 'job-invalid-1',
      name: 'unrecognized-job-name',
    } as Job;

    await assert.rejects(
      async () => {
        await processOverdueJob(fakeJob);
      },
      {
        message: 'Unknown job name in overdue worker: unrecognized-job-name',
      },
    );
  });

  void it('createOverdueWorker initializes worker on overdue-jobs', async () => {
    const worker = createOverdueWorker();
    try {
      assert.equal(worker.name, OVERDUE_JOBS_QUEUE_NAME);
    } finally {
      await worker.close();
    }
  });
});
