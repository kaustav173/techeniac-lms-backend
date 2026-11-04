import type { EntityManager } from 'typeorm';

import { logAudit } from '../../core/audit';
import { AppDataSource, isUniqueViolation } from '../../core/db';
import { EmailService, emailService, MenteeReassignRecipientRole } from '../../core/email';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../core/errors';
import { eventBus } from '../../core/lifecycle';
import { AuditType } from '../audit';
import { User, UserRepository, userRepository, UserRole } from '../users';
import { BatchRepository, batchRepository } from './batch.repository';
import { Batch, BatchMember, BatchMemberRole, BatchReasonToLeave, BatchStatus } from './entities';
import { MentorMenteeRepository, mentorMenteeRepository } from './mentor-mentee.repository';
import { MentorScopeAction, MentorScopeHelper, mentorScopeHelper } from './mentor-scope.helper';
import {
  AddBatchMembersInput,
  BatchQueryParams,
  ChangeBatchStatusInput,
  CreateBatchInput,
  MapMenteesInput,
  ReassignMenteeInput,
  TransferMenteeInput,
  UpdateBatchInput,
} from './schemas';

const ALLOWED_STATUS_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  [BatchStatus.DRAFT]: [BatchStatus.LIVE, BatchStatus.ARCHIVED],
  [BatchStatus.LIVE]: [BatchStatus.ON_HOLD, BatchStatus.COMPLETED],
  [BatchStatus.ON_HOLD]: [BatchStatus.LIVE, BatchStatus.COMPLETED],
  [BatchStatus.COMPLETED]: [BatchStatus.ARCHIVED],
  [BatchStatus.ARCHIVED]: [],
};

export class BatchService {
  constructor(
    private readonly batchRepo: BatchRepository = batchRepository,
    private readonly userRepo: UserRepository = userRepository,
    private readonly mentorMenteeRepo: MentorMenteeRepository = mentorMenteeRepository,
    private readonly emailSvc: EmailService = emailService,
    private readonly mentorScope: MentorScopeHelper = mentorScopeHelper,
  ) {}

  public async createBatch(input: CreateBatchInput, actorId: string) {
    const existingCode = await this.batchRepo.findByCode(input.code);
    if (existingCode) {
      throw new ConflictError(`Batch with code "${input.code}" already exists`);
    }

    const existingName = await this.batchRepo.findActiveByName(input.name);
    if (existingName) {
      throw new ConflictError(`A non-archived batch with name "${input.name}" already exists`);
    }

    try {
      return await AppDataSource.transaction(async (manager) => {
        const batch = await this.batchRepo.create(
          {
            ...input,
            createdBy: actorId,
          },
          actorId,
          manager,
        );

        await this.batchRepo.recordStatusHistory(
          batch.id,
          null,
          BatchStatus.DRAFT,
          actorId,
          'Initial batch creation in DRAFT status',
          manager,
        );

        return batch;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `A batch with code "${input.code}" or name "${input.name}" already exists`,
        );
      }
      throw err;
    }
  }

  private sanitizeBatchSummary(batch: Batch) {
    return {
      ...batch,
      creator: batch.creator
        ? {
            id: batch.creator.id,
            name: batch.creator.name,
            email: batch.creator.email,
          }
        : undefined,
    };
  }

  public async getBatches(params: BatchQueryParams) {
    const { items, total } = await this.batchRepo.findWithFilters(params);
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: items.map((b) => this.sanitizeBatchSummary(b)),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  public async getBatchById(id: string) {
    const batch = await this.batchRepo.findById(id);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    const [members, statusHistory, activeMappings] = await Promise.all([
      this.batchRepo.findMembersByBatchId(id),
      this.batchRepo.getStatusHistory(id),
      this.mentorMenteeRepo.findActiveMappingsByBatch(id),
    ]);
    const mappingByMenteeId = new Map(activeMappings.map((m) => [m.menteeId, m.mentor]));

    const sanitizeUser = (u?: { id: string; name: string; email: string } | null) =>
      u ? { id: u.id, name: u.name, email: u.email } : undefined;

    const mentors = members
      .filter((m) => m.memberRole === BatchMemberRole.MENTOR)
      .map((m) => ({
        ...m,
        user: sanitizeUser(m.user),
      }));

    const mentees = members
      .filter((m) => m.memberRole === BatchMemberRole.MENTEE)
      .map((m) => {
        const mappedMentor = mappingByMenteeId.get(m.userId);
        return {
          ...m,
          user: sanitizeUser(m.user),
          mappedToUser: mappedMentor ? { id: mappedMentor.id, name: mappedMentor.name } : null,
        };
      });

    const sanitizedHistory = statusHistory.map((h) => ({
      ...h,
      changer: sanitizeUser(h.changer),
    }));

    const sanitizedBatch = {
      ...batch,
      creator: sanitizeUser(batch.creator),
    };

    return {
      batch: sanitizedBatch,
      mentors,
      mentees,
      statusHistory: sanitizedHistory,
    };
  }

  public async updateBatch(id: string, input: UpdateBatchInput, actorId?: string) {
    const batch = await this.batchRepo.findById(id);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    if (batch.status === BatchStatus.ARCHIVED) {
      throw new BadRequestError('Archived batches cannot be edited');
    }

    if (input.name && input.name.trim() !== batch.name) {
      const existingName = await this.batchRepo.findActiveByName(input.name, id);
      if (existingName) {
        throw new ConflictError(`A non-archived batch with name "${input.name}" already exists`);
      }
    }

    const newStartDate = input.startDate ?? batch.startDate;
    const newEndDate = input.endDate ?? batch.endDate;
    if (new Date(newStartDate) > new Date(newEndDate)) {
      throw new BadRequestError('Start date must be before or equal to end date');
    }

    try {
      const updated = await this.batchRepo.update(id, input, actorId);
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`A non-archived batch with name "${input.name}" already exists`);
      }
      throw err;
    }
  }

  public async changeBatchStatus(id: string, input: ChangeBatchStatusInput, actorId: string) {
    const batch = await this.batchRepo.findById(id);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    const currentStatus = batch.status;
    const targetStatus = input.toStatus;

    if (currentStatus === targetStatus) {
      return batch;
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new BadRequestError(`Cannot transition batch from ${currentStatus} to ${targetStatus}`);
    }

    if (targetStatus === BatchStatus.LIVE) {
      const mentorCount = await this.batchRepo.countActiveMentors(id);
      if (mentorCount < 1) {
        throw new BadRequestError(
          'A batch must have at least one active mentor before transitioning to LIVE',
        );
      }
    }

    const updatedBatch = await AppDataSource.transaction(async (manager) => {
      // Auto-closeout if ARCHIVED
      if (targetStatus === BatchStatus.ARCHIVED) {
        await this.batchRepo.closeoutActiveMentees(id, actorId, manager);
        await this.mentorMenteeRepo.closeAllMappingsForBatch(
          id,
          BatchReasonToLeave.BATCH_ARCHIVED,
          manager,
          actorId,
        );
      }

      if (targetStatus === BatchStatus.COMPLETED) {
        await this.batchRepo.closeoutActiveMentees(id, actorId, manager);
      }

      const updated = await this.batchRepo.updateStatus(id, targetStatus, actorId, manager);

      await this.batchRepo.recordStatusHistory(
        id,
        currentStatus,
        targetStatus,
        actorId,
        input.reason,
        manager,
      );

      return updated;
    });

    await logAudit({
      actorId,
      type: AuditType.BATCH,
      entity: 'Batch',
      entityId: id,
      action: 'STATUS_CHANGE',
      oldValue: { status: currentStatus },
      newValue: { name: updatedBatch.name, status: targetStatus, reason: input.reason },
    });

    return updatedBatch;
  }

  private async validateMemberCandidate(
    batchId: string,
    userId: string,
    memberRole: BatchMemberRole,
    manager?: EntityManager,
  ): Promise<boolean> {
    const user = await this.userRepo.findById(userId, manager);
    if (!user || !user.isActive) {
      throw new BadRequestError(`User ${userId} not found or is deactivated`);
    }

    if (memberRole === BatchMemberRole.MENTEE && user.role !== UserRole.MENTEE) {
      throw new BadRequestError(
        `User "${user.name}" has role ${user.role} and cannot be added as a MENTEE`,
      );
    }
    if (memberRole === BatchMemberRole.MENTOR && user.role !== UserRole.MENTOR) {
      throw new BadRequestError(
        `User "${user.name}" has role ${user.role} and cannot be added as a MENTOR`,
      );
    }

    const alreadyInThisBatch = await this.batchRepo.findActiveMemberInBatch(
      batchId,
      userId,
      manager,
    );
    if (alreadyInThisBatch) {
      return false;
    }

    if (memberRole === BatchMemberRole.MENTEE) {
      const activeMembership = await this.batchRepo.findActiveMenteeMembership(userId, manager);
      if (activeMembership) {
        throw new ConflictError(
          `Mentee "${user.name}" is already an active member of batch "${activeMembership.batch.name}". Use batch transfer to move them.`,
        );
      }
    }

    return true;
  }

  public async addMembers(id: string, input: AddBatchMembersInput, actorId?: string) {
    const batch = await this.batchRepo.findById(id);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    if (batch.status === BatchStatus.ARCHIVED || batch.status === BatchStatus.COMPLETED) {
      throw new BadRequestError(`Cannot add members to a batch in ${batch.status} status`);
    }

    try {
      const result = await AppDataSource.transaction(async (manager) => {
        const addedMembers = [];
        const alreadyMembers: string[] = [];

        for (const userId of input.userIds) {
          const eligible = await this.validateMemberCandidate(
            id,
            userId,
            input.memberRole,
            manager,
          );
          if (!eligible) {
            alreadyMembers.push(userId);
            continue;
          }

          const member = await this.batchRepo.addMember(
            id,
            userId,
            input.memberRole,
            actorId,
            manager,
          );
          addedMembers.push(member);
        }

        return {
          added: addedMembers,
          alreadyMembers,
        };
      });

      for (const member of result.added) {
        eventBus.emitEvent('batch.memberJoined', {
          batchId: id,
          userId: member.userId,
          role: member.memberRole,
          actorId,
        });
      }

      return result;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A member is already assigned to an active batch');
      }
      throw err;
    }
  }

  public async removeMember(batchId: string, userId: string, actorId?: string) {
    const batch = await this.batchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    const membership = await this.batchRepo.findActiveMemberInBatch(batchId, userId);
    if (!membership) {
      throw new NotFoundError('Active member not found in this batch');
    }

    // Rule: At least one mentor per batch
    if (membership.memberRole === BatchMemberRole.MENTOR) {
      const activeMentors = await this.batchRepo.countActiveMentors(batchId);
      if (
        activeMentors <= 1 &&
        (batch.status === BatchStatus.LIVE || batch.status === BatchStatus.DRAFT)
      ) {
        throw new BadRequestError('A batch must have at least one active mentor');
      }
    }

    await AppDataSource.transaction(async (manager) => {
      await this.batchRepo.removeMember(
        membership.id,
        BatchReasonToLeave.REMOVED,
        actorId,
        manager,
      );
      await this.mentorMenteeRepo.closeAllMappingsForMember(
        batchId,
        userId,
        BatchReasonToLeave.REMOVED,
        manager,
        actorId,
      );
    });
  }

  public async transferMentee(sourceBatchId: string, input: TransferMenteeInput, actorId?: string) {
    if (sourceBatchId === input.targetBatchId) {
      throw new BadRequestError('Source and target batches must be different');
    }

    const [sourceBatch, targetBatch] = await Promise.all([
      this.batchRepo.findById(sourceBatchId),
      this.batchRepo.findById(input.targetBatchId),
    ]);

    if (!sourceBatch) {
      throw new NotFoundError('Source batch not found');
    }
    if (!targetBatch) {
      throw new NotFoundError('Target batch not found');
    }

    if (
      targetBatch.status === BatchStatus.ARCHIVED ||
      targetBatch.status === BatchStatus.COMPLETED
    ) {
      throw new BadRequestError(
        `Cannot transfer mentee into a batch with status ${targetBatch.status}`,
      );
    }

    const currentMembership = await this.requireActiveMember(
      sourceBatchId,
      input.menteeId,
      BatchMemberRole.MENTEE,
      'Mentee is not an active member of the source batch',
    );

    try {
      const newMembership = await AppDataSource.transaction(async (manager) => {
        // 1. End old membership with BATCH_TRANSFER
        await this.batchRepo.removeMember(
          currentMembership.id,
          BatchReasonToLeave.BATCH_TRANSFER,
          actorId,
          manager,
        );

        // 2. End old mapping in source batch
        await this.mentorMenteeRepo.closeAllMappingsForMember(
          sourceBatchId,
          input.menteeId,
          BatchReasonToLeave.BATCH_TRANSFER,
          manager,
          actorId,
        );

        // 3. Add to target batch
        const newMembership = await this.batchRepo.addMember(
          input.targetBatchId,
          input.menteeId,
          BatchMemberRole.MENTEE,
          actorId,
          manager,
        );

        return newMembership;
      });

      eventBus.emitEvent('batch.memberTransferred', {
        sourceBatchId,
        targetBatchId: input.targetBatchId,
        menteeId: input.menteeId,
        actorId,
      });

      return newMembership;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Mentee is already an active member of target batch');
      }
      throw err;
    }
  }

  // --- Mentor-Mentee Mapping Methods (FR-4.1 - 4.3) ---

  private async requireActiveMember(
    batchId: string,
    userId: string,
    role: BatchMemberRole,
    errorMessage: string,
    manager?: EntityManager,
  ): Promise<BatchMember> {
    const membership = await this.batchRepo.findActiveMemberInBatch(batchId, userId, manager);
    if (!membership || membership.memberRole !== role) {
      throw new BadRequestError(errorMessage);
    }
    return membership;
  }

  public async mapMentees(batchId: string, input: MapMenteesInput, actorId?: string) {
    const batch = await this.batchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    if (batch.status === BatchStatus.ARCHIVED || batch.status === BatchStatus.COMPLETED) {
      throw new BadRequestError(`Cannot map mentees in a batch with status ${batch.status}`);
    }

    const [mentorUser] = await Promise.all([
      this.userRepo.findById(input.mentorId),
      this.requireActiveMember(
        batchId,
        input.mentorId,
        BatchMemberRole.MENTOR,
        'Specified mentor is not an active mentor member in this batch',
      ),
    ]);
    if (!mentorUser || mentorUser.role !== UserRole.MENTOR) {
      throw new BadRequestError('User does not have the MENTOR role');
    }

    const uniqueMenteeIds = [...new Set(input.menteeIds)];
    const menteeUsers = await Promise.all(
      uniqueMenteeIds.map(async (menteeId) => {
        if (menteeId === input.mentorId) {
          throw new BadRequestError('A mentor cannot be mapped to themselves as a mentee');
        }

        const menteeUser = await this.userRepo.findById(menteeId);
        if (!menteeUser || menteeUser.role !== UserRole.MENTEE) {
          throw new BadRequestError(`User ${menteeId} does not have the MENTEE role`);
        }
        return menteeUser;
      }),
    );

    try {
      const { created, mappedMenteeUsers } = await AppDataSource.transaction(async (manager) => {
        const createdRecords = [];
        const mappedUsers: User[] = [];

        for (const menteeUser of menteeUsers) {
          await this.requireActiveMember(
            batchId,
            menteeUser.id,
            BatchMemberRole.MENTEE,
            `User ${menteeUser.id} is not an active mentee member in this batch`,
            manager,
          );

          const existingMapping = await this.mentorMenteeRepo.findActiveByMenteeAndBatch(
            batchId,
            menteeUser.id,
            manager,
          );
          if (existingMapping) {
            if (existingMapping.mentorId === input.mentorId) {
              continue;
            }
            throw new ConflictError(
              `Mentee is already actively mapped in this batch. Use reassign to change their mentor.`,
            );
          }

          const mapping = await this.mentorMenteeRepo.createMapping(
            {
              batchId,
              mentorId: input.mentorId,
              menteeId: menteeUser.id,
            },
            manager,
            actorId,
          );
          createdRecords.push(mapping);
          mappedUsers.push(menteeUser);
        }

        return { created: createdRecords, mappedMenteeUsers: mappedUsers };
      });

      await Promise.all(
        created.map((mapping) =>
          logAudit({
            actorId,
            type: AuditType.MENTOR_MAPPING,
            entity: 'MentorMentee',
            entityId: mapping.id,
            action: 'MAP_MENTEE',
            newValue: {
              batchId,
              mentorId: input.mentorId,
              menteeId: mapping.menteeId,
            },
          }),
        ),
      );

      // Post-commit notifications (PRD Section 7.2)
      for (const menteeUser of mappedMenteeUsers) {
        void this.emailSvc.sendMentorMappedEmail({
          to: mentorUser.email,
          recipientName: mentorUser.name,
          isMentor: true,
          otherPartyName: menteeUser.name,
          batchName: batch.name,
        });

        void this.emailSvc.sendMentorMappedEmail({
          to: menteeUser.email,
          recipientName: menteeUser.name,
          isMentor: false,
          otherPartyName: mentorUser.name,
          batchName: batch.name,
        });
      }

      return created;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Mentee is already actively mapped in this batch');
      }
      throw err;
    }
  }

  public async reassignMentee(batchId: string, input: ReassignMenteeInput, actorId?: string) {
    const batch = await this.batchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }

    if (batch.status === BatchStatus.ARCHIVED || batch.status === BatchStatus.COMPLETED) {
      throw new BadRequestError(`Cannot reassign mentees in a batch with status ${batch.status}`);
    }

    if (input.menteeId === input.newMentorId) {
      throw new BadRequestError('A mentor cannot be mapped to themselves as a mentee');
    }

    const [newMentorUser, menteeUser] = await Promise.all([
      this.userRepo.findById(input.newMentorId),
      this.userRepo.findById(input.menteeId),
      this.requireActiveMember(
        batchId,
        input.newMentorId,
        BatchMemberRole.MENTOR,
        'Target mentor is not an active mentor member in this batch',
      ),
      this.requireActiveMember(
        batchId,
        input.menteeId,
        BatchMemberRole.MENTEE,
        'Mentee is not an active member in this batch',
      ),
    ]);

    if (!newMentorUser || newMentorUser.role !== UserRole.MENTOR) {
      throw new BadRequestError('Target mentor does not have the MENTOR role');
    }

    if (!menteeUser || menteeUser.role !== UserRole.MENTEE) {
      throw new BadRequestError('Target user does not have the MENTEE role');
    }

    const existingMapping = await this.mentorMenteeRepo.findActiveByMenteeAndBatch(
      batchId,
      input.menteeId,
    );
    if (existingMapping && existingMapping.mentorId === input.newMentorId) {
      return existingMapping;
    }

    try {
      const oldMentorUser = existingMapping?.mentorId
        ? await this.userRepo.findById(existingMapping.mentorId)
        : null;

      const result = await AppDataSource.transaction(async (manager) => {
        if (existingMapping) {
          await this.mentorMenteeRepo.closeMapping(
            existingMapping.id,
            BatchReasonToLeave.REASSIGNED,
            manager,
            actorId,
          );
        }

        return await this.mentorMenteeRepo.createMapping(
          {
            batchId,
            mentorId: input.newMentorId,
            menteeId: input.menteeId,
          },
          manager,
          actorId,
        );
      });

      // Post-commit reassignment notifications (PRD Section 7.2)
      void this.emailSvc.sendMenteeReassignedEmail({
        to: menteeUser.email,
        recipientName: menteeUser.name,
        recipientRole: MenteeReassignRecipientRole.MENTEE,
        menteeName: menteeUser.name,
        mentorName: newMentorUser.name,
        batchName: batch.name,
        reason: input.reason ?? undefined,
      });

      void this.emailSvc.sendMenteeReassignedEmail({
        to: newMentorUser.email,
        recipientName: newMentorUser.name,
        recipientRole: MenteeReassignRecipientRole.NEW_MENTOR,
        menteeName: menteeUser.name,
        mentorName: newMentorUser.name,
        batchName: batch.name,
        reason: input.reason ?? undefined,
      });

      if (oldMentorUser) {
        void this.emailSvc.sendMenteeReassignedEmail({
          to: oldMentorUser.email,
          recipientName: oldMentorUser.name,
          recipientRole: MenteeReassignRecipientRole.PREVIOUS_MENTOR,
          menteeName: menteeUser.name,
          mentorName: newMentorUser.name,
          batchName: batch.name,
          reason: input.reason ?? undefined,
        });
      }

      await logAudit({
        actorId,
        type: AuditType.MENTOR_MAPPING,
        entity: 'MentorMentee',
        entityId: result.id,
        action: 'REASSIGN_MENTEE',
        oldValue: { mentorId: existingMapping?.mentorId ?? null },
        newValue: {
          batchId,
          mentorId: input.newMentorId,
          menteeId: input.menteeId,
          reason: input.reason ?? null,
        },
      });

      return result;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('Mentee is already actively mapped in this batch');
      }
      throw err;
    }
  }

  public async getBatchMappings(batchId: string) {
    const batch = await this.batchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError('Batch not found');
    }
    return await this.mentorMenteeRepo.findActiveMappingsByBatch(batchId);
  }

  // --- Mentor Scoped Endpoints (Section 2.1) ---

  public async getBatchesForMentor(mentorId: string, params: BatchQueryParams) {
    const { items, total } = await this.batchRepo.findWithFilters(params, mentorId);
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items: items.map((b) => this.sanitizeBatchSummary(b)),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  public async getBatchByIdForMentor(batchId: string, mentorId: string) {
    await this.mentorScope.requireMentorScope(MentorScopeAction.MANAGE_ALLOCATION, {
      mentorId,
      batchId,
    });

    const fullBatch = await this.getBatchById(batchId);

    if (
      fullBatch.batch.status === BatchStatus.ARCHIVED ||
      fullBatch.batch.status === BatchStatus.COMPLETED
    ) {
      throw new ForbiddenError(
        'Operation denied: mentors cannot access archived or completed batches',
      );
    }

    return {
      ...fullBatch,
      mentors: fullBatch.mentors.filter((m) => m.userId === mentorId),
      mentees: fullBatch.mentees.map((m) => ({
        ...m,
        mappedToUser: m.mappedToUser?.id === mentorId ? m.mappedToUser : null,
      })),
    };
  }

  public async getMenteesForMentor(mentorId: string, batchId?: string) {
    if (batchId) {
      await this.mentorScope.requireMentorScope(MentorScopeAction.MANAGE_ALLOCATION, {
        mentorId,
        batchId,
      });
    }

    const mappings = await this.mentorMenteeRepo.findActiveMappingsForMentor(mentorId, batchId);
    return mappings.map((m) => ({
      id: m.id,
      menteeId: m.menteeId,
      name: m.mentee?.name,
      email: m.mentee?.email,
      batchId: m.batchId,
      batchName: m.batch?.name,
      batchCode: m.batch?.code,
      startDate: m.startDate,
    }));
  }

  // --- Mentee Scoped Endpoints ---

  public async getBatchForMentee(menteeId: string) {
    const membership = await this.batchRepo.findActiveMenteeMembership(menteeId);
    if (!membership) {
      return {
        batch: null,
        mentor: null,
      };
    }

    const mapping = await this.mentorMenteeRepo.findActiveByMenteeAndBatch(
      membership.batchId,
      menteeId,
    );

    return {
      batch: membership.batch,
      mentor: mapping?.mentor
        ? {
            id: mapping.mentor.id,
            name: mapping.mentor.name,
            email: mapping.mentor.email,
          }
        : null,
      joinedAt: membership.joinedAt,
    };
  }

  // --- Domain Boundary Delegation (Invoked by UsersService on role lifecycle events) ---

  public async handleUserRoleChange(
    userId: string,
    manager?: EntityManager,
    actorId?: string,
  ): Promise<void> {
    await this.batchRepo.closeActiveMembershipsForUser(
      userId,
      BatchReasonToLeave.ROLE_CHANGE,
      manager,
    );
    await this.mentorMenteeRepo.closeAllActiveMappingsForUser(
      userId,
      BatchReasonToLeave.ROLE_CHANGE,
      manager,
      actorId,
    );
  }

  public async getActiveMappingsForMentor(mentorId: string) {
    return await this.mentorMenteeRepo.findActiveMappingsForMentor(mentorId);
  }
}

export const batchService = new BatchService();
