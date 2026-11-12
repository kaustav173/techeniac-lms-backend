import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { EntityManager } from 'typeorm';

import type { AuthenticatedUser } from '../../src/core/auth';
import { emailService } from '../../src/core/email';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/core/errors';
import { CourseTopicAction } from '../../src/core/lifecycle';
import { CourseAllocation, CourseAllocationStatus } from '../../src/modules/allocations';
import {
  Batch,
  BatchStatus,
  MentorMentee,
  mentorMenteeRepository,
  mentorScopeHelper,
} from '../../src/modules/batches';
import type { Topic } from '../../src/modules/courses';
import {
  ProgressPolicy,
  ProgressRepository,
  ProgressService,
  TopicProgress,
  TopicProgressStatus,
  trackerQuerySchema,
  updateTopicDeadlineSchema,
  updateTopicStatusSchema,
} from '../../src/modules/progress';
import { User, userRepository } from '../../src/modules/users';

const createTestUser = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@TechEniac.com',
  role: 'SUPER_ADMIN',
  mustChangePassword: false,
  tokenVersion: 1,
  ...overrides,
});

void describe('ProgressService Unit Tests (PRD M8: PRG-01 to PRG-20)', () => {
  let mockRepo: ProgressRepository;
  let mockPolicy: ProgressPolicy;
  let service: ProgressService;

  const adminUser = createTestUser({ id: 'admin-1', role: 'SUPER_ADMIN' });
  const mentorUser = createTestUser({ id: 'mentor-1', role: 'MENTOR' });
  const menteeUser = createTestUser({ id: 'mentee-1', role: 'MENTEE' });
  const otherMentee = createTestUser({ id: 'mentee-2', role: 'MENTEE' });

  const mockActiveTopics: Topic[] = [
    {
      id: 'topic-1',
      title: 'Intro',
      courseId: 'course-1',
      isActive: true,
      displayOrder: 1,
    } as Topic,
    {
      id: 'topic-2',
      title: 'Advanced',
      courseId: 'course-1',
      isActive: true,
      displayOrder: 2,
    } as Topic,
    {
      id: 'topic-3',
      title: 'Project',
      courseId: 'course-1',
      isActive: true,
      displayOrder: 3,
    } as Topic,
  ];

  beforeEach(() => {
    mockRepo = new ProgressRepository();
    mockPolicy = new ProgressPolicy();
    service = new ProgressService(mockRepo, mockPolicy);
    emailService.sendTopicDeadlineChangedEmail = () => Promise.resolve();
    emailService.sendAllocationCompletedEmail = () => Promise.resolve();
  });

  void describe('handleAllocationCreated (ALC-24, FR-7.1, M8)', () => {
    void it('initializes NOT_STARTED topic progress rows for all active topics', async () => {
      let capturedAllocationIds: string[] = [];
      let capturedTopicIds: string[] = [];

      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.initializeTopicProgressForAllocations = (allocIds, topicIds) => {
        capturedAllocationIds = allocIds;
        capturedTopicIds = topicIds;
        return Promise.resolve();
      };

      await service.handleAllocationCreated({
        allocationIds: ['alloc-1', 'alloc-2'],
        courseId: 'course-1',
      });

      assert.deepEqual(capturedAllocationIds, ['alloc-1', 'alloc-2']);
      assert.deepEqual(capturedTopicIds, ['topic-1', 'topic-2', 'topic-3']);
    });

    void it('skips initialization safely when course has no active topics', async () => {
      let called = false;
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve([]);
      mockRepo.initializeTopicProgressForAllocations = () => {
        called = true;
        return Promise.resolve();
      };

      await service.handleAllocationCreated({
        allocationIds: ['alloc-1'],
        courseId: 'course-empty',
      });

      assert.equal(called, false);
    });

    void it('handles empty allocation IDs array gracefully', async () => {
      let called = false;
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.initializeTopicProgressForAllocations = () => {
        called = true;
        return Promise.resolve();
      };

      await service.handleAllocationCreated({
        allocationIds: [],
        courseId: 'course-1',
      });

      assert.equal(called, false);
    });
  });

  void describe('updateTopicStatus & Concurrency (FR-8.3, PRG-03..06, PRG-20)', () => {
    void it('allows mentee to move topic from NOT_STARTED to IN_PROGRESS (PRG-03)', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.ASSIGNED,
        progressPercent: 0,
        batch: { status: BatchStatus.LIVE } as Batch,
      } as CourseAllocation;

      const progress = {
        id: 'tp-1',
        courseAllocationId: 'alloc-1',
        topicId: 'topic-1',
        status: TopicProgressStatus.NOT_STARTED,
        completedAt: null,
      } as TopicProgress;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(progress);
      mockRepo.save = (p) => Promise.resolve(p);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () =>
        Promise.resolve([
          { ...progress, status: TopicProgressStatus.IN_PROGRESS },
          { topicId: 'topic-2', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
          { topicId: 'topic-3', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
        ]);
      mockRepo.updateAllocationProgress = () => Promise.resolve();

      const result = await service.updateTopicStatus(
        'alloc-1',
        'topic-1',
        { status: TopicProgressStatus.IN_PROGRESS, note: 'Working on lab' },
        menteeUser,
      );

      assert.equal(result.topicProgress.status, TopicProgressStatus.IN_PROGRESS);
      assert.equal(result.topicProgress.note, 'Working on lab');
      assert.equal(result.allocation.status, CourseAllocationStatus.IN_PROGRESS);
    });

    void it('rejects another mentee from updating topic status (PRG-10)', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        status: CourseAllocationStatus.ASSIGNED,
        batch: { status: BatchStatus.LIVE } as Batch,
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);

      await assert.rejects(
        () =>
          service.updateTopicStatus(
            'alloc-1',
            'topic-1',
            { status: TopicProgressStatus.IN_PROGRESS },
            otherMentee,
          ),
        (err: unknown) => err instanceof ForbiddenError,
      );
    });

    void it('rejects updating topic status when allocation is completed or revoked (PRG-13)', async () => {
      const completedAllocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        status: CourseAllocationStatus.COMPLETED,
        batch: { status: BatchStatus.LIVE } as Batch,
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(completedAllocation);

      await assert.rejects(
        () =>
          service.updateTopicStatus(
            'alloc-1',
            'topic-1',
            { status: TopicProgressStatus.IN_PROGRESS },
            menteeUser,
          ),
        (err: unknown) => err instanceof ForbiddenError,
      );
    });

    void it('rejects updating topic status when batch is in ON_HOLD status (PRG-12)', async () => {
      const onHoldAllocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        status: CourseAllocationStatus.IN_PROGRESS,
        batch: { status: BatchStatus.ON_HOLD } as Batch,
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(onHoldAllocation);

      await assert.rejects(
        () =>
          service.updateTopicStatus(
            'alloc-1',
            'topic-1',
            { status: TopicProgressStatus.COMPLETED },
            menteeUser,
          ),
        (err: unknown) => err instanceof ForbiddenError,
      );
    });

    void it('serializes concurrent status updates on the same allocation safely (PRG-20)', async () => {
      const committedState: {
        allocation: CourseAllocation;
        topics: Record<string, TopicProgress>;
      } = {
        allocation: {
          id: 'alloc-1',
          userId: 'mentee-1',
          courseId: 'course-1',
          status: CourseAllocationStatus.ASSIGNED,
          progressPercent: 0,
          batch: { status: BatchStatus.LIVE } as Batch,
        } as CourseAllocation,
        topics: {
          'topic-1': {
            id: 'tp-1',
            courseAllocationId: 'alloc-1',
            topicId: 'topic-1',
            status: TopicProgressStatus.NOT_STARTED,
            completedAt: null,
            note: null,
          } as TopicProgress,
          'topic-2': {
            id: 'tp-2',
            courseAllocationId: 'alloc-1',
            topicId: 'topic-2',
            status: TopicProgressStatus.NOT_STARTED,
            completedAt: null,
            note: null,
          } as TopicProgress,
        },
      };

      let currentLockHolder: string | null = null;
      const lockQueue: Array<{ txId: string; resolve: () => void }> = [];

      const acquireRowLock = async (txId: string) => {
        if (currentLockHolder === null) {
          currentLockHolder = txId;
          return;
        }
        if (currentLockHolder === txId) {
          return;
        }
        await new Promise<void>((resolve) => {
          lockQueue.push({ txId, resolve });
        });
      };

      const releaseRowLock = (txId: string) => {
        if (currentLockHolder === txId) {
          if (lockQueue.length > 0) {
            const next = lockQueue.shift()!;
            currentLockHolder = next.txId;
            next.resolve();
          } else {
            currentLockHolder = null;
          }
        }
      };

      let txCount = 0;
      const txStaging = new Map<
        string,
        {
          allocationUpdates?: Partial<CourseAllocation>;
          topicUpdates: Map<string, Partial<TopicProgress>>;
        }
      >();

      mockRepo.transaction = async (cb) => {
        const txId = `tx-${++txCount}`;
        txStaging.set(txId, { topicUpdates: new Map() });
        const manager = { id: txId } as unknown as EntityManager;
        try {
          const result = await cb(manager);
          // On commit, flush staged writes to committed state
          const staging = txStaging.get(txId);
          if (staging) {
            if (staging.allocationUpdates) {
              Object.assign(committedState.allocation, staging.allocationUpdates);
            }
            for (const [tpId, updates] of staging.topicUpdates) {
              const found = Object.values(committedState.topics).find((t) => t.id === tpId);
              if (found) Object.assign(found, updates);
            }
          }
          return result;
        } finally {
          txStaging.delete(txId);
          releaseRowLock(txId);
        }
      };

      const findAllocationCalls: Array<{
        allocId: string;
        manager?: EntityManager;
        lock?: boolean;
      }> = [];
      mockRepo.findAllocationById = async (allocId, manager, lock) => {
        findAllocationCalls.push({ allocId, manager, lock });
        const txId = (manager as { id?: string } | undefined)?.id;
        if (lock && txId) {
          await acquireRowLock(txId);
        }
        const staging = txId ? txStaging.get(txId) : undefined;
        const base: CourseAllocation = { ...committedState.allocation };
        if (staging?.allocationUpdates) {
          Object.assign(base, staging.allocationUpdates);
        }
        return base;
      };

      mockRepo.findByAllocationAndTopic = (_allocId, topicId, manager) => {
        const txId = (manager as { id?: string } | undefined)?.id;
        const staging = txId ? txStaging.get(txId) : undefined;
        const base: TopicProgress | undefined = committedState.topics[topicId];
        if (!base) return Promise.resolve(null);
        const row: TopicProgress = { ...base };
        const stagedUpdate = staging?.topicUpdates.get(row.id);
        if (stagedUpdate) {
          Object.assign(row, stagedUpdate);
        }
        return Promise.resolve(row);
      };

      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);

      mockRepo.updateTopicProgressStatus = (id, updates, manager) => {
        const txId = (manager as { id?: string } | undefined)?.id;
        if (txId && txStaging.has(txId)) {
          txStaging.get(txId)!.topicUpdates.set(id, updates);
        } else {
          const found = Object.values(committedState.topics).find((p) => p.id === id);
          if (found) {
            Object.assign(found, updates);
          }
        }
        return Promise.resolve();
      };

      mockRepo.listByAllocationId = (_allocId, manager) => {
        const txId = (manager as { id?: string } | undefined)?.id;
        const staging = txId ? txStaging.get(txId) : undefined;
        const rows: TopicProgress[] = Object.values(committedState.topics).map((p) => {
          const copy: TopicProgress = { ...p };
          const stagedUpdate = staging?.topicUpdates.get(p.id);
          if (stagedUpdate) {
            Object.assign(copy, stagedUpdate);
          }
          return copy;
        });
        return Promise.resolve(rows);
      };

      mockRepo.updateAllocationProgress = (_id, updates, manager) => {
        const txId = (manager as { id?: string } | undefined)?.id;
        if (txId && txStaging.has(txId)) {
          txStaging.get(txId)!.allocationUpdates = updates;
        } else {
          Object.assign(committedState.allocation, updates);
        }
        return Promise.resolve();
      };

      // Concurrent updates for topic-1 and topic-2 on the same allocation
      const [res1, res2] = await Promise.all([
        service.updateTopicStatus(
          'alloc-1',
          'topic-1',
          { status: TopicProgressStatus.COMPLETED },
          menteeUser,
        ),
        service.updateTopicStatus(
          'alloc-1',
          'topic-2',
          { status: TopicProgressStatus.COMPLETED },
          menteeUser,
        ),
      ]);

      assert.equal(res1.topicProgress.status, TopicProgressStatus.COMPLETED);
      assert.equal(res2.topicProgress.status, TopicProgressStatus.COMPLETED);
      assert.equal(committedState.allocation.status, CourseAllocationStatus.IN_PROGRESS);
      assert.equal(committedState.allocation.progressPercent, 66.67);

      // Verify that in-transaction recalculation re-fetches allocation with pessimistic write lock
      const lockedCalls = findAllocationCalls.filter((c) => Boolean(c.manager) && c.lock === true);
      assert.equal(
        lockedCalls.length,
        2,
        'Expected both concurrent updateTopicStatus transactions to acquire pessimistic write lock',
      );
    });

    void it('self-heals missing topic progress row on updateTopicStatus if topic belongs to course', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.ASSIGNED,
        progressPercent: 0,
        batch: { status: BatchStatus.LIVE } as Batch,
      } as CourseAllocation;

      let created = false;
      let progressRow: TopicProgress | null = null;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(progressRow);
      mockRepo.findTopicById = (id) =>
        Promise.resolve({ id, courseId: 'course-1', isActive: true } as Topic);
      mockRepo.initializeTopicProgressForAllocations = () => {
        created = true;
        progressRow = {
          id: 'tp-lazy-1',
          courseAllocationId: 'alloc-1',
          topicId: 'topic-1',
          status: TopicProgressStatus.NOT_STARTED,
          completedAt: null,
          note: null,
        } as TopicProgress;
        return Promise.resolve();
      };
      mockRepo.updateTopicProgressStatus = () => Promise.resolve();
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRow ? [progressRow] : []);
      mockRepo.updateAllocationProgress = () => Promise.resolve();

      const result = await service.updateTopicStatus(
        'alloc-1',
        'topic-1',
        { status: TopicProgressStatus.IN_PROGRESS },
        menteeUser,
      );

      assert.equal(created, true);
      assert.equal(result.topicProgress.topicId, 'topic-1');
      assert.equal(result.topicProgress.status, TopicProgressStatus.IN_PROGRESS);
    });

    void it('throws NotFoundError if updating status for a topic belonging to another course', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.ASSIGNED,
        progressPercent: 0,
        batch: { status: BatchStatus.LIVE } as Batch,
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(null);
      mockRepo.findTopicById = (id) =>
        Promise.resolve({ id, courseId: 'course-OTHER', isActive: true } as Topic);

      await assert.rejects(
        () =>
          service.updateTopicStatus(
            'alloc-1',
            'topic-alien',
            { status: TopicProgressStatus.IN_PROGRESS },
            menteeUser,
          ),
        (err: unknown) => err instanceof NotFoundError,
      );
    });

    void it('findAllocationById executes two-step query to prevent FOR UPDATE outer join collision when lock is requested', async () => {
      const repo = new ProgressRepository();
      const findOneCalls: unknown[] = [];

      const mockManager = {
        getRepository: () => ({
          findOne: (options: unknown) => {
            findOneCalls.push(options);
            return Promise.resolve({ id: 'alloc-lock-1' } as CourseAllocation);
          },
        }),
      } as unknown as EntityManager;

      const result = await repo.findAllocationById('alloc-lock-1', mockManager, true);

      assert.equal(findOneCalls.length, 2);
      // First call acquires row-level lock without outer join relations
      assert.deepEqual((findOneCalls[0] as { lock: unknown }).lock, { mode: 'pessimistic_write' });
      assert.equal((findOneCalls[0] as { relations?: unknown }).relations, undefined);
      // Second call loads outer join relations without lock
      assert.deepEqual((findOneCalls[1] as { relations: unknown }).relations, [
        'batch',
        'course',
        'user',
      ]);
      assert.equal((findOneCalls[1] as { lock?: unknown }).lock, undefined);
      assert.equal(result?.id, 'alloc-lock-1');
    });
  });

  void describe('updateTopicDeadline & Validation (FR-8.6, PRG-17, PRG-18)', () => {
    void it('allows mentor to set deadline within start and due date range (PRG-17)', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        batchId: 'batch-1',
        courseId: 'course-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
        user: { email: 'mentee@TechEniac.com', name: 'Mentee' },
        course: { title: 'TypeScript' },
      } as unknown as CourseAllocation;

      const progress = {
        topicId: 'topic-1',
        deadline: null,
      } as TopicProgress;

      mentorScopeHelper.requireMentorScope = () => Promise.resolve();
      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findTopicById = () => Promise.resolve({ id: 'topic-1', title: 'Intro' } as Topic);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(progress);
      mockRepo.save = (p) => Promise.resolve(p);

      const targetDeadline = '2026-11-15T18:00:00.000Z';
      const result = await service.updateTopicDeadline(
        'alloc-1',
        'topic-1',
        { deadline: targetDeadline },
        mentorUser,
      );

      assert.equal(result.deadline, targetDeadline);
      assert.equal(result.topicId, 'topic-1');
    });

    void it('allows super admin to set topic deadline without batch restriction', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
        user: { email: 'mentee@TechEniac.com', name: 'Mentee' },
        course: { title: 'TypeScript' },
      } as unknown as CourseAllocation;

      const progress = {
        topicId: 'topic-1',
        deadline: null,
      } as TopicProgress;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findTopicById = () => Promise.resolve({ id: 'topic-1', title: 'Intro' } as Topic);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(progress);
      mockRepo.save = (p) => Promise.resolve(p);

      const targetDeadline = '2026-11-20T00:00:00.000Z';
      const result = await service.updateTopicDeadline(
        'alloc-1',
        'topic-1',
        { deadline: targetDeadline },
        adminUser,
      );

      assert.equal(result.deadline, targetDeadline);
    });

    void it('rejects setting topic deadline outside start and due range with ValidationError (PRG-18)', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        batchId: 'batch-1',
        courseId: 'course-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      } as CourseAllocation;

      mentorScopeHelper.requireMentorScope = () => Promise.resolve();
      mockRepo.findAllocationById = () => Promise.resolve(allocation);

      // Deadline after allocation due date
      await assert.rejects(
        () =>
          service.updateTopicDeadline(
            'alloc-1',
            'topic-1',
            { deadline: '2026-12-05T00:00:00.000Z' },
            mentorUser,
          ),
        (err: unknown) => err instanceof ValidationError,
      );

      // Deadline before allocation start date
      await assert.rejects(
        () =>
          service.updateTopicDeadline(
            'alloc-1',
            'topic-1',
            { deadline: '2026-10-25T00:00:00.000Z' },
            mentorUser,
          ),
        (err: unknown) => err instanceof ValidationError,
      );
    });

    void it('rejects mentee from setting topic deadline (FR-8.6)', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        startDate: new Date('2026-11-01'),
        dueDate: new Date('2026-11-30'),
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);

      await assert.rejects(
        () =>
          service.updateTopicDeadline(
            'alloc-1',
            'topic-1',
            { deadline: '2026-11-15T00:00:00.000Z' },
            menteeUser,
          ),
        (err: unknown) => err instanceof ForbiddenError,
      );
    });

    void it('self-heals missing topic progress row on updateTopicDeadline if topic belongs to course', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
        user: { email: 'mentee@TechEniac.com', name: 'Mentee' },
        course: { title: 'TypeScript' },
      } as unknown as CourseAllocation;

      let created = false;
      let progressRow: TopicProgress | null = null;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findTopicById = (id) =>
        Promise.resolve({ id, courseId: 'course-1', title: 'Intro' } as Topic);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(progressRow);
      mockRepo.initializeTopicProgressForAllocations = () => {
        created = true;
        progressRow = {
          id: 'tp-lazy-deadline',
          courseAllocationId: 'alloc-1',
          topicId: 'topic-1',
          deadline: null,
        } as TopicProgress;
        return Promise.resolve();
      };
      mockRepo.updateTopicProgressDeadline = () => Promise.resolve();

      const result = await service.updateTopicDeadline(
        'alloc-1',
        'topic-1',
        { deadline: '2026-11-15T18:00:00.000Z' },
        adminUser,
      );

      assert.equal(created, true);
      assert.equal(result.topicId, 'topic-1');
      assert.equal(result.deadline, '2026-11-15T18:00:00.000Z');
    });

    void it('throws NotFoundError if setting deadline for a topic belonging to another course', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findTopicById = (id) =>
        Promise.resolve({ id, courseId: 'course-OTHER', title: 'Alien' } as Topic);
      mockRepo.findByAllocationAndTopic = () => Promise.resolve(null);

      await assert.rejects(
        () =>
          service.updateTopicDeadline(
            'alloc-1',
            'topic-alien',
            { deadline: '2026-11-15T18:00:00.000Z' },
            adminUser,
          ),
        (err: unknown) => err instanceof NotFoundError,
      );
    });
  });

  void describe('getTopicProgressForAllocation (FR-8.1, FR-8.2)', () => {
    void it('returns full outline with calculated isOverdue for topic and allocation', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 86400000); // 1 day ago
      const futureDate = new Date(now.getTime() + 86400000); // 1 day ahead

      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        courseId: 'course-1',
        startDate: pastDate,
        dueDate: futureDate,
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 33.33,
        course: { title: 'TypeScript' },
      } as CourseAllocation;

      const progressRows: TopicProgress[] = [
        {
          topicId: 'topic-1',
          status: TopicProgressStatus.COMPLETED,
          deadline: pastDate,
        } as TopicProgress,
        {
          topicId: 'topic-2',
          status: TopicProgressStatus.IN_PROGRESS,
          deadline: pastDate,
        } as TopicProgress,
        {
          topicId: 'topic-3',
          status: TopicProgressStatus.NOT_STARTED,
          deadline: futureDate,
        } as TopicProgress,
      ];

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRows);

      const overview = await service.getTopicProgressForAllocation('alloc-1', menteeUser);

      assert.equal(overview.allocation.progressPercent, 33.33);
      assert.equal(overview.allocation.isOverdue, false); // due date is in the future
      assert.equal(overview.topics.length, 3);

      // Topic 1 is completed so it is not overdue even though deadline passed
      assert.equal(overview.topics[0]?.isOverdue, false);
      // Topic 2 is incomplete and deadline passed -> overdue!
      assert.equal(overview.topics[1]?.isOverdue, true);
      // Topic 3 deadline is in future -> not overdue
      assert.equal(overview.topics[2]?.isOverdue, false);
    });
  });

  void describe('recalculateProgress (FR-8.4, FR-8.5)', () => {
    void it('transitions ASSIGNED to IN_PROGRESS when a topic is in progress or completed', async () => {
      const allocation = {
        id: 'alloc-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.ASSIGNED,
        progressPercent: 0,
        completedAt: null,
      } as CourseAllocation;

      const progressRows: TopicProgress[] = [
        { topicId: 'topic-1', status: TopicProgressStatus.COMPLETED } as TopicProgress,
        { topicId: 'topic-2', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
        { topicId: 'topic-3', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
      ];

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRows);

      let capturedUpdate: { progressPercent: number; status?: CourseAllocationStatus } | null =
        null;
      mockRepo.updateAllocationProgress = (_id, updates) => {
        capturedUpdate = updates;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-1');

      assert.equal(result.progressPercent, 33.33);
      assert.equal(result.status, CourseAllocationStatus.IN_PROGRESS);
      assert.equal(capturedUpdate?.progressPercent, 33.33);
      assert.equal(capturedUpdate?.status, CourseAllocationStatus.IN_PROGRESS);
    });

    void it('reverts IN_PROGRESS allocation back to ASSIGNED when topics are reverted to NOT_STARTED', async () => {
      const allocation = {
        id: 'alloc-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 33.33,
        completedAt: null,
      } as CourseAllocation;

      const progressRows: TopicProgress[] = [
        { topicId: 'topic-1', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
        { topicId: 'topic-2', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
        { topicId: 'topic-3', status: TopicProgressStatus.NOT_STARTED } as TopicProgress,
      ];

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRows);

      let capturedUpdate: { progressPercent: number; status?: CourseAllocationStatus } | null =
        null;
      mockRepo.updateAllocationProgress = (_id, updates) => {
        capturedUpdate = updates;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-1');

      assert.equal(result.progressPercent, 0);
      assert.equal(result.status, CourseAllocationStatus.ASSIGNED);
      assert.equal(capturedUpdate?.progressPercent, 0);
      assert.equal(capturedUpdate?.status, CourseAllocationStatus.ASSIGNED);
    });

    void it('transitions to COMPLETED with 100% when all active topics are completed', async () => {
      const allocation = {
        id: 'alloc-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 66.67,
        completedAt: null,
      } as CourseAllocation;

      const progressRows: TopicProgress[] = [
        { topicId: 'topic-1', status: TopicProgressStatus.COMPLETED } as TopicProgress,
        { topicId: 'topic-2', status: TopicProgressStatus.COMPLETED } as TopicProgress,
        { topicId: 'topic-3', status: TopicProgressStatus.COMPLETED } as TopicProgress,
      ];

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRows);

      let capturedUpdate: {
        progressPercent: number;
        status?: CourseAllocationStatus;
        completedAt?: Date | null;
      } | null = null;

      mockRepo.updateAllocationProgress = (_id, updates) => {
        capturedUpdate = updates;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-1');

      assert.equal(result.progressPercent, 100);
      assert.equal(result.status, CourseAllocationStatus.COMPLETED);
      assert.equal(capturedUpdate?.progressPercent, 100);
      assert.equal(capturedUpdate?.status, CourseAllocationStatus.COMPLETED);
      assert.ok(capturedUpdate?.completedAt instanceof Date);
    });

    void it('sends allocation completed email to mapped mentor when allocation reaches COMPLETED', async () => {
      const allocation = {
        id: 'alloc-1',
        userId: 'mentee-1',
        batchId: 'batch-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 66.67,
        completedAt: null,
        user: { name: 'Alice Mentee' },
        course: { title: 'Node.js Mastery' },
        batch: { name: 'Batch 2026' },
      } as unknown as CourseAllocation;

      const progressRows: TopicProgress[] = [
        { topicId: 'topic-1', status: TopicProgressStatus.COMPLETED } as TopicProgress,
        { topicId: 'topic-2', status: TopicProgressStatus.COMPLETED } as TopicProgress,
        { topicId: 'topic-3', status: TopicProgressStatus.COMPLETED } as TopicProgress,
      ];

      mockRepo.findAllocationById = () => Promise.resolve(allocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve(progressRows);
      mockRepo.updateAllocationProgress = () => Promise.resolve();

      let emailedMentorPayload: Record<string, unknown> | null = null;
      mentorMenteeRepository.findActiveByMenteeAndBatch = () =>
        Promise.resolve({
          id: 'mm-1',
          mentorId: 'mentor-1',
          menteeId: 'mentee-1',
          batchId: 'batch-1',
          isActive: true,
        } as unknown as MentorMentee);

      userRepository.findById = () =>
        Promise.resolve({
          id: 'mentor-1',
          email: 'mentor@TechEniac.com',
          name: 'Bob Mentor',
        } as unknown as User);

      emailService.sendAllocationCompletedEmail = (payload) => {
        emailedMentorPayload = payload as Record<string, unknown>;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-1');
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(result.status, CourseAllocationStatus.COMPLETED);
      assert.equal(result.progressPercent, 100);
      assert.notEqual(emailedMentorPayload, null);
      assert.equal(emailedMentorPayload?.to, 'mentor@TechEniac.com');
      assert.equal(emailedMentorPayload?.menteeName, 'Alice Mentee');
      assert.equal(emailedMentorPayload?.courseTitle, 'Node.js Mastery');
    });

    void it('reuses pre-loaded allocation passed to recalculateProgress without re-querying repo', async () => {
      const allocation = {
        id: 'alloc-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 33.33,
        completedAt: null,
      } as CourseAllocation;

      let findAllocationCalled = false;
      mockRepo.findAllocationById = () => {
        findAllocationCalled = true;
        return Promise.resolve(allocation);
      };
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve([]);
      mockRepo.updateAllocationProgress = () => Promise.resolve();

      const result = await service.recalculateProgress('alloc-1', undefined, allocation);

      assert.equal(findAllocationCalled, false);
      assert.equal(result.progressPercent, 0);
    });

    void it('freezes COMPLETED allocations and never recalculates or reopens them (FR-8.4)', async () => {
      const allocation = {
        id: 'alloc-1',
        courseId: 'course-1',
        status: CourseAllocationStatus.COMPLETED,
        progressPercent: 100,
        completedAt: new Date('2026-10-01'),
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);

      let updateCalled = false;
      mockRepo.updateAllocationProgress = () => {
        updateCalled = true;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-1');

      assert.equal(result.progressPercent, 100);
      assert.equal(result.status, CourseAllocationStatus.COMPLETED);
      assert.equal(updateCalled, false);
    });

    void it('freezes REVOKED and CLOSED_* allocations without recalculating (FR-8.8)', async () => {
      const allocation = {
        id: 'alloc-revoked',
        courseId: 'course-1',
        status: CourseAllocationStatus.REVOKED,
        progressPercent: 50,
        completedAt: null,
      } as CourseAllocation;

      mockRepo.findAllocationById = () => Promise.resolve(allocation);

      let updateCalled = false;
      mockRepo.updateAllocationProgress = () => {
        updateCalled = true;
        return Promise.resolve();
      };

      const result = await service.recalculateProgress('alloc-revoked');

      assert.equal(result.progressPercent, 50);
      assert.equal(result.status, CourseAllocationStatus.REVOKED);
      assert.equal(updateCalled, false);
    });
  });

  void describe('handleCourseTopicsChanged (FR-6.15, PRG-15, PRG-16)', () => {
    void it('initializes new topic and recalculates all open allocations when topic is added', async () => {
      const openAllocations = [
        { id: 'alloc-1', courseId: 'course-1' } as CourseAllocation,
        { id: 'alloc-2', courseId: 'course-1' } as CourseAllocation,
      ];

      mockRepo.findOpenAllocationsByCourseId = () => Promise.resolve(openAllocations);

      let initializedAllocIds: string[] = [];
      let initializedTopicIds: string[] = [];
      mockRepo.initializeTopicProgressForAllocations = (aIds, tIds) => {
        initializedAllocIds = aIds;
        initializedTopicIds = tIds;
        return Promise.resolve();
      };

      const recalculatedIds: string[] = [];
      mockRepo.findAllocationById = (id) =>
        Promise.resolve({
          id,
          courseId: 'course-1',
          status: CourseAllocationStatus.IN_PROGRESS,
          progressPercent: 50,
        } as CourseAllocation);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);
      mockRepo.listByAllocationId = () => Promise.resolve([]);
      mockRepo.updateAllocationProgress = (id) => {
        recalculatedIds.push(id);
        return Promise.resolve();
      };

      await service.handleCourseTopicsChanged({
        courseId: 'course-1',
        topicId: 'topic-new',
        action: CourseTopicAction.ADDED,
      });

      assert.deepEqual(initializedAllocIds, ['alloc-1', 'alloc-2']);
      assert.deepEqual(initializedTopicIds, ['topic-new']);
      assert.deepEqual(recalculatedIds, ['alloc-1', 'alloc-2']);
    });

    void it('continues recalculating remaining allocations when one allocation throws an error', async () => {
      const mockOpenAllocations: CourseAllocation[] = [
        {
          id: 'alloc-fail',
          courseId: 'course-1',
          status: CourseAllocationStatus.IN_PROGRESS,
          progressPercent: 30,
        } as CourseAllocation,
        {
          id: 'alloc-success',
          courseId: 'course-1',
          status: CourseAllocationStatus.IN_PROGRESS,
          progressPercent: 50,
        } as CourseAllocation,
      ];

      mockRepo.findOpenAllocationsByCourseId = () => Promise.resolve(mockOpenAllocations);
      mockRepo.findActiveTopicsByCourseId = () => Promise.resolve(mockActiveTopics);

      const successfullyRecalculated: string[] = [];
      mockRepo.listByAllocationId = (allocId) => {
        if (allocId === 'alloc-fail') {
          return Promise.reject(new Error('Transient DB blip'));
        }
        return Promise.resolve([]);
      };
      mockRepo.updateAllocationProgress = (id) => {
        successfullyRecalculated.push(id);
        return Promise.resolve();
      };

      await service.handleCourseTopicsChanged({
        courseId: 'course-1',
        topicId: 'topic-1',
        action: CourseTopicAction.DEACTIVATED,
      });

      assert.deepEqual(successfullyRecalculated, ['alloc-success']);
    });
  });

  void describe('getProgressTracker (FR-8.7)', () => {
    void it('aggregates progress counts and active topics in batch without N+1 queries', async () => {
      const mockAllocations: CourseAllocation[] = [
        {
          id: 'alloc-1',
          userId: 'mentee-1',
          user: { name: 'Mentee One' },
          batchId: 'batch-1',
          batch: { name: 'Batch Alpha' },
          courseId: 'course-1',
          course: { title: 'Node.js Core' },
          dueDate: new Date(Date.now() + 86400000),
          progressPercent: 66.67,
          status: CourseAllocationStatus.IN_PROGRESS,
        } as unknown as CourseAllocation,
      ];

      mockRepo.listTrackers = (opts) => {
        assert.equal(opts.limit, 50);
        return Promise.resolve({ allocations: mockAllocations, total: 1 });
      };

      mockRepo.findActiveTopicsByCourseIds = (courseIds) => {
        assert.deepEqual(courseIds, ['course-1']);
        return Promise.resolve(mockActiveTopics);
      };

      mockRepo.listByAllocationIds = (allocIds) => {
        assert.deepEqual(allocIds, ['alloc-1']);
        return Promise.resolve([
          {
            topicId: 'topic-1',
            courseAllocationId: 'alloc-1',
            status: TopicProgressStatus.COMPLETED,
          } as TopicProgress,
          {
            topicId: 'topic-2',
            courseAllocationId: 'alloc-1',
            status: TopicProgressStatus.COMPLETED,
          } as TopicProgress,
        ]);
      };

      const result = await service.getProgressTracker({ page: 1, limit: 50 }, adminUser);

      assert.equal(result.trackers.length, 1);
      assert.equal(result.trackers[0].allocationId, 'alloc-1');
      assert.equal(result.trackers[0].totalActiveTopics, 3);
      assert.equal(result.trackers[0].completedTopicsCount, 2);
      assert.equal(result.trackers[0].overdueTopicsCount, 0);
      assert.equal(result.trackers[0].isOverdue, false);
      assert.equal(result.pagination.total, 1);
    });

    void it('passes mentorId to listTrackers when actor is MENTOR', async () => {
      let capturedOpts: { mentorId?: string } | null = null;
      mockRepo.listTrackers = (opts) => {
        capturedOpts = opts;
        return Promise.resolve({ allocations: [], total: 0 });
      };

      const result = await service.getProgressTracker({ batchId: 'batch-1' }, mentorUser);

      assert.equal(capturedOpts?.mentorId, mentorUser.id);
      assert.equal(result.trackers.length, 0);
      assert.equal(result.pagination.total, 0);
    });

    void it('omits mentorId in listTrackers when actor is SUPER_ADMIN', async () => {
      let capturedOpts: { mentorId?: string } | null = null;
      mockRepo.listTrackers = (opts) => {
        capturedOpts = opts;
        return Promise.resolve({ allocations: [], total: 0 });
      };

      const result = await service.getProgressTracker({ batchId: 'batch-1' }, adminUser);

      assert.equal(capturedOpts?.mentorId, undefined);
      assert.equal(result.trackers.length, 0);
      assert.equal(result.pagination.total, 0);
    });
  });

  void describe('Schema Validation', () => {
    void it('validates correct updateTopicStatus payload', () => {
      const valid = updateTopicStatusSchema.safeParse({
        status: 'IN_PROGRESS',
        note: 'Starting lab 1',
      });
      assert.equal(valid.success, true);
    });

    void it('rejects invalid topic status', () => {
      const invalid = updateTopicStatusSchema.safeParse({
        status: 'UNKNOWN_STATUS',
      });
      assert.equal(invalid.success, false);
    });

    void it('validates correct ISO 8601 deadline', () => {
      const valid = updateTopicDeadlineSchema.safeParse({
        deadline: '2026-11-15T18:00:00.000Z',
      });
      assert.equal(valid.success, true);
    });

    void it('rejects non-ISO deadline string', () => {
      const invalid = updateTopicDeadlineSchema.safeParse({
        deadline: 'next-friday',
      });
      assert.equal(invalid.success, false);
    });

    void it('validates trackerQuerySchema with defaults and pagination bounds', () => {
      const parsed = trackerQuerySchema.parse({});
      assert.equal(parsed.page, 1);
      assert.equal(parsed.limit, 10);

      const invalidLimit = trackerQuerySchema.safeParse({ limit: 500 });
      assert.equal(invalidLimit.success, false);
    });

    void it('validates status and statuses against CourseAllocationStatus and OVERDUE', () => {
      const validSingle = trackerQuerySchema.safeParse({ status: CourseAllocationStatus.ASSIGNED });
      assert.equal(validSingle.success, true);

      const validOverdue = trackerQuerySchema.safeParse({ status: 'OVERDUE' });
      assert.equal(validOverdue.success, true);

      const invalidStatus = trackerQuerySchema.safeParse({ status: 'bogus' });
      assert.equal(invalidStatus.success, false);

      const validStatusesComma = trackerQuerySchema.safeParse({
        statuses: 'ASSIGNED,IN_PROGRESS,OVERDUE',
      });
      assert.equal(validStatusesComma.success, true);
      if (validStatusesComma.success) {
        assert.deepEqual(validStatusesComma.data.statuses, [
          CourseAllocationStatus.ASSIGNED,
          CourseAllocationStatus.IN_PROGRESS,
          'OVERDUE',
        ]);
      }

      const invalidStatusesComma = trackerQuerySchema.safeParse({
        statuses: 'ASSIGNED,bogus',
      });
      assert.equal(invalidStatusesComma.success, false);

      const invalidStatusesArray = trackerQuerySchema.safeParse({
        statuses: ['ASSIGNED', 'invalid_val'],
      });
      assert.equal(invalidStatusesArray.success, false);
    });
  });

  void describe('ProgressRepository.listTrackers Status & Search Query Construction', () => {
    const createMockAllocationQueryBuilder = () => {
      const andWhereClauses: string[] = [];
      const parametersList: Record<string, unknown>[] = [];
      const qb: Record<string, unknown> = {
        leftJoinAndSelect: () => qb,
        where: () => qb,
        innerJoin: () => qb,
        andWhere: (clause: string, params?: Record<string, unknown>) => {
          andWhereClauses.push(clause);
          if (params) parametersList.push(params);
          return qb;
        },
        addSelect: () => qb,
        orderBy: () => qb,
        addOrderBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getManyAndCount: () => Promise.resolve([[], 0]),
      };
      return { qb, andWhereClauses, parametersList };
    };

    void it('does not match status clauses for short name fragments like Ted, cha, chan, Tran, Ran, Due, Ass, Sig, Gre, Res, Ver, Fer, pro, ove, rol, rev, bat', async () => {
      const fragments = [
        'Ted',
        'cha',
        'chan',
        'Tran',
        'Ran',
        'Due',
        'Ass',
        'Sig',
        'Gre',
        'Res',
        'Ver',
        'Fer',
        'pro',
        'ove',
        'rol',
        'rev',
        'bat',
      ];

      for (const frag of fragments) {
        const repo = new ProgressRepository();
        const { qb, andWhereClauses } = createMockAllocationQueryBuilder();
        Object.defineProperty(repo, 'allocationRepo', {
          get: () => ({ createQueryBuilder: () => qb }),
        });

        await repo.listTrackers({ search: frag });

        const searchClause = andWhereClauses.find((c) => c.includes('user.name ILIKE :search'));
        assert.ok(searchClause, `Expected search clause for ${frag}`);
        assert.equal(
          searchClause?.includes('alloc.status'),
          false,
          `Fragment "${frag}" should NOT trigger any status matching, got: ${searchClause}`,
        );
      }
    });

    void it('matches expected status clauses for genuine status searches', async () => {
      const testCases = [
        { search: 'com', expected: `alloc.status = '${CourseAllocationStatus.COMPLETED}'` },
        { search: 'comp', expected: `alloc.status = '${CourseAllocationStatus.COMPLETED}'` },
        { search: 'complete', expected: `alloc.status = '${CourseAllocationStatus.COMPLETED}'` },
        { search: 'completed', expected: `alloc.status = '${CourseAllocationStatus.COMPLETED}'` },
        { search: 'assign', expected: `alloc.status = '${CourseAllocationStatus.ASSIGNED}'` },
        { search: 'prog', expected: `alloc.status = '${CourseAllocationStatus.IN_PROGRESS}'` },
        { search: 'progress', expected: `alloc.status = '${CourseAllocationStatus.IN_PROGRESS}'` },
        {
          search: 'in progress',
          expected: `alloc.status = '${CourseAllocationStatus.IN_PROGRESS}'`,
        },
        {
          search: 'overdue',
          expected: `alloc.status IN ('${CourseAllocationStatus.ASSIGNED}', '${CourseAllocationStatus.IN_PROGRESS}')`,
        },
        {
          search: 'role',
          expected: `alloc.status = '${CourseAllocationStatus.CLOSED_ROLE_CHANGE}'`,
        },
        {
          search: 'role changed',
          expected: `alloc.status = '${CourseAllocationStatus.CLOSED_ROLE_CHANGE}'`,
        },
        {
          search: 'batch',
          expected: `alloc.status = '${CourseAllocationStatus.CLOSED_BATCH_CHANGE}'`,
        },
        {
          search: 'transfer',
          expected: `alloc.status = '${CourseAllocationStatus.CLOSED_BATCH_CHANGE}'`,
        },
        { search: 'revoke', expected: `alloc.status = '${CourseAllocationStatus.REVOKED}'` },
      ];

      for (const { search, expected } of testCases) {
        const repo = new ProgressRepository();
        const { qb, andWhereClauses } = createMockAllocationQueryBuilder();
        Object.defineProperty(repo, 'allocationRepo', {
          get: () => ({ createQueryBuilder: () => qb }),
        });

        await repo.listTrackers({ search });

        const searchClause = andWhereClauses.find((c) => c.includes('user.name ILIKE :search'));
        assert.ok(searchClause);
        assert.ok(
          searchClause.includes(expected),
          `Search "${search}" was expected to contain "${expected}", got: ${searchClause}`,
        );
      }
    });

    void it('uses CourseAllocationStatus enum members in statuses and overdue queries', async () => {
      const repo = new ProgressRepository();
      const { qb, andWhereClauses } = createMockAllocationQueryBuilder();
      Object.defineProperty(repo, 'allocationRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
      });

      await repo.listTrackers({
        statuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS, 'OVERDUE'],
      });

      const clause = andWhereClauses[0];
      assert.ok(clause);
      assert.ok(clause.includes(`alloc.status = '${CourseAllocationStatus.ASSIGNED}'`));
      assert.ok(clause.includes(`alloc.status = '${CourseAllocationStatus.IN_PROGRESS}'`));
      assert.ok(
        clause.includes(
          `(alloc.status IN ('${CourseAllocationStatus.ASSIGNED}', '${CourseAllocationStatus.IN_PROGRESS}') AND alloc.dueDate < NOW())`,
        ),
      );
    });
  });
});
