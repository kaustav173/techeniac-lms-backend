import type { EntityManager } from 'typeorm';

import type { AuthenticatedUser } from '../../core/auth';
import { emailService } from '../../core/email';
import { NotFoundError } from '../../core/errors';
import { CourseTopicAction, eventBus } from '../../core/lifecycle';
import { logger } from '../../core/logging';
import { CourseAllocation, CourseAllocationStatus } from '../allocations';
import { BatchStatus, mentorMenteeRepository } from '../batches';
import { Topic } from '../courses';
import { userRepository, UserRole } from '../users';
import { TopicProgress, TopicProgressStatus } from './entities';
import { ProgressPolicy, progressPolicy } from './progress.policy';
import { ProgressRepository, progressRepository } from './progress.repository';
import type {
  TrackerQueryInput,
  UpdateTopicDeadlineInput,
  UpdateTopicStatusInput,
} from './schemas';

export class ProgressService {
  constructor(
    private readonly repository: ProgressRepository = progressRepository,
    private readonly policy: ProgressPolicy = progressPolicy,
  ) {}

  /**
   * Initializes NOT_STARTED topic progress rows for newly created course allocations (ALC-24, FR-7.1, M8).
   */
  async handleAllocationCreated(payload: {
    allocationIds: string[];
    courseId: string;
  }): Promise<void> {
    const { allocationIds, courseId } = payload;
    if (!allocationIds || allocationIds.length === 0 || !courseId) {
      return;
    }

    try {
      const activeTopics = await this.repository.findActiveTopicsByCourseId(courseId);
      if (activeTopics.length === 0) {
        logger.info(
          { courseId, allocationCount: allocationIds.length },
          '[ProgressService] No active topics found for course; skipping topic_progress initialization',
        );
        return;
      }

      const topicIds = activeTopics.map((t) => t.id);
      await this.repository.initializeTopicProgressForAllocations(allocationIds, topicIds);

      logger.info(
        { courseId, allocationCount: allocationIds.length, topicCount: topicIds.length },
        '[ProgressService] Successfully initialized NOT_STARTED topic progress rows',
      );
    } catch (err: unknown) {
      logger.error(
        { err, courseId, allocationIds },
        '[ProgressService] Failed to initialize topic progress for newly created allocations',
      );
      throw err;
    }
  }

  /**
   * Recalculates progress percent and manages status transition for a course allocation (FR-8.4, FR-8.5).
   */
  async recalculateProgress(
    allocationId: string,
    manager?: EntityManager,
    existingAllocation?: CourseAllocation,
  ): Promise<{
    progressPercent: number;
    status: CourseAllocationStatus;
  }> {
    const allocation =
      existingAllocation ??
      (await this.repository.findAllocationById(allocationId, manager, Boolean(manager)));
    if (!allocation) {
      throw new NotFoundError(`Allocation with id ${allocationId} not found`);
    }

    // COMPLETED, REVOKED, or CLOSED_* allocations are frozen and not recalculated (FR-8.4, FR-8.8)
    if (
      allocation.status === CourseAllocationStatus.COMPLETED ||
      allocation.status === CourseAllocationStatus.REVOKED ||
      allocation.status === CourseAllocationStatus.CLOSED_ROLE_CHANGE ||
      allocation.status === CourseAllocationStatus.CLOSED_BATCH_CHANGE
    ) {
      return {
        progressPercent: Number(allocation.progressPercent),
        status: allocation.status,
      };
    }

    const activeTopics = await this.repository.findActiveTopicsByCourseId(allocation.courseId);
    if (activeTopics.length === 0) {
      return {
        progressPercent: Number(allocation.progressPercent),
        status: allocation.status,
      };
    }

    const activeTopicIdSet = new Set(activeTopics.map((t) => t.id));
    const allProgressRows = await this.repository.listByAllocationId(allocationId, manager);

    const activeProgressRows = allProgressRows.filter((p) => activeTopicIdSet.has(p.topicId));
    const completedCount = activeProgressRows.filter(
      (p) => p.status === TopicProgressStatus.COMPLETED,
    ).length;

    const progressPercent = Math.round((completedCount / activeTopics.length) * 10000) / 100;

    let newStatus: CourseAllocationStatus = allocation.status;
    let completedAt = allocation.completedAt;
    if (progressPercent >= 100) {
      newStatus = CourseAllocationStatus.COMPLETED;
      completedAt = new Date();
    } else if (
      completedCount > 0 ||
      activeProgressRows.some((p) => p.status === TopicProgressStatus.IN_PROGRESS)
    ) {
      newStatus = CourseAllocationStatus.IN_PROGRESS;
    } else {
      newStatus = CourseAllocationStatus.ASSIGNED;
    }

    await this.repository.updateAllocationProgress(
      allocationId,
      {
        progressPercent,
        status: newStatus,
        completedAt,
      },
      manager,
    );

    // When allocation reaches 100%, send completion notification to the mapped mentor (FR-8.5, PRG-06)
    if (newStatus === CourseAllocationStatus.COMPLETED) {
      void this.notifyMentorOnAllocationCompleted(allocation);
    }

    return { progressPercent, status: newStatus };
  }

  /**
   * Updates topic progress status (NOT_STARTED -> IN_PROGRESS -> COMPLETED) with guarded concurrency (FR-8.3, PRG-03..06, PRG-20).
   */
  async updateTopicStatus(
    allocationId: string,
    topicId: string,
    input: UpdateTopicStatusInput,
    actor: AuthenticatedUser,
  ): Promise<{
    topicProgress: {
      topicId: string;
      status: TopicProgressStatus;
      completedAt: Date | null;
      note: string | null;
    };
    allocation: {
      progressPercent: number;
      status: CourseAllocationStatus;
    };
  }> {
    const allocation = await this.repository.findAllocationById(allocationId);
    if (!allocation) {
      throw new NotFoundError(`Allocation with id ${allocationId} not found`);
    }

    this.policy.assertCanUpdateTopicStatus(actor, allocation);

    const completedAt = input.status === TopicProgressStatus.COMPLETED ? new Date() : null;

    let finalNote: string | null = null;
    let finalTopicId = topicId;

    // Wrap topic status update and recalculation in one transaction with row lock
    const updatedAllocation = await this.repository.transaction(async (manager) => {
      // Re-fetch allocation inside transaction with pessimistic write lock to serialize concurrent updates
      const locked = await this.repository.findAllocationById(allocationId, manager, true);
      if (!locked) {
        throw new NotFoundError(`Allocation with id ${allocationId} not found`);
      }

      // Re-assert policy against locked allocation in case status changed while waiting for lock
      this.policy.assertCanUpdateTopicStatus(actor, locked);

      let progress = await this.repository.findByAllocationAndTopic(allocationId, topicId, manager);
      if (!progress) {
        const topic = await this.repository.findTopicById(topicId);
        if (!topic || topic.courseId !== locked.courseId) {
          throw new NotFoundError(`Topic ${topicId} does not belong to course ${locked.courseId}`);
        }

        await this.repository.initializeTopicProgressForAllocations(
          [allocationId],
          [topicId],
          manager,
        );
        progress = await this.repository.findByAllocationAndTopic(allocationId, topicId, manager);
        if (!progress) {
          throw new NotFoundError(`Failed to locate topic progress row for topic ${topicId}`);
        }
      }

      finalTopicId = progress.topicId;
      finalNote = input.note !== undefined ? input.note : progress.note;

      // Targeted column update prevents overwriting concurrent writes to other fields (e.g. deadline)
      await this.repository.updateTopicProgressStatus(
        progress.id,
        {
          status: input.status,
          completedAt,
          note: finalNote,
        },
        manager,
      );

      // Recalculate allocation progress % and status in the same transaction with row lock
      return await this.recalculateProgress(allocationId, manager, locked);
    });

    return {
      topicProgress: {
        topicId: finalTopicId,
        status: input.status,
        completedAt,
        note: finalNote,
      },
      allocation: updatedAllocation,
    };
  }

  /**
   * Sets or updates topic deadline (FR-8.6, PRG-17, PRG-18).
   */
  async updateTopicDeadline(
    allocationId: string,
    topicId: string,
    input: UpdateTopicDeadlineInput,
    actor: AuthenticatedUser,
  ): Promise<{
    topicId: string;
    deadline: string;
  }> {
    const allocation = await this.repository.findAllocationById(allocationId);
    if (!allocation) {
      throw new NotFoundError(`Allocation with id ${allocationId} not found`);
    }

    const deadline = new Date(input.deadline);
    await this.policy.assertCanManageTopicDeadline(actor, allocation, deadline);

    let progress = await this.repository.findByAllocationAndTopic(allocationId, topicId);
    if (!progress) {
      const topic = await this.repository.findTopicById(topicId);
      if (!topic || topic.courseId !== allocation.courseId) {
        throw new NotFoundError(`Topic ${topicId} not found in this course`);
      }
      await this.repository.initializeTopicProgressForAllocations([allocationId], [topicId]);
      progress = await this.repository.findByAllocationAndTopic(allocationId, topicId);
      if (!progress) {
        throw new NotFoundError(`Failed to find progress row for topic ${topicId}`);
      }
    }

    // Targeted column update prevents overwriting concurrent status/completedAt changes
    await this.repository.updateTopicProgressDeadline(progress.id, deadline);

    // Email mentee about deadline change (FR-8.6)
    if (allocation.user?.email) {
      const topic = await this.repository.findTopicById(topicId);
      void emailService
        .sendTopicDeadlineChangedEmail({
          to: allocation.user.email,
          recipientName: allocation.user.name,
          topicTitle: topic?.title ?? 'Course Topic',
          courseTitle: allocation.course?.title ?? 'Assigned Course',
          deadline: input.deadline,
        })
        .catch((err: unknown) => {
          logger.error(
            { err, allocationId, topicId },
            '[ProgressService] Failed to send topic deadline email',
          );
        });
    }

    return {
      topicId,
      deadline: input.deadline,
    };
  }

  /**
   * Returns complete course allocation progress overview with topic-level breakdown (FR-8.1, FR-8.2).
   */
  async getTopicProgressForAllocation(
    allocationId: string,
    actor: AuthenticatedUser,
  ): Promise<{
    allocation: {
      id: string;
      courseId: string;
      courseTitle: string;
      status: CourseAllocationStatus;
      progressPercent: number;
      startDate: Date;
      dueDate: Date;
      isOverdue: boolean;
      readOnly: boolean;
    };
    topics: Array<{
      topicId: string;
      title: string;
      description: string | null;
      displayOrder: number;
      estimatedMinutes: number | null;
      status: TopicProgressStatus;
      deadline: Date | null;
      completedAt: Date | null;
      note: string | null;
      isOverdue: boolean;
    }>;
  }> {
    const allocation = await this.repository.findAllocationById(allocationId);
    if (!allocation) {
      throw new NotFoundError(`Allocation with id ${allocationId} not found`);
    }

    await this.policy.assertCanViewAllocationProgress(actor, allocation);

    const activeTopics = await this.repository.findActiveTopicsByCourseId(allocation.courseId);
    const progressRows = await this.repository.listByAllocationId(allocationId);
    const progressMap = new Map(progressRows.map((p) => [p.topicId, p]));

    const now = new Date();
    const isAllocationOverdue =
      new Date(allocation.dueDate).getTime() < now.getTime() &&
      allocation.status !== CourseAllocationStatus.COMPLETED;

    const isReadOnly =
      allocation.status === CourseAllocationStatus.COMPLETED ||
      allocation.status === CourseAllocationStatus.REVOKED ||
      allocation.status === CourseAllocationStatus.CLOSED_ROLE_CHANGE ||
      allocation.status === CourseAllocationStatus.CLOSED_BATCH_CHANGE ||
      (allocation.batch !== null &&
        allocation.batch !== undefined &&
        (allocation.batch.status === BatchStatus.ON_HOLD ||
          allocation.batch.status === BatchStatus.COMPLETED ||
          allocation.batch.status === BatchStatus.ARCHIVED));

    const topics = activeTopics.map((t) => {
      const p = progressMap.get(t.id);
      const deadline = p?.deadline ?? null;
      const status = p?.status ?? TopicProgressStatus.NOT_STARTED;
      const isOverdue =
        deadline !== null &&
        new Date(deadline).getTime() < now.getTime() &&
        status !== TopicProgressStatus.COMPLETED;

      return {
        topicId: t.id,
        title: t.title,
        description: t.description,
        displayOrder: t.displayOrder,
        estimatedMinutes: t.estimatedMinutes,
        status,
        deadline,
        completedAt: p?.completedAt ?? null,
        note: p?.note ?? null,
        isOverdue,
      };
    });

    return {
      allocation: {
        id: allocation.id,
        courseId: allocation.courseId,
        courseTitle: allocation.course?.title ?? 'Assigned Course',
        status: allocation.status,
        progressPercent: Number(allocation.progressPercent),
        startDate: allocation.startDate,
        dueDate: allocation.dueDate,
        isOverdue: isAllocationOverdue,
        readOnly: isReadOnly,
      },
      topics,
    };
  }

  /**
   * Progress Tracker query for Super Admin and Mentor within Mentor Scope (FR-8.7).
   */
  async getProgressTracker(
    query: TrackerQueryInput,
    actor: AuthenticatedUser,
  ): Promise<{
    trackers: Array<{
      allocationId: string;
      menteeId: string;
      menteeName: string;
      batchId: string | null;
      batchName: string | null;
      courseId: string;
      courseTitle: string;
      progressPercent: number;
      status: CourseAllocationStatus;
      totalActiveTopics: number;
      completedTopicsCount: number;
      overdueTopicsCount: number;
      isOverdue: boolean;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    if (query.menteeId) {
      await this.policy.assertCanTrackMentee(actor, query.menteeId, query.batchId);
    }

    const isMentor = (actor.role as UserRole) === UserRole.MENTOR;
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const { allocations, total } = await this.repository.listTrackers({
      batchId: query.batchId,
      menteeId: query.menteeId,
      courseId: query.courseId,
      mentorId: isMentor ? actor.id : undefined,
      search: query.search,
      page,
      limit,
    });

    if (allocations.length === 0) {
      return {
        trackers: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
      };
    }

    const courseIds = [...new Set(allocations.map((a) => a.courseId))];
    const allocationIds = allocations.map((a) => a.id);

    const [activeTopicsList, progressRowsList] = await Promise.all([
      this.repository.findActiveTopicsByCourseIds(courseIds),
      this.repository.listByAllocationIds(allocationIds),
    ]);

    const topicsByCourse = new Map<string, Topic[]>();
    for (const topic of activeTopicsList) {
      const list = topicsByCourse.get(topic.courseId) ?? [];
      list.push(topic);
      topicsByCourse.set(topic.courseId, list);
    }

    const progressByAlloc = new Map<string, TopicProgress[]>();
    for (const pr of progressRowsList) {
      const list = progressByAlloc.get(pr.courseAllocationId) ?? [];
      list.push(pr);
      progressByAlloc.set(pr.courseAllocationId, list);
    }

    const results: Array<{
      allocationId: string;
      menteeId: string;
      menteeName: string;
      batchId: string | null;
      batchName: string | null;
      courseId: string;
      courseTitle: string;
      progressPercent: number;
      status: CourseAllocationStatus;
      totalActiveTopics: number;
      completedTopicsCount: number;
      overdueTopicsCount: number;
      isOverdue: boolean;
    }> = [];

    const now = new Date();

    for (const alloc of allocations) {
      const activeTopics = topicsByCourse.get(alloc.courseId) ?? [];
      const progressRows = progressByAlloc.get(alloc.id) ?? [];

      const activeTopicIdSet = new Set(activeTopics.map((t) => t.id));
      const activeProgress = progressRows.filter((p) => activeTopicIdSet.has(p.topicId));

      const completedTopicsCount = activeProgress.filter(
        (p) => p.status === TopicProgressStatus.COMPLETED,
      ).length;

      const overdueTopicsCount = activeProgress.filter(
        (p) =>
          p.deadline &&
          new Date(p.deadline).getTime() < now.getTime() &&
          p.status !== TopicProgressStatus.COMPLETED,
      ).length;

      const isOverdue =
        new Date(alloc.dueDate).getTime() < now.getTime() &&
        alloc.status !== CourseAllocationStatus.COMPLETED;

      results.push({
        allocationId: alloc.id,
        menteeId: alloc.userId,
        menteeName: alloc.user?.name ?? 'Mentee',
        batchId: alloc.batchId,
        batchName: alloc.batch?.name ?? null,
        courseId: alloc.courseId,
        courseTitle: alloc.course?.title ?? 'Course',
        progressPercent: Number(alloc.progressPercent),
        status: alloc.status,
        totalActiveTopics: activeTopics.length,
        completedTopicsCount,
        overdueTopicsCount,
        isOverdue,
      });
    }

    return {
      trackers: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Handles course topics changes (add, deactivate, reactivate, delete) by recalculating open allocations (FR-6.15, FR-8.4, PRG-15, PRG-16).
   */
  async handleCourseTopicsChanged(payload: {
    courseId: string;
    topicId: string;
    action: CourseTopicAction;
  }): Promise<void> {
    const openAllocations = await this.repository.findOpenAllocationsByCourseId(payload.courseId);
    if (openAllocations.length === 0) {
      return;
    }

    if (payload.action === CourseTopicAction.ADDED) {
      const allocationIds = openAllocations.map((a) => a.id);
      await this.repository.initializeTopicProgressForAllocations(allocationIds, [payload.topicId]);
    }

    await Promise.all(
      openAllocations.map(async (alloc) => {
        try {
          await this.recalculateProgress(alloc.id, undefined, alloc);
        } catch (err: unknown) {
          logger.error(
            { err, allocationId: alloc.id, courseId: payload.courseId },
            '[ProgressService] Failed to recalculate progress for allocation during topicsChanged event',
          );
        }
      }),
    );
  }

  private async notifyMentorOnAllocationCompleted(allocation: {
    id: string;
    userId: string;
    batchId: string | null;
    user?: { name: string } | null;
    course?: { title: string } | null;
    batch?: { name: string } | null;
  }): Promise<void> {
    if (!allocation.batchId) {
      return;
    }

    try {
      const mapping = await mentorMenteeRepository.findActiveByMenteeAndBatch(
        allocation.batchId,
        allocation.userId,
      );

      if (!mapping || !mapping.mentorId) {
        return;
      }

      const mentor = await userRepository.findById(mapping.mentorId);
      if (!mentor?.email) {
        return;
      }

      await emailService.sendAllocationCompletedEmail({
        to: mentor.email,
        recipientName: mentor.name,
        menteeName: allocation.user?.name ?? 'Mentee',
        courseTitle: allocation.course?.title ?? 'Assigned Course',
        batchName: allocation.batch?.name,
      });
    } catch (err: unknown) {
      logger.error(
        { err, allocationId: allocation.id },
        '[ProgressService] Failed to send completion notification to mentor',
      );
    }
  }

  public async detectOverdueTopics(
    since?: Date,
    now: Date = new Date(),
  ): Promise<{ overdueTopicsCount: number }> {
    const overdueTopics = await this.repository.findOverdueTopics(since, now);

    if (overdueTopics.length >= 1000) {
      logger.warn(
        { count: overdueTopics.length, limit: 1000 },
        'Overdue topics query reached batch limit; remaining records will be evaluated on the next run',
      );
    }

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

    return { overdueTopicsCount: overdueTopics.length };
  }
}

export const progressService = new ProgressService();
