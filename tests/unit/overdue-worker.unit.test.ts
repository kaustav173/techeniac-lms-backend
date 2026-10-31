import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
  processDeadlineReminders,
  processOverdueDetection,
} from '../../src/jobs/overdue.worker';
import {
  type AllocationsRepository,
  CourseAllocation,
  CourseAllocationStatus,
} from '../../src/modules/allocations';
import {
  type ProgressRepository,
  TopicProgress,
  TopicProgressStatus,
} from '../../src/modules/progress';

void describe('Overdue Worker & Job Processors Unit Tests', () => {
  void it('exports expected queue and job names', () => {
    assert.equal(OVERDUE_JOBS_QUEUE_NAME, 'overdue-jobs');
    assert.equal(OVERDUE_DETECTION_JOB_NAME, 'detect-overdue');
    assert.equal(DEADLINE_REMINDER_JOB_NAME, 'remind-deadlines');
  });

  void it('processOverdueDetection finds overdue allocations and topics and emits events', async () => {
    const overdueAllocation = {
      id: 'alloc-1',
      userId: 'user-1',
      courseId: 'course-1',
      status: CourseAllocationStatus.IN_PROGRESS,
      dueDate: new Date(Date.now() - 3600000), // 1 hour ago
      deletedAt: null,
    } as unknown as CourseAllocation;

    const overdueTopic = {
      id: 'tp-1',
      courseAllocationId: 'alloc-1',
      topicId: 'topic-1',
      status: TopicProgressStatus.IN_PROGRESS,
      deadline: new Date(Date.now() - 7200000), // 2 hours ago
      deletedAt: null,
    } as unknown as TopicProgress;

    const mockAllocRepo = {
      findOverdueAllocations: () => Promise.resolve([overdueAllocation]),
    } as unknown as AllocationsRepository;

    const mockTopicRepo = {
      findOverdueTopics: () => Promise.resolve([overdueTopic]),
    } as unknown as ProgressRepository;

    const detectedAllocations: AllocationOverdueDetectedEvent[] = [];
    const detectedTopics: TopicOverdueDetectedEvent[] = [];

    const allocHandler = (payload: AllocationOverdueDetectedEvent) => {
      detectedAllocations.push(payload);
    };
    const topicHandler = (payload: TopicOverdueDetectedEvent) => {
      detectedTopics.push(payload);
    };

    eventBus.on('allocation.overdueDetected', allocHandler);
    eventBus.on('topic.overdueDetected', topicHandler);

    try {
      const summary = await processOverdueDetection(mockAllocRepo, mockTopicRepo);
      assert.equal(summary.overdueAllocationsCount, 1);
      assert.equal(summary.overdueTopicsCount, 1);

      assert.equal(detectedAllocations.length, 1);
      assert.equal(detectedAllocations[0].allocationId, 'alloc-1');
      assert.equal(detectedAllocations[0].userId, 'user-1');

      assert.equal(detectedTopics.length, 1);
      assert.equal(detectedTopics[0].topicProgressId, 'tp-1');
      assert.equal(detectedTopics[0].topicId, 'topic-1');
    } finally {
      eventBus.removeListener('allocation.overdueDetected', allocHandler);
      eventBus.removeListener('topic.overdueDetected', topicHandler);
    }
  });

  void it('processDeadlineReminders detects upcoming deadlines within 48h and emits events', async () => {
    const upcomingAllocation = {
      id: 'alloc-upcoming',
      userId: 'user-2',
      courseId: 'course-2',
      status: CourseAllocationStatus.ASSIGNED,
      dueDate: new Date(Date.now() + 24 * 3600000), // 24 hours in the future
      deletedAt: null,
    } as unknown as CourseAllocation;

    const mockAllocRepo = {
      findUpcomingDeadlines: () => Promise.resolve([upcomingAllocation]),
    } as unknown as AllocationsRepository;

    const reminders: AllocationReminderDueEvent[] = [];
    const reminderHandler = (payload: AllocationReminderDueEvent) => {
      reminders.push(payload);
    };

    eventBus.on('allocation.reminderDue', reminderHandler);

    try {
      const summary = await processDeadlineReminders(mockAllocRepo);
      assert.equal(summary.reminderAllocationsCount, 1);

      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].allocationId, 'alloc-upcoming');
      assert.equal(reminders[0].userId, 'user-2');
      assert.ok(reminders[0].hoursRemaining > 0 && reminders[0].hoursRemaining <= 48);
    } finally {
      eventBus.removeListener('allocation.reminderDue', reminderHandler);
    }
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
