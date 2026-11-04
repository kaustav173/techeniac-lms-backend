import { logAudit } from '../../core/audit';
import type { AuthenticatedUser } from '../../core/auth';
import { isUniqueViolation } from '../../core/db';
import { emailService } from '../../core/email';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { eventBus } from '../../core/lifecycle';
import { logger } from '../../core/logging';
import { AuditType } from '../audit';
import { BatchStatus } from '../batches';
import { UserRole } from '../users';
import { AllocationsPolicy, allocationsPolicy } from './allocations.policy';
import {
  AllocationsRepository,
  allocationsRepository,
  SCHEDULED_JOBS_BATCH_LIMIT,
} from './allocations.repository';
import { CourseAllocationStatus } from './entities/allocation.enums';
import { AssignmentDueOverride } from './entities/assignment-due-override.entity';
import { CourseAllocation } from './entities/course-allocation.entity';
import type {
  AddMenteesToAllocationInput,
  AssignmentDueOverrideInput,
  BulkAssignmentDueOverrideInput,
  BulkUpdateAllocationDatesInput,
  CreateAllocationsInput,
  ListAllocationsQuery,
  UpdateAllocationDatesInput,
} from './schemas/allocation.schemas';

export const TERMINAL_ALLOCATION_STATUSES: readonly CourseAllocationStatus[] = [
  CourseAllocationStatus.COMPLETED,
  CourseAllocationStatus.REVOKED,
  CourseAllocationStatus.CLOSED_ROLE_CHANGE,
  CourseAllocationStatus.CLOSED_BATCH_CHANGE,
];

export interface CreateAllocationsResult {
  created: CourseAllocation[];
  skipped: Array<{ menteeId: string; reason: string }>;
}

export interface BulkUpdateAllocationsResult {
  allocations: CourseAllocation[];
  skipped: Array<{ allocationId: string; reason: string }>;
}

export interface BulkAssignmentDueOverridesResult {
  overrides: AssignmentDueOverride[];
  skipped: Array<{ allocationId: string; reason: string }>;
}

export class AllocationsService {
  constructor(
    private readonly repo: AllocationsRepository = allocationsRepository,
    private readonly policy: AllocationsPolicy = allocationsPolicy,
  ) {}

  async createAllocations(
    input: CreateAllocationsInput,
    actor: AuthenticatedUser,
  ): Promise<CreateAllocationsResult> {
    await this.policy.assertCanAssignCourse(
      actor,
      input.targetType,
      input.batchId,
      input.menteeIds,
    );

    const course = await this.repo.findCourseById(input.courseId);
    if (!course) {
      throw new NotFoundError('Course not found');
    }

    if (!course.isActive) {
      throw new ValidationError('Cannot allocate an inactive course');
    }

    const startDate = new Date(input.startDate);
    const dueDate = this.computeDueDate(startDate, input.dueDate, course.estimatedMinutes);

    const { targetMenteeIds, requestSkipped } = await this.resolveTargetMenteeIds(input);
    if (targetMenteeIds.length === 0) {
      return { created: [], skipped: requestSkipped };
    }

    const { eligibleMenteeIds, openAllocationSkipped } = await this.partitionEligibleMentees(
      course.id,
      targetMenteeIds,
    );

    const skipped = [...requestSkipped, ...openAllocationSkipped];

    if (input.targetType === 'INDIVIDUAL_MENTEES' && eligibleMenteeIds.length === 0) {
      throw new ConflictError('Mentee already has an open allocation of the same course');
    }

    if (eligibleMenteeIds.length === 0) {
      return { created: [], skipped };
    }

    const allocationsToCreate: CourseAllocation[] = eligibleMenteeIds.map((menteeId) => {
      const allocation = new CourseAllocation();
      allocation.courseId = course.id;
      allocation.batchId =
        input.targetType === 'INDIVIDUAL_MENTEES' ? null : (input.batchId ?? null);
      allocation.userId = menteeId;
      allocation.startDate = startDate;
      allocation.estimatedMinutes = course.estimatedMinutes;
      allocation.dueDate = dueDate;
      allocation.status = CourseAllocationStatus.ASSIGNED;
      allocation.progressPercent = 0;
      allocation.createdBy = actor.id;
      return allocation;
    });

    let savedAllocations: CourseAllocation[];
    try {
      savedAllocations = await this.repo.transaction(async (manager) => {
        return await this.repo.saveAllocations(allocationsToCreate, manager);
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Mentee already has an open allocation of this course');
      }
      throw err;
    }

    eventBus.emitEvent('allocation.created', {
      allocationIds: savedAllocations.map((a) => a.id),
      courseId: course.id,
    });

    await Promise.all(
      savedAllocations.map((alloc) =>
        logAudit({
          actorId: actor.id,
          type: AuditType.COURSE_ALLOCATION,
          entity: 'CourseAllocation',
          entityId: alloc.id,
          action: 'ALLOCATE_COURSE',
          newValue: {
            courseId: alloc.courseId,
            userId: alloc.userId,
            batchId: alloc.batchId,
            startDate: alloc.startDate,
            dueDate: alloc.dueDate,
          },
        }),
      ),
    );

    void this.dispatchAllocationEmails(savedAllocations, course.title, input.batchId);

    return {
      created: savedAllocations,
      skipped,
    };
  }

  /**
   * Internal service path for batch lifecycle auto-reallocation.
   * Directly creates allocation records without fabricating an AuthenticatedUser.
   */
  async createBatchMemberAllocationInternal(params: {
    courseId: string;
    batchId: string;
    menteeId: string;
    startDate: Date;
    dueDate: Date;
    actorId?: string | null;
  }): Promise<CourseAllocation | null> {
    const course = await this.repo.findCourseById(params.courseId);
    if (!course || !course.isActive) {
      return null;
    }

    const openAllocations = await this.repo.findOpenAllocationsForMentees(course.id, [
      params.menteeId,
    ]);
    if (openAllocations.length > 0) {
      throw new ConflictError('Mentee already has an open allocation of this course');
    }

    const allocation = new CourseAllocation();
    allocation.courseId = course.id;
    allocation.batchId = params.batchId;
    allocation.userId = params.menteeId;
    allocation.startDate = params.startDate;
    allocation.estimatedMinutes = course.estimatedMinutes;
    allocation.dueDate = params.dueDate;
    allocation.status = CourseAllocationStatus.ASSIGNED;
    allocation.progressPercent = 0;
    allocation.createdBy = params.actorId ?? null;

    let savedAllocations: CourseAllocation[];
    try {
      savedAllocations = await this.repo.transaction(async (manager) => {
        return await this.repo.saveAllocations([allocation], manager);
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Mentee already has an open allocation of this course');
      }
      throw err;
    }

    const saved = savedAllocations[0];
    if (!saved) {
      return null;
    }

    eventBus.emitEvent('allocation.created', {
      allocationIds: [saved.id],
      courseId: course.id,
    });

    void this.dispatchAllocationEmails([saved], course.title, params.batchId);
    return saved;
  }

  /**
   * Reusable guard ensuring that mutations only occur on non-terminal allocations.
   * Throws ConflictError (HTTP 409) if the allocation is already COMPLETED, REVOKED,
   * CLOSED_ROLE_CHANGE, or CLOSED_BATCH_CHANGE.
   */
  assertAllocationIsMutable(allocation: CourseAllocation): void {
    if (TERMINAL_ALLOCATION_STATUSES.includes(allocation.status)) {
      throw new ConflictError(`Cannot modify allocation in terminal status '${allocation.status}'`);
    }
  }

  private computeDueDate(
    startDate: Date,
    inputDueDate?: string,
    estimatedMinutes?: number | null,
  ): Date {
    if (inputDueDate) {
      const dueDate = new Date(inputDueDate);
      if (dueDate.getTime() < startDate.getTime()) {
        throw new ValidationError('Due date earlier than start date');
      }
      return dueDate;
    }

    if (estimatedMinutes && estimatedMinutes > 0) {
      return new Date(startDate.getTime() + estimatedMinutes * 60 * 1000);
    }

    throw new ValidationError('Course has no estimated minutes and no due date entered');
  }

  private async resolveTargetMenteeIds(input: CreateAllocationsInput): Promise<{
    targetMenteeIds: string[];
    requestSkipped: Array<{ menteeId: string; reason: string }>;
  }> {
    if (input.targetType === 'BATCH') {
      const activeMenteeMembers = await this.repo.findActiveBatchMenteeMembers(input.batchId!);
      return {
        targetMenteeIds: activeMenteeMembers.map((m) => m.userId),
        requestSkipped: [],
      };
    }

    const rawMenteeIds = input.menteeIds ?? [];
    const seen = new Set<string>();
    const targetMenteeIds: string[] = [];
    const requestSkipped: Array<{ menteeId: string; reason: string }> = [];

    for (const id of rawMenteeIds) {
      if (seen.has(id)) {
        requestSkipped.push({ menteeId: id, reason: 'Duplicate ID in request' });
      } else {
        seen.add(id);
        targetMenteeIds.push(id);
      }
    }

    return { targetMenteeIds, requestSkipped };
  }

  private async partitionEligibleMentees(
    courseId: string,
    targetMenteeIds: string[],
  ): Promise<{
    eligibleMenteeIds: string[];
    openAllocationSkipped: Array<{ menteeId: string; reason: string }>;
  }> {
    const existingOpenAllocations = await this.repo.findOpenAllocationsForMentees(
      courseId,
      targetMenteeIds,
    );
    const openMenteeIdSet = new Set(existingOpenAllocations.map((a) => a.userId));

    const eligibleMenteeIds: string[] = [];
    const openAllocationSkipped: Array<{ menteeId: string; reason: string }> = [];

    for (const menteeId of targetMenteeIds) {
      if (openMenteeIdSet.has(menteeId)) {
        openAllocationSkipped.push({
          menteeId,
          reason: 'Mentee already has an open allocation of the same course',
        });
      } else {
        eligibleMenteeIds.push(menteeId);
      }
    }

    return { eligibleMenteeIds, openAllocationSkipped };
  }

  private async dispatchAllocationEmails(
    savedAllocations: CourseAllocation[],
    courseTitle: string,
    batchId?: string,
  ): Promise<void> {
    try {
      const [users, batch] = await Promise.all([
        this.repo.findUsersByIds(savedAllocations.map((a) => a.userId)),
        batchId ? this.repo.findBatchById(batchId) : Promise.resolve(null),
      ]);

      for (const alloc of savedAllocations) {
        const user = users.find((u) => u.id === alloc.userId);
        if (user?.email) {
          void emailService.sendCourseAllocatedEmail({
            to: user.email,
            userId: alloc.userId,
            recipientName: user.name,
            courseTitle,
            startDate: alloc.startDate.toISOString().slice(0, 10),
            dueDate: alloc.dueDate.toISOString().slice(0, 10),
            batchName: batch?.name,
          });
        }
      }
    } catch (err: unknown) {
      logger.warn({ err }, 'Failed to dispatch one or more allocation notification emails');
    }
  }

  async listAllocations(query: ListAllocationsQuery, actor: AuthenticatedUser) {
    const actorRole = actor.role as UserRole;

    if (actorRole === UserRole.MENTEE) {
      return await this.repo.listAllocations(query, undefined, actor.id);
    }

    if (actorRole === UserRole.MENTOR) {
      const allowedBatchIds = await this.policy.getMentorAccessibleBatchIds(actor);
      return await this.repo.listAllocations(query, allowedBatchIds, null);
    }

    // SUPER_ADMIN
    return await this.repo.listAllocations(query, null, null);
  }

  async getAllocationById(id: string, actor: AuthenticatedUser): Promise<CourseAllocation> {
    const allocation = await this.repo.findAllocationById(id);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    const actorRole = actor.role as UserRole;
    if (actorRole === UserRole.MENTEE) {
      if (allocation.userId !== actor.id) {
        throw new ForbiddenError('Access denied');
      }
      return allocation;
    }

    await this.policy.assertCanManageAllocation(actor, allocation);
    return allocation;
  }

  async updateAllocationDates(
    id: string,
    input: UpdateAllocationDatesInput,
    actor: AuthenticatedUser,
  ): Promise<CourseAllocation> {
    const allocation = await this.repo.findAllocationById(id);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    await this.policy.assertCanManageAllocation(actor, allocation);
    this.assertAllocationIsMutable(allocation);

    const previousStartDate = allocation.startDate.toISOString();
    const previousDueDate = allocation.dueDate.toISOString();

    if (input.startDate) {
      allocation.startDate = new Date(input.startDate);
    }
    if (input.dueDate) {
      allocation.dueDate = new Date(input.dueDate);
    }

    if (new Date(allocation.dueDate).getTime() < new Date(allocation.startDate).getTime()) {
      throw new ValidationError('Due date cannot be earlier than start date');
    }

    allocation.updatedBy = actor.id;
    const saved = await this.repo.saveAllocation(allocation);

    eventBus.emitEvent('allocation.deadlineChanged', {
      allocationId: saved.id,
      dueDate: saved.dueDate.toISOString(),
    });

    await logAudit({
      actorId: actor.id,
      type: AuditType.COURSE_ALLOCATION,
      entity: 'CourseAllocation',
      entityId: saved.id,
      action: 'UPDATE_ALLOCATION_DATES',
      oldValue: { startDate: previousStartDate, dueDate: previousDueDate },
      newValue: {
        startDate: saved.startDate.toISOString(),
        dueDate: saved.dueDate.toISOString(),
      },
    });

    if (input.dueDate && saved.user?.email) {
      void emailService.sendCourseDeadlineChangedEmail({
        to: saved.user.email,
        userId: saved.userId,
        recipientName: saved.user.name,
        courseTitle: saved.course?.title ?? 'Allocated Course',
        newDueDate: saved.dueDate.toISOString().slice(0, 10),
      });
    }

    return saved;
  }

  async bulkUpdateAllocationDates(
    input: BulkUpdateAllocationDatesInput,
    actor: AuthenticatedUser,
  ): Promise<BulkUpdateAllocationsResult> {
    const allocations = await this.repo.findAllocationsByIds(input.allocationIds);

    const foundIdSet = new Set(allocations.map((a) => a.id));
    const skipped: Array<{ allocationId: string; reason: string }> = [];

    for (const id of input.allocationIds) {
      if (!foundIdSet.has(id)) {
        skipped.push({ allocationId: id, reason: 'Allocation not found' });
      }
    }

    const validAllocations: CourseAllocation[] = [];
    for (const alloc of allocations) {
      await this.policy.assertCanManageAllocation(actor, alloc);
      if (TERMINAL_ALLOCATION_STATUSES.includes(alloc.status)) {
        skipped.push({
          allocationId: alloc.id,
          reason: 'Allocation is closed or completed',
        });
        continue;
      }
      validAllocations.push(alloc);
    }

    if (validAllocations.length === 0) {
      return { allocations: [], skipped };
    }

    const updated = await this.repo.transaction(async (manager) => {
      for (const alloc of validAllocations) {
        if (input.startDate) {
          alloc.startDate = new Date(input.startDate);
        }
        if (input.dueDate) {
          alloc.dueDate = new Date(input.dueDate);
        }

        if (new Date(alloc.dueDate).getTime() < new Date(alloc.startDate).getTime()) {
          throw new ValidationError('Due date cannot be earlier than start date');
        }

        alloc.updatedBy = actor.id;
      }
      return await this.repo.saveAllocations(validAllocations, manager);
    });

    for (const alloc of updated) {
      eventBus.emitEvent('allocation.deadlineChanged', {
        allocationId: alloc.id,
        dueDate: alloc.dueDate.toISOString(),
      });
    }

    await Promise.all(
      updated.map((alloc) =>
        logAudit({
          actorId: actor.id,
          type: AuditType.COURSE_ALLOCATION,
          entity: 'CourseAllocation',
          entityId: alloc.id,
          action: 'UPDATE_ALLOCATION_DATES',
          newValue: {
            startDate: alloc.startDate.toISOString(),
            dueDate: alloc.dueDate.toISOString(),
          },
        }),
      ),
    );

    return { allocations: updated, skipped };
  }

  async revokeAllocation(id: string, actor: AuthenticatedUser): Promise<CourseAllocation> {
    const allocation = await this.repo.findAllocationById(id);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    await this.policy.assertCanManageAllocation(actor, allocation);
    this.assertAllocationIsMutable(allocation);

    const previousStatus = allocation.status;
    allocation.status = CourseAllocationStatus.REVOKED;
    allocation.updatedBy = actor.id;

    const saved = await this.repo.saveAllocation(allocation);

    await logAudit({
      actorId: actor.id,
      type: AuditType.COURSE_ALLOCATION,
      entity: 'CourseAllocation',
      entityId: id,
      action: 'REVOKE_ALLOCATION',
      oldValue: { status: previousStatus },
      newValue: { status: CourseAllocationStatus.REVOKED },
    });

    return saved;
  }

  async addMenteesToBatchAllocation(
    id: string,
    input: AddMenteesToAllocationInput,
    actor: AuthenticatedUser,
  ): Promise<CreateAllocationsResult> {
    const allocation = await this.repo.findAllocationById(id);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    if (!allocation.batchId) {
      throw new ValidationError('Cannot add mentees to an allocation that has no batch');
    }

    await this.policy.assertCanManageAllocation(actor, allocation);

    return await this.createAllocations(
      {
        courseId: allocation.courseId,
        targetType: 'SELECTED_MENTEES',
        batchId: allocation.batchId,
        menteeIds: input.menteeIds,
        startDate: input.startDate ?? allocation.startDate.toISOString(),
        dueDate: input.dueDate ?? allocation.dueDate.toISOString(),
      },
      actor,
    );
  }

  async setAssignmentDueOverride(
    allocationId: string,
    input: AssignmentDueOverrideInput,
    actor: AuthenticatedUser,
  ): Promise<AssignmentDueOverride> {
    const allocation = await this.repo.findAllocationById(allocationId);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    await this.policy.assertCanManageAllocation(actor, allocation);
    this.assertAllocationIsMutable(allocation);

    let override = await this.repo.findAssignmentOverride(allocationId, input.assignmentId);
    const previousDueDate = override?.dueDate ? override.dueDate.toISOString() : null;

    if (!override) {
      override = new AssignmentDueOverride();
      override.courseAllocationId = allocationId;
      override.assignmentId = input.assignmentId;
      override.createdBy = actor.id;
    }

    override.dueDate = new Date(input.dueDate);
    override.setBy = actor.id;
    override.updatedBy = actor.id;

    const saved = await this.repo.saveAssignmentOverride(override);

    await logAudit({
      actorId: actor.id,
      type: AuditType.COURSE_ALLOCATION,
      entity: 'AssignmentDueOverride',
      entityId: saved.id,
      action: 'OVERRIDE_DUE_DATE',
      oldValue: previousDueDate ? { dueDate: previousDueDate } : null,
      newValue: {
        courseAllocationId: allocationId,
        assignmentId: input.assignmentId,
        dueDate: input.dueDate,
      },
    });

    return saved;
  }

  async bulkSetAssignmentDueOverrides(
    input: BulkAssignmentDueOverrideInput,
    actor: AuthenticatedUser,
  ): Promise<BulkAssignmentDueOverridesResult> {
    const allocations = await this.repo.findAllocationsByIds(input.allocationIds);

    const foundIdSet = new Set(allocations.map((a) => a.id));
    const skipped: Array<{ allocationId: string; reason: string }> = [];

    for (const id of input.allocationIds) {
      if (!foundIdSet.has(id)) {
        skipped.push({ allocationId: id, reason: 'Allocation not found' });
      }
    }

    const validAllocations: CourseAllocation[] = [];
    for (const alloc of allocations) {
      await this.policy.assertCanManageAllocation(actor, alloc);
      if (TERMINAL_ALLOCATION_STATUSES.includes(alloc.status)) {
        skipped.push({
          allocationId: alloc.id,
          reason: 'Allocation is closed or completed',
        });
        continue;
      }
      validAllocations.push(alloc);
    }

    if (validAllocations.length === 0) {
      return { overrides: [], skipped };
    }

    const overrides: AssignmentDueOverride[] = [];

    await this.repo.transaction(async (manager) => {
      for (const alloc of validAllocations) {
        let override = await this.repo.findAssignmentOverride(
          alloc.id,
          input.assignmentId,
          manager,
        );
        if (!override) {
          override = new AssignmentDueOverride();
          override.courseAllocationId = alloc.id;
          override.assignmentId = input.assignmentId;
          override.createdBy = actor.id;
        }

        override.dueDate = new Date(input.dueDate);
        override.setBy = actor.id;
        override.updatedBy = actor.id;

        const saved = await this.repo.saveAssignmentOverride(override, manager);
        overrides.push(saved);
      }
    });

    return { overrides, skipped };
  }

  async getAssignmentOverrides(
    allocationId: string,
    actor: AuthenticatedUser,
  ): Promise<AssignmentDueOverride[]> {
    const allocation = await this.repo.findAllocationById(allocationId);
    if (!allocation) {
      throw new NotFoundError('Course allocation not found');
    }

    const actorRole = actor.role as UserRole;
    if (actorRole === UserRole.MENTEE && allocation.userId !== actor.id) {
      throw new ForbiddenError('Access denied');
    }

    if (actorRole === UserRole.MENTOR) {
      await this.policy.assertCanManageAllocation(actor, allocation);
    }

    return await this.repo.findOverridesByAllocationId(allocationId);
  }

  /**
   * BAT-10: On batch member transfer, close open allocations in old batch as CLOSED_BATCH_CHANGE
   * and auto-reallocate active courses of the new batch.
   *
   * Due Date Rule:
   * 1. Inspect latest due date of active allocations for each course in new batch.
   * 2. If latest due date <= Date.now(), the batch course deadline has already elapsed; skip reallocation.
   * 3. Late joiner guarantee: provide at least course estimated minutes from now (now + estimatedMinutes),
   *    or the latest batch due date, whichever is greater.
   */
  async handleBatchMemberTransferred(payload: {
    batchId: string;
    menteeId: string;
    newBatchId: string;
    actorId?: string;
  }): Promise<void> {
    await this.repo.closeAllocationsForBatchTransfer(
      payload.batchId,
      payload.menteeId,
      payload.actorId,
    );

    const openBatchAllocations = await this.repo.findOpenBatchAllocations(payload.newBatchId);
    const uniqueCourseIds = Array.from(new Set(openBatchAllocations.map((a) => a.courseId)));

    for (const courseId of uniqueCourseIds) {
      const courseAllocations = openBatchAllocations.filter((a) => a.courseId === courseId);
      const latestDueDate = courseAllocations.reduce((max, curr) => {
        return curr.dueDate.getTime() > max.getTime() ? curr.dueDate : max;
      }, new Date(0));

      if (latestDueDate.getTime() <= Date.now()) {
        continue;
      }

      const course = courseAllocations[0]?.course;
      const minDueDate = new Date(Date.now() + (course?.estimatedMinutes || 0) * 60 * 1000);
      const effectiveDueDate = new Date(Math.max(latestDueDate.getTime(), minDueDate.getTime()));

      try {
        await this.createBatchMemberAllocationInternal({
          courseId,
          batchId: payload.newBatchId,
          menteeId: payload.menteeId,
          startDate: new Date(),
          dueDate: effectiveDueDate,
          actorId: payload.actorId ?? null,
        });
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          logger.info(
            { courseId, menteeId: payload.menteeId },
            'Auto-reallocation skipped on batch transfer: mentee already has an open allocation',
          );
        } else {
          logger.error(
            { err, courseId, menteeId: payload.menteeId, newBatchId: payload.newBatchId },
            'Failed auto-reallocation on batch member transfer',
          );
        }
      }
    }
  }

  /**
   * BAT-12: When a mentee joins a LIVE batch, auto-allocate open courses with future deadlines.
   *
   * Due Date Rule:
   * 1. Inspect latest due date of active allocations for each course in the batch.
   * 2. If latest due date <= Date.now(), the batch course deadline has already elapsed; skip reallocation.
   * 3. Late joiner guarantee: provide at least course estimated minutes from now (now + estimatedMinutes),
   *    or the latest batch due date, whichever is greater.
   */
  async handleBatchMemberJoined(payload: {
    batchId: string;
    userId: string;
    role: string;
    actorId?: string;
  }): Promise<void> {
    if ((payload.role as UserRole) !== UserRole.MENTEE) {
      return;
    }

    const batch = await this.repo.findBatchById(payload.batchId);
    if (!batch || batch.status !== BatchStatus.LIVE) {
      return;
    }

    const openBatchAllocations = await this.repo.findOpenBatchAllocations(payload.batchId);
    const uniqueCourseIds = Array.from(new Set(openBatchAllocations.map((a) => a.courseId)));

    for (const courseId of uniqueCourseIds) {
      const courseAllocations = openBatchAllocations.filter((a) => a.courseId === courseId);
      const latestDueDate = courseAllocations.reduce((max, curr) => {
        return curr.dueDate.getTime() > max.getTime() ? curr.dueDate : max;
      }, new Date(0));

      if (latestDueDate.getTime() <= Date.now()) {
        continue;
      }

      const course = courseAllocations[0]?.course;
      const minDueDate = new Date(Date.now() + (course?.estimatedMinutes || 0) * 60 * 1000);
      const effectiveDueDate = new Date(Math.max(latestDueDate.getTime(), minDueDate.getTime()));

      try {
        await this.createBatchMemberAllocationInternal({
          courseId,
          batchId: payload.batchId,
          menteeId: payload.userId,
          startDate: new Date(),
          dueDate: effectiveDueDate,
          actorId: payload.actorId ?? null,
        });
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          logger.info(
            { courseId, menteeId: payload.userId },
            'Auto-reallocation skipped on batch join: mentee already has an open allocation',
          );
        } else {
          logger.error(
            { err, courseId, menteeId: payload.userId, batchId: payload.batchId },
            'Failed auto-reallocation on batch member joined event',
          );
        }
      }
    }
  }

  async handleUserRoleChanged(payload: {
    userId: string;
    newRole: string;
    actorId?: string;
  }): Promise<void> {
    if ((payload.newRole as UserRole) !== UserRole.MENTEE) {
      await this.repo.closeAllocationsForRoleChange(payload.userId, payload.actorId);
    }
  }

  public async detectOverdueAllocations(
    since?: Date,
    now: Date = new Date(),
  ): Promise<{ overdueAllocationsCount: number }> {
    const overdueAllocations = await this.repo.findOverdueAllocations(since, now);

    if (overdueAllocations.length >= SCHEDULED_JOBS_BATCH_LIMIT) {
      logger.warn(
        { count: overdueAllocations.length, limit: SCHEDULED_JOBS_BATCH_LIMIT },
        'Overdue allocations query reached batch limit; remaining records will be evaluated on the next run',
      );
    }

    for (const ca of overdueAllocations) {
      eventBus.emitEvent('allocation.overdueDetected', {
        allocationId: ca.id,
        userId: ca.userId,
        courseId: ca.courseId,
        dueDate: ca.dueDate,
      });
    }

    return {
      overdueAllocationsCount: overdueAllocations.length,
    };
  }

  public async processDeadlineReminders(
    windowStart?: Date,
    windowEnd?: Date,
  ): Promise<{ reminderAllocationsCount: number }> {
    const now = new Date();
    const upcomingAllocations = await this.repo.findUpcomingDeadlines(windowStart, windowEnd);

    if (upcomingAllocations.length >= SCHEDULED_JOBS_BATCH_LIMIT) {
      logger.warn(
        { count: upcomingAllocations.length, limit: SCHEDULED_JOBS_BATCH_LIMIT },
        'Upcoming deadlines query reached batch limit; remaining records will be evaluated on the next run',
      );
    }

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
}

export const allocationsService = new AllocationsService();
