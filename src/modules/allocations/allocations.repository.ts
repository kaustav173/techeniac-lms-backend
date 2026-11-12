import { EntityManager, In, SelectQueryBuilder } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { Batch, BatchMember, BatchMemberRole } from '../batches';
import { Course } from '../courses';
import { User } from '../users';
import { CourseAllocationStatus } from './entities/allocation.enums';
import { AssignmentDueOverride } from './entities/assignment-due-override.entity';
import { CourseAllocation } from './entities/course-allocation.entity';
import type { ListAllocationsQuery } from './schemas/allocation.schemas';

export interface AllocationListResult {
  allocations: CourseAllocation[];
  total: number;
  page: number;
  limit: number;
}

export const SCHEDULED_JOBS_BATCH_LIMIT = 1000;
export const UPCOMING_DEADLINE_WINDOW_START_HOURS = 24;
export const UPCOMING_DEADLINE_WINDOW_END_HOURS = 48;

export class AllocationsRepository {
  private get allocationRepo() {
    return AppDataSource.getRepository(CourseAllocation);
  }

  private get overrideRepo() {
    return AppDataSource.getRepository(AssignmentDueOverride);
  }

  private get courseRepo() {
    return AppDataSource.getRepository(Course);
  }

  private get batchRepo() {
    return AppDataSource.getRepository(Batch);
  }

  private get memberRepo() {
    return AppDataSource.getRepository(BatchMember);
  }

  private getUserRepo() {
    return AppDataSource.getRepository(User);
  }

  private getAllocationRepo(manager?: EntityManager) {
    return manager ? manager.getRepository(CourseAllocation) : this.allocationRepo;
  }

  private getOverrideRepo(manager?: EntityManager) {
    return manager ? manager.getRepository(AssignmentDueOverride) : this.overrideRepo;
  }

  async transaction<T>(runInTransaction: (manager?: EntityManager) => Promise<T>): Promise<T> {
    if (AppDataSource.isInitialized) {
      return await AppDataSource.transaction(
        runInTransaction as (manager: EntityManager) => Promise<T>,
      );
    }
    return await runInTransaction(undefined);
  }

  async findCourseById(id: string): Promise<Course | null> {
    return await this.courseRepo.findOne({ where: { id } });
  }

  async findBatchById(id: string): Promise<Batch | null> {
    return await this.batchRepo.findOne({ where: { id } });
  }

  async findBatchMember(
    batchId: string,
    userId: string,
    memberRole: BatchMemberRole,
    isActive = true,
  ): Promise<BatchMember | null> {
    return await this.memberRepo.findOne({
      where: {
        batchId,
        userId,
        memberRole,
        isActive,
      },
    });
  }

  async findActiveBatchMenteeMembers(batchId: string): Promise<BatchMember[]> {
    return await this.memberRepo.find({
      where: {
        batchId,
        memberRole: BatchMemberRole.MENTEE,
        isActive: true,
      },
      select: ['userId'],
    });
  }

  async findActiveBatchMenteesByUserIds(
    batchId: string,
    userIds: string[],
  ): Promise<BatchMember[]> {
    if (userIds.length === 0) return [];
    return await this.memberRepo.find({
      where: {
        batchId,
        userId: In(userIds),
        memberRole: BatchMemberRole.MENTEE,
        isActive: true,
      },
    });
  }

  async findActiveMentorBatchIds(userId: string): Promise<string[]> {
    const memberships = await this.memberRepo.find({
      where: {
        userId,
        memberRole: BatchMemberRole.MENTOR,
        isActive: true,
      },
      select: ['batchId'],
    });
    return memberships.map((m) => m.batchId);
  }

  async findUsersByIds(userIds: string[]): Promise<User[]> {
    if (userIds.length === 0) return [];
    return await this.getUserRepo().find({
      where: { id: In(userIds) },
    });
  }

  async findOpenAllocationsForMentees(
    courseId: string,
    menteeIds: string[],
    manager?: EntityManager,
  ): Promise<CourseAllocation[]> {
    if (menteeIds.length === 0) return [];
    return await this.getAllocationRepo(manager).find({
      where: {
        courseId,
        userId: In(menteeIds),
        status: In([CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS]),
      },
    });
  }

  async findOpenAllocation(
    courseId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<CourseAllocation | null> {
    return await this.getAllocationRepo(manager).findOne({
      where: {
        courseId,
        userId,
        status: In([CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS]),
      },
    });
  }

  async findActiveOrCompletedAllocation(
    courseId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<CourseAllocation | null> {
    return await this.getAllocationRepo(manager).findOne({
      where: {
        courseId,
        userId,
        status: In([
          CourseAllocationStatus.ASSIGNED,
          CourseAllocationStatus.IN_PROGRESS,
          CourseAllocationStatus.COMPLETED,
        ]),
      },
    });
  }

  async findAllocationById(id: string, manager?: EntityManager): Promise<CourseAllocation | null> {
    const allocation = await this.getAllocationRepo(manager)
      .createQueryBuilder('allocation')
      .leftJoinAndSelect('allocation.course', 'course')
      .leftJoinAndSelect('allocation.batch', 'batch')
      .leftJoinAndSelect('allocation.user', 'user')
      .leftJoinAndSelect('allocation.assignmentOverrides', 'assignmentOverrides')
      .leftJoinAndSelect('assignmentOverrides.assignment', 'assignment')
      .where('allocation.id = :id', { id })
      .getOne();

    if (allocation) {
      this.attachComputedFields(allocation);
    }

    return allocation;
  }

  async saveAllocations(
    allocations: CourseAllocation[],
    manager?: EntityManager,
  ): Promise<CourseAllocation[]> {
    return await this.getAllocationRepo(manager).save(allocations);
  }

  async listAllocations(
    query: Omit<ListAllocationsQuery, 'sortBy' | 'sortOrder'> &
      Partial<Pick<ListAllocationsQuery, 'sortBy' | 'sortOrder'>>,
    allowedBatchIds?: string[] | null,
    enforcedUserId?: string | null,
  ): Promise<AllocationListResult> {
    const qb: SelectQueryBuilder<CourseAllocation> = this.allocationRepo
      .createQueryBuilder('allocation')
      .leftJoinAndSelect('allocation.course', 'course')
      .leftJoinAndSelect('allocation.batch', 'batch')
      .leftJoinAndSelect('allocation.user', 'user');

    if (enforcedUserId) {
      qb.andWhere('allocation.userId = :enforcedUserId', { enforcedUserId });
    }

    if (allowedBatchIds !== undefined && allowedBatchIds !== null) {
      if (allowedBatchIds.length === 0) {
        return { allocations: [], total: 0, page: query.page, limit: query.limit };
      }
      qb.andWhere('allocation.batchId IN (:...allowedBatchIds)', { allowedBatchIds });
    }

    if (query.courseId) {
      qb.andWhere('allocation.courseId = :courseId', { courseId: query.courseId });
    }

    if (query.batchId) {
      qb.andWhere('allocation.batchId = :batchId', { batchId: query.batchId });
    }

    if (query.menteeId) {
      qb.andWhere('allocation.userId = :menteeId', { menteeId: query.menteeId });
    }

    const now = new Date();

    const statusesToFilter =
      query.statuses && query.statuses.length > 0
        ? query.statuses
        : query.status
          ? [query.status]
          : undefined;

    if (statusesToFilter && statusesToFilter.length > 0) {
      const isOverdueSelected = statusesToFilter.includes('OVERDUE');
      const regularStatuses = statusesToFilter.filter(
        (s): s is CourseAllocationStatus => s !== 'OVERDUE',
      );

      const statusClauses: string[] = [];

      if (isOverdueSelected) {
        statusClauses.push(
          '(allocation.dueDate < :now AND allocation.status NOT IN (:...terminalStatuses))',
        );
      }

      if (regularStatuses.length > 0) {
        if (isOverdueSelected) {
          statusClauses.push('allocation.status IN (:...regularStatuses)');
        } else {
          statusClauses.push(
            '(allocation.status IN (:...regularStatuses) AND (allocation.dueDate >= :now OR allocation.status IN (:...terminalStatuses)))',
          );
        }
      }

      if (statusClauses.length > 0) {
        qb.andWhere(`(${statusClauses.join(' OR ')})`, {
          now,
          terminalStatuses: [
            CourseAllocationStatus.COMPLETED,
            CourseAllocationStatus.REVOKED,
            CourseAllocationStatus.CLOSED_ROLE_CHANGE,
            CourseAllocationStatus.CLOSED_BATCH_CHANGE,
          ],
          regularStatuses,
        });
      }
    }

    if (query.dueDateFrom) {
      qb.andWhere('allocation.dueDate >= :dueDateFrom', { dueDateFrom: query.dueDateFrom });
    }

    if (query.dueDateTo) {
      qb.andWhere('allocation.dueDate <= :dueDateTo', { dueDateTo: query.dueDateTo });
    }

    if (query.search) {
      const rawSearch = query.search.trim();
      const searchPattern = `%${rawSearch}%`;
      const sLower = rawSearch.toLowerCase();
      const sNorm = sLower.replace(/[-_]/g, ' ').trim();

      const searchClauses: string[] = [
        'course.title ILIKE :search',
        'batch.name ILIKE :search',
        'batch.code ILIKE :search',
      ];

      // Only search user name/email when the query is NOT already scoped to a specific mentee/user
      if (!query.menteeId && !enforcedUserId) {
        searchClauses.push('user.name ILIKE :search');
        if (!['com', 'org', 'net', 'io', 'co', 'in'].includes(sLower) || rawSearch.includes('@')) {
          searchClauses.push('user.email ILIKE :search');
        }
      }

      // Smart status matching based on display labels
      if (sNorm.length >= 3) {
        if (
          'completed'.startsWith(sNorm) ||
          'complete'.startsWith(sNorm) ||
          sNorm === 'done' ||
          'finished'.startsWith(sNorm)
        ) {
          searchClauses.push(`allocation.status = '${CourseAllocationStatus.COMPLETED}'`);
        }
        if ('assigned'.startsWith(sNorm) || 'assign'.startsWith(sNorm)) {
          searchClauses.push(`allocation.status = '${CourseAllocationStatus.ASSIGNED}'`);
        }
        if (
          'in progress'.startsWith(sNorm) ||
          'progress'.startsWith(sNorm) ||
          'active'.startsWith(sNorm) ||
          'ongoing'.startsWith(sNorm)
        ) {
          searchClauses.push(`allocation.status = '${CourseAllocationStatus.IN_PROGRESS}'`);
        }
        if (
          'overdue'.startsWith(sNorm) ||
          'late'.startsWith(sNorm) ||
          'expired'.startsWith(sNorm)
        ) {
          searchClauses.push(
            `(allocation.dueDate < :searchNow AND allocation.status NOT IN ('${CourseAllocationStatus.COMPLETED}', '${CourseAllocationStatus.REVOKED}', '${CourseAllocationStatus.CLOSED_ROLE_CHANGE}', '${CourseAllocationStatus.CLOSED_BATCH_CHANGE}'))`,
          );
        }
      }

      qb.andWhere(`(${searchClauses.join(' OR ')})`, {
        search: searchPattern,
        searchNow: now,
      });
    }

    const sortColumns: Record<string, string> = {
      course: 'LOWER(course.title)',
      mentee: 'LOWER(user.name)',
      batch: 'LOWER(batch.name)',
      startDate: 'allocation.startDate',
      started: 'allocation.startDate',
      dueDate: 'allocation.dueDate',
      due: 'allocation.dueDate',
      progress: 'allocation.progressPercent',
      status: 'allocation.status',
      createdAt: 'allocation.createdAt',
    };
    const sortBy = query.sortBy ?? 'createdAt';
    const sortColumn = sortColumns[sortBy] ?? 'allocation.createdAt';
    const safeSortOrder = (query.sortOrder || 'desc').toUpperCase() as 'ASC' | 'DESC';

    qb.orderBy(sortColumn, safeSortOrder, 'NULLS LAST');
    if (sortColumn !== 'allocation.createdAt') {
      qb.addOrderBy('allocation.createdAt', 'DESC');
    }
    qb.addOrderBy('allocation.id', 'ASC');
    qb.offset((query.page - 1) * query.limit).limit(query.limit);

    const [allocations, total] = await qb.getManyAndCount();

    allocations.forEach((alloc) => this.attachComputedFields(alloc));

    return {
      allocations,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async saveAllocation(
    allocation: CourseAllocation,
    manager?: EntityManager,
  ): Promise<CourseAllocation> {
    return await this.getAllocationRepo(manager).save(allocation);
  }

  async findAllocationsByIds(ids: string[], manager?: EntityManager): Promise<CourseAllocation[]> {
    if (ids.length === 0) return [];
    return await this.getAllocationRepo(manager).find({
      where: { id: In(ids) },
      relations: ['course', 'batch', 'user'],
    });
  }

  async saveAssignmentOverride(
    override: AssignmentDueOverride,
    manager?: EntityManager,
  ): Promise<AssignmentDueOverride> {
    return await this.getOverrideRepo(manager).save(override);
  }

  async findAssignmentOverride(
    courseAllocationId: string,
    assignmentId: string,
    manager?: EntityManager,
  ): Promise<AssignmentDueOverride | null> {
    return await this.getOverrideRepo(manager).findOne({
      where: { courseAllocationId, assignmentId },
    });
  }

  async findOverridesByAllocationId(
    courseAllocationId: string,
    manager?: EntityManager,
  ): Promise<AssignmentDueOverride[]> {
    return await this.getOverrideRepo(manager).find({
      where: { courseAllocationId },
      relations: ['assignment', 'setter'],
    });
  }

  async closeAllocationsForBatchTransfer(
    batchId: string,
    menteeId: string,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<number> {
    const updateData: Record<string, unknown> = {
      status: CourseAllocationStatus.CLOSED_BATCH_CHANGE,
    };
    if (actorId) {
      updateData.updatedBy = actorId;
    }
    const result = await this.getAllocationRepo(manager)
      .createQueryBuilder()
      .update(CourseAllocation)
      .set(updateData)
      .where('batch_id = :batchId AND user_id = :menteeId AND status IN (:...openStatuses)', {
        batchId,
        menteeId,
        openStatuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .execute();
    return result.affected ?? 0;
  }

  async closeAllocationsForRoleChange(
    userId: string,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<number> {
    const updateData: Record<string, unknown> = {
      status: CourseAllocationStatus.CLOSED_ROLE_CHANGE,
    };
    if (actorId) {
      updateData.updatedBy = actorId;
    }
    const result = await this.getAllocationRepo(manager)
      .createQueryBuilder()
      .update(CourseAllocation)
      .set(updateData)
      .where('user_id = :userId AND status IN (:...openStatuses)', {
        userId,
        openStatuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .execute();
    return result.affected ?? 0;
  }

  async findOpenBatchAllocations(batchId: string): Promise<CourseAllocation[]> {
    return await this.allocationRepo.find({
      where: {
        batchId,
        status: In([CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS]),
      },
      relations: ['course'],
    });
  }

  public async findOverdueAllocations(
    since: Date = new Date(Date.now() - 24 * 3600000),
    now: Date = new Date(),
    limit: number = SCHEDULED_JOBS_BATCH_LIMIT,
  ): Promise<CourseAllocation[]> {
    return await this.allocationRepo
      .createQueryBuilder('ca')
      .where('ca.status IN (:...statuses)', {
        statuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .andWhere('ca.dueDate >= :since AND ca.dueDate < :now', { since, now })
      .andWhere('ca.deletedAt IS NULL')
      .take(limit)
      .getMany();
  }

  public async findUpcomingDeadlines(
    windowStart: Date = new Date(Date.now() + UPCOMING_DEADLINE_WINDOW_START_HOURS * 3600000),
    windowEnd: Date = new Date(Date.now() + UPCOMING_DEADLINE_WINDOW_END_HOURS * 3600000),
    limit: number = SCHEDULED_JOBS_BATCH_LIMIT,
  ): Promise<CourseAllocation[]> {
    return await this.allocationRepo
      .createQueryBuilder('ca')
      .where('ca.status IN (:...statuses)', {
        statuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .andWhere('ca.dueDate >= :windowStart AND ca.dueDate <= :windowEnd', {
        windowStart,
        windowEnd,
      })
      .andWhere('ca.deletedAt IS NULL')
      .take(limit)
      .getMany();
  }

  private attachComputedFields(allocation: CourseAllocation): void {
    const now = new Date();
    const isTerminal = [
      CourseAllocationStatus.COMPLETED,
      CourseAllocationStatus.REVOKED,
      CourseAllocationStatus.CLOSED_ROLE_CHANGE,
      CourseAllocationStatus.CLOSED_BATCH_CHANGE,
    ].includes(allocation.status);

    allocation.isOverdue = !isTerminal && new Date(allocation.dueDate).getTime() < now.getTime();
  }
}

export const allocationsRepository = new AllocationsRepository();
