import { EntityManager, In, IsNull, Repository } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { CourseAllocation, CourseAllocationStatus } from '../allocations';
import { BatchMember, BatchMemberRole, MentorMentee } from '../batches';
import { Topic } from '../courses';
import { TopicProgress, TopicProgressStatus } from './entities';

export class ProgressRepository {
  private get repo(): Repository<TopicProgress> {
    return AppDataSource.getRepository(TopicProgress);
  }

  private get topicRepo(): Repository<Topic> {
    return AppDataSource.getRepository(Topic);
  }

  private get allocationRepo(): Repository<CourseAllocation> {
    return AppDataSource.getRepository(CourseAllocation);
  }

  async findActiveTopicsByCourseId(courseId: string): Promise<Topic[]> {
    return await this.topicRepo.find({
      where: {
        courseId,
        isActive: true,
        deletedAt: IsNull(),
      },
      order: {
        displayOrder: 'ASC',
      },
    });
  }

  async findTopicById(topicId: string): Promise<Topic | null> {
    return await this.topicRepo.findOne({
      where: { id: topicId, deletedAt: IsNull() },
    });
  }

  async initializeTopicProgressForAllocations(
    allocationIds: string[],
    topicIds: string[],
    manager?: EntityManager,
  ): Promise<void> {
    if (allocationIds.length === 0 || topicIds.length === 0) {
      return;
    }

    const rows: Array<{
      courseAllocationId: string;
      topicId: string;
      status: TopicProgressStatus;
    }> = [];

    for (const allocId of allocationIds) {
      for (const topicId of topicIds) {
        rows.push({
          courseAllocationId: allocId,
          topicId: topicId,
          status: TopicProgressStatus.NOT_STARTED,
        });
      }
    }

    const qb = (manager ?? AppDataSource).createQueryBuilder();
    await qb
      .insert()
      .into(TopicProgress)
      .values(rows)
      .orIgnore() // Idempotent: ignore existing (course_allocation_id, topic_id)
      .execute();
  }

  async transaction<T>(runInTransaction: (manager?: EntityManager) => Promise<T>): Promise<T> {
    if (AppDataSource.isInitialized) {
      return await AppDataSource.transaction(
        runInTransaction as (manager: EntityManager) => Promise<T>,
      );
    }
    return await runInTransaction(undefined);
  }

  async findByAllocationAndTopic(
    courseAllocationId: string,
    topicId: string,
    manager?: EntityManager,
  ): Promise<TopicProgress | null> {
    const repo = manager ? manager.getRepository(TopicProgress) : this.repo;
    return await repo.findOne({
      where: {
        courseAllocationId,
        topicId,
        deletedAt: IsNull(),
      },
      relations: ['topic'],
    });
  }

  async listByAllocationId(
    courseAllocationId: string,
    manager?: EntityManager,
  ): Promise<TopicProgress[]> {
    const repo = manager ? manager.getRepository(TopicProgress) : this.repo;
    return await repo
      .createQueryBuilder('tp')
      .leftJoinAndSelect('tp.topic', 'topic')
      .where('tp.courseAllocationId = :courseAllocationId', { courseAllocationId })
      .andWhere('tp.deletedAt IS NULL')
      .orderBy('topic.displayOrder', 'ASC')
      .getMany();
  }

  async findAllocationById(
    allocationId: string,
    manager?: EntityManager,
    lock: boolean = false,
  ): Promise<CourseAllocation | null> {
    const repo = manager ? manager.getRepository(CourseAllocation) : this.allocationRepo;
    if (lock && manager) {
      // In PostgreSQL, FOR UPDATE cannot be applied to queries with outer joins (relations).
      // First, lock the allocation row exclusively within the transaction.
      const locked = await repo.findOne({
        where: { id: allocationId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return null;

      // Then load relations for policy checks and notifications.
      return await repo.findOne({
        where: { id: allocationId, deletedAt: IsNull() },
        relations: ['batch', 'course', 'user'],
      });
    }
    return await repo.findOne({
      where: { id: allocationId, deletedAt: IsNull() },
      relations: ['batch', 'course', 'user'],
    });
  }

  async findOpenAllocationsByCourseId(courseId: string): Promise<CourseAllocation[]> {
    return await this.allocationRepo.find({
      where: {
        courseId,
        status: In([CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS]),
        deletedAt: IsNull(),
      },
    });
  }

  async findActiveTopicsByCourseIds(courseIds: string[]): Promise<Topic[]> {
    if (courseIds.length === 0) return [];
    return await this.topicRepo.find({
      where: {
        courseId: In(courseIds),
        isActive: true,
        deletedAt: IsNull(),
      },
      order: {
        displayOrder: 'ASC',
      },
    });
  }

  async listByAllocationIds(courseAllocationIds: string[]): Promise<TopicProgress[]> {
    if (courseAllocationIds.length === 0) return [];
    return await this.repo
      .createQueryBuilder('tp')
      .leftJoinAndSelect('tp.topic', 'topic')
      .where('tp.courseAllocationId IN (:...courseAllocationIds)', { courseAllocationIds })
      .andWhere('tp.deletedAt IS NULL')
      .orderBy('topic.displayOrder', 'ASC')
      .getMany();
  }

  async listTrackers(options: {
    batchId?: string;
    menteeId?: string;
    courseId?: string;
    batchIds?: string[];
    menteeIds?: string[];
    courseIds?: string[];
    mentorId?: string;
    statuses?: (CourseAllocationStatus | 'OVERDUE')[];
    isOverdue?: boolean;
    sortField?: 'menteeName' | 'createdAt';
    sortOrder?: 'asc' | 'desc' | 'ASC' | 'DESC';
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ allocations: CourseAllocation[]; total: number }> {
    const qb = this.allocationRepo
      .createQueryBuilder('alloc')
      .leftJoinAndSelect('alloc.user', 'user')
      .leftJoinAndSelect('alloc.course', 'course')
      .leftJoinAndSelect('alloc.batch', 'batch')
      .where('alloc.deletedAt IS NULL');

    if (options.mentorId) {
      qb.innerJoin(
        MentorMentee,
        'mm',
        'mm.batchId = alloc.batchId AND mm.menteeId = alloc.userId AND mm.mentorId = :mentorId AND mm.isActive = true AND mm.deletedAt IS NULL',
        { mentorId: options.mentorId },
      );
      qb.innerJoin(
        BatchMember,
        'bm_mentor',
        'bm_mentor.batchId = alloc.batchId AND bm_mentor.userId = :mentorId AND bm_mentor.isActive = true AND bm_mentor.memberRole = :mentorRole AND bm_mentor.deletedAt IS NULL',
        { mentorId: options.mentorId, mentorRole: BatchMemberRole.MENTOR },
      );
    }

    if (options.batchId) {
      qb.andWhere('alloc.batchId = :batchId', { batchId: options.batchId });
    } else if (options.batchIds !== undefined) {
      if (options.batchIds.length === 0) {
        return { allocations: [], total: 0 };
      }
      qb.andWhere('alloc.batchId IN (:...batchIds)', { batchIds: options.batchIds });
    }

    if (options.menteeId) {
      qb.andWhere('alloc.userId = :menteeId', { menteeId: options.menteeId });
    } else if (options.menteeIds !== undefined) {
      if (options.menteeIds.length === 0) {
        return { allocations: [], total: 0 };
      }
      qb.andWhere('alloc.userId IN (:...menteeIds)', { menteeIds: options.menteeIds });
    }

    if (options.courseId) {
      qb.andWhere('alloc.courseId = :courseId', { courseId: options.courseId });
    } else if (options.courseIds !== undefined) {
      if (options.courseIds.length === 0) {
        return { allocations: [], total: 0 };
      }
      qb.andWhere('alloc.courseId IN (:...courseIds)', { courseIds: options.courseIds });
    }

    if (options.statuses && options.statuses.length > 0) {
      const isOverdueSelected = options.statuses.includes('OVERDUE');
      const isAssignedSelected = options.statuses.includes(CourseAllocationStatus.ASSIGNED);
      const isInProgressSelected = options.statuses.includes(CourseAllocationStatus.IN_PROGRESS);
      const otherStatuses: CourseAllocationStatus[] = [];
      for (const s of options.statuses) {
        if (s === 'OVERDUE') continue;
        if (s !== CourseAllocationStatus.ASSIGNED && s !== CourseAllocationStatus.IN_PROGRESS) {
          otherStatuses.push(s);
        }
      }

      const statusClauses: string[] = [];

      if (isOverdueSelected) {
        statusClauses.push(
          `(alloc.status IN ('${CourseAllocationStatus.ASSIGNED}', '${CourseAllocationStatus.IN_PROGRESS}') AND alloc.dueDate < NOW())`,
        );
      }

      if (isAssignedSelected) {
        if (isOverdueSelected) {
          statusClauses.push(`alloc.status = '${CourseAllocationStatus.ASSIGNED}'`);
        } else {
          statusClauses.push(
            `(alloc.status = '${CourseAllocationStatus.ASSIGNED}' AND (alloc.dueDate >= NOW() OR alloc.dueDate IS NULL))`,
          );
        }
      }

      if (isInProgressSelected) {
        if (isOverdueSelected) {
          statusClauses.push(`alloc.status = '${CourseAllocationStatus.IN_PROGRESS}'`);
        } else {
          statusClauses.push(
            `(alloc.status = '${CourseAllocationStatus.IN_PROGRESS}' AND (alloc.dueDate >= NOW() OR alloc.dueDate IS NULL))`,
          );
        }
      }

      if (otherStatuses.length > 0) {
        statusClauses.push('alloc.status IN (:...otherStatuses)');
      }

      if (statusClauses.length > 0) {
        qb.andWhere(`(${statusClauses.join(' OR ')})`, { otherStatuses });
      }
    } else if (options.isOverdue) {
      qb.andWhere(
        `(alloc.status IN ('${CourseAllocationStatus.ASSIGNED}', '${CourseAllocationStatus.IN_PROGRESS}') AND alloc.dueDate < NOW())`,
      );
    }

    if (options.search) {
      const rawSearch = options.search.trim();
      const searchPattern = `%${rawSearch}%`;
      const sLower = rawSearch.toLowerCase();

      const searchClauses: string[] = [
        'user.name ILIKE :search',
        'course.title ILIKE :search',
        'batch.name ILIKE :search',
      ];

      // Smart status matching based on display labels
      // Special-case 'completed' down to floor >= 3 ('com', 'comp', 'complete', 'completed').
      // Keep all other status matching at floor >= 4 to avoid false-positive status filtering
      // on common 3-letter name/course prefixes (e.g. 'pro', 'ove', 'rol', 'rev', 'bat').
      if (sLower.length >= 3 && ('completed'.startsWith(sLower) || 'complete'.startsWith(sLower))) {
        searchClauses.push(`alloc.status = '${CourseAllocationStatus.COMPLETED}'`);
      }
      if (sLower.length >= 4) {
        if ('assigned'.startsWith(sLower) || 'assign'.startsWith(sLower)) {
          searchClauses.push(
            `(alloc.status = '${CourseAllocationStatus.ASSIGNED}' AND (alloc.dueDate >= NOW() OR alloc.dueDate IS NULL))`,
          );
        }
        if ('in progress'.startsWith(sLower) || 'progress'.startsWith(sLower)) {
          searchClauses.push(
            `(alloc.status = '${CourseAllocationStatus.IN_PROGRESS}' AND (alloc.dueDate >= NOW() OR alloc.dueDate IS NULL))`,
          );
        }
        if ('overdue'.startsWith(sLower)) {
          searchClauses.push(
            `(alloc.status IN ('${CourseAllocationStatus.ASSIGNED}', '${CourseAllocationStatus.IN_PROGRESS}') AND alloc.dueDate < NOW())`,
          );
        }
        if ('role changed'.startsWith(sLower) || 'role'.startsWith(sLower)) {
          searchClauses.push(`alloc.status = '${CourseAllocationStatus.CLOSED_ROLE_CHANGE}'`);
        }
        if (
          'batch transferred'.startsWith(sLower) ||
          'batch'.startsWith(sLower) ||
          ('transfer'.startsWith(sLower) && sLower.length >= 5) ||
          ('transferred'.startsWith(sLower) && sLower.length >= 5)
        ) {
          searchClauses.push(`alloc.status = '${CourseAllocationStatus.CLOSED_BATCH_CHANGE}'`);
        }
        if ('revoked'.startsWith(sLower) || 'revoke'.startsWith(sLower)) {
          searchClauses.push(`alloc.status = '${CourseAllocationStatus.REVOKED}'`);
        }
      }

      qb.andWhere(`(${searchClauses.join(' OR ')})`, { search: searchPattern });
    }

    const dir = options.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    if (options.sortField === 'menteeName') {
      qb.addSelect('LOWER(user.name)', 'lower_user_name');
      qb.orderBy('lower_user_name', dir);
      qb.addOrderBy('alloc.createdAt', 'DESC');
    } else {
      qb.orderBy('alloc.createdAt', dir);
    }

    if (options.page && options.limit) {
      qb.skip((options.page - 1) * options.limit).take(options.limit);
    }

    const [allocations, total] = await qb.getManyAndCount();
    return { allocations, total };
  }

  async updateTopicProgressStatus(
    id: string,
    updates: {
      status: TopicProgressStatus;
      completedAt: Date | null;
      note?: string | null;
    },
    manager?: EntityManager,
  ): Promise<void> {
    if (!AppDataSource.isInitialized && !manager) {
      return;
    }
    const repo = manager ? manager.getRepository(TopicProgress) : this.repo;
    await repo.update({ id, deletedAt: IsNull() }, updates);
  }

  async updateTopicProgressDeadline(
    id: string,
    deadline: Date,
    manager?: EntityManager,
  ): Promise<void> {
    if (!AppDataSource.isInitialized && !manager) {
      return;
    }
    const repo = manager ? manager.getRepository(TopicProgress) : this.repo;
    await repo.update({ id, deletedAt: IsNull() }, { deadline });
  }

  async updateAllocationProgress(
    allocationId: string,
    updates: {
      progressPercent: number;
      status?: CourseAllocationStatus;
      completedAt?: Date | null;
    },
    manager?: EntityManager,
  ): Promise<void> {
    if (!AppDataSource.isInitialized && !manager) {
      return;
    }
    const repo = manager ? manager.getRepository(CourseAllocation) : this.allocationRepo;
    await repo.update({ id: allocationId, deletedAt: IsNull() }, updates);
  }

  async findOverdueTopics(
    since: Date = new Date(Date.now() - 24 * 3600000),
    now: Date = new Date(),
    limit: number = 1000,
  ): Promise<TopicProgress[]> {
    return await this.repo
      .createQueryBuilder('tp')
      .where('tp.status IN (:...statuses)', {
        statuses: [TopicProgressStatus.NOT_STARTED, TopicProgressStatus.IN_PROGRESS],
      })
      .andWhere('tp.deadline IS NOT NULL AND tp.deadline >= :since AND tp.deadline < :now', {
        since,
        now,
      })
      .andWhere('tp.deletedAt IS NULL')
      .take(limit)
      .getMany();
  }
}

export const progressRepository = new ProgressRepository();
