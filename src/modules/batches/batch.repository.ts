import { DataSource, EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';

import { AppDataSource } from '../../core/db';
import {
  Batch,
  BatchMember,
  BatchMemberRole,
  BatchReasonToLeave,
  BatchStatus,
  BatchStatusHistory,
} from './entities';
import { BatchQueryParams } from './schemas/batch.schemas';

export interface CreateBatchData {
  name: string;
  code: string;
  startDate: string;
  endDate: string;
  description?: string | null;
  createdBy: string;
}

export interface UpdateBatchData {
  name?: string;
  startDate?: string;
  endDate?: string;
  description?: string | null;
}

export interface BatchWithCounts extends Batch {
  mentorsCount: number;
  menteesCount: number;
}

export class BatchRepository {
  private get batchRepo(): Repository<Batch> {
    return this.dataSource.getRepository(Batch);
  }

  private get memberRepo(): Repository<BatchMember> {
    return this.dataSource.getRepository(BatchMember);
  }

  private get historyRepo(): Repository<BatchStatusHistory> {
    return this.dataSource.getRepository(BatchStatusHistory);
  }

  constructor(private readonly dataSource: DataSource = AppDataSource) {}

  private getBatchRepo(manager?: EntityManager): Repository<Batch> {
    return manager ? manager.getRepository(Batch) : this.batchRepo;
  }

  private getMemberRepo(manager?: EntityManager): Repository<BatchMember> {
    return manager ? manager.getRepository(BatchMember) : this.memberRepo;
  }

  private getHistoryRepo(manager?: EntityManager): Repository<BatchStatusHistory> {
    return manager ? manager.getRepository(BatchStatusHistory) : this.historyRepo;
  }

  public async findById(id: string, manager?: EntityManager): Promise<Batch | null> {
    return this.getBatchRepo(manager).findOne({
      where: { id },
      relations: {
        creator: true,
      },
    });
  }

  public async findByCode(code: string, manager?: EntityManager): Promise<Batch | null> {
    return this.getBatchRepo(manager).findOne({
      where: { code: code.trim().toUpperCase() },
    });
  }

  public async findActiveByName(
    name: string,
    excludeId?: string,
    manager?: EntityManager,
  ): Promise<Batch | null> {
    const qb = this.getBatchRepo(manager)
      .createQueryBuilder('batch')
      .where('LOWER(batch.name) = LOWER(:name)', { name: name.trim() })
      .andWhere('batch.status <> :archivedStatus', { archivedStatus: BatchStatus.ARCHIVED });

    if (excludeId) {
      qb.andWhere('batch.id <> :excludeId', { excludeId });
    }

    return qb.getOne();
  }

  public async create(
    data: CreateBatchData,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<Batch> {
    const repo = this.getBatchRepo(manager);
    const batch = repo.create({
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      startDate: data.startDate,
      endDate: data.endDate,
      description: data.description?.trim() ?? null,
      status: BatchStatus.DRAFT,
      createdBy: data.createdBy,
      updatedBy: actorId ?? data.createdBy,
    });
    return repo.save(batch);
  }

  public async update(
    id: string,
    data: UpdateBatchData,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<Batch> {
    const repo = this.getBatchRepo(manager);
    const updatePayload: Partial<Batch> = {};
    if (data.name !== undefined) updatePayload.name = data.name.trim();
    if (data.startDate !== undefined) updatePayload.startDate = data.startDate;
    if (data.endDate !== undefined) updatePayload.endDate = data.endDate;
    if (data.description !== undefined) {
      updatePayload.description = data.description?.trim() ?? null;
    }
    if (actorId !== undefined) {
      updatePayload.updatedBy = actorId;
    }

    await repo.update(id, updatePayload);
    const updated = await this.findById(id, manager);
    if (!updated) {
      throw new Error('Batch not found after update');
    }
    return updated;
  }

  public async updateStatus(
    id: string,
    toStatus: BatchStatus,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<Batch> {
    const repo = this.getBatchRepo(manager);
    const updatePayload: Partial<Batch> = { status: toStatus };
    if (actorId !== undefined) {
      updatePayload.updatedBy = actorId;
    }
    await repo.update(id, updatePayload);
    const updated = await this.findById(id, manager);
    if (!updated) {
      throw new Error('Batch not found after status update');
    }
    return updated;
  }

  public async findWithFilters(
    params: BatchQueryParams,
    mentorId?: string,
  ): Promise<{
    items: BatchWithCounts[];
    total: number;
  }> {
    const qb: SelectQueryBuilder<Batch> = this.batchRepo
      .createQueryBuilder('batch')
      .leftJoinAndSelect('batch.creator', 'creator')
      .loadRelationCountAndMap('batch.mentorsCount', 'batch.members', 'mentor', (subQb) =>
        subQb.where('mentor.member_role = :mentorRole AND mentor.is_active = true', {
          mentorRole: BatchMemberRole.MENTOR,
        }),
      )
      .loadRelationCountAndMap('batch.menteesCount', 'batch.members', 'mentee', (subQb) =>
        subQb.where('mentee.member_role = :menteeRole AND mentee.is_active = true', {
          menteeRole: BatchMemberRole.MENTEE,
        }),
      );

    if (mentorId) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM batch_members bm
          WHERE bm.batch_id = batch.id
            AND bm.user_id = :mentorId
            AND bm.member_role = :mentorRole
            AND bm.is_active = true
            AND bm.deleted_at IS NULL
        )`,
        { mentorId, mentorRole: BatchMemberRole.MENTOR },
      );
    }

    if (params.status && params.status.length > 0) {
      qb.andWhere('batch.status IN (:...statuses)', { statuses: params.status });
    }

    if (params.search) {
      const search = `%${params.search.trim()}%`;
      qb.andWhere('(batch.name ILIKE :search OR batch.code ILIKE :search)', { search });
    }

    const page = params.page ?? 1;
    const limit = params.limit ?? 10;

    const safeSortOrder = (params.sortOrder || 'desc').toUpperCase() as 'ASC' | 'DESC';

    if (params.sortBy === 'name') {
      qb.orderBy('LOWER(batch.name)', safeSortOrder, 'NULLS LAST');
    } else if (params.sortBy === 'members') {
      qb.orderBy(
        `(SELECT COUNT(bm.id) FROM batch_members bm WHERE bm.batch_id = batch.id AND bm.is_active = true AND bm.deleted_at IS NULL)`,
        safeSortOrder,
        'NULLS LAST',
      );
    } else if (params.sortBy === 'code') {
      qb.orderBy('LOWER(batch.code)', safeSortOrder, 'NULLS LAST');
    } else if (params.sortBy === 'status') {
      qb.orderBy('batch.status', safeSortOrder, 'NULLS LAST');
    } else if (params.sortBy === 'startDate') {
      qb.orderBy('batch.startDate', safeSortOrder, 'NULLS LAST');
    } else if (params.sortBy === 'endDate') {
      qb.orderBy('batch.endDate', safeSortOrder, 'NULLS LAST');
    } else {
      qb.orderBy('batch.createdAt', safeSortOrder, 'NULLS LAST');
    }

    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();

    const itemsWithCounts: BatchWithCounts[] = items.map((b) => ({
      ...b,
      mentorsCount: (b as unknown as { mentorsCount?: number }).mentorsCount ?? 0,
      menteesCount: (b as unknown as { menteesCount?: number }).menteesCount ?? 0,
    }));

    return { items: itemsWithCounts, total };
  }

  // --- Status History ---
  public async recordStatusHistory(
    batchId: string,
    fromStatus: BatchStatus | null,
    toStatus: BatchStatus,
    changedBy: string,
    reason?: string | null,
    manager?: EntityManager,
  ): Promise<BatchStatusHistory> {
    const repo = this.getHistoryRepo(manager);
    const history = repo.create({
      batchId,
      fromStatus,
      toStatus,
      changedBy,
      reason: reason?.trim() ?? null,
      createdBy: changedBy,
      updatedBy: changedBy,
    });
    return repo.save(history);
  }

  public async getStatusHistory(
    batchId: string,
    manager?: EntityManager,
  ): Promise<BatchStatusHistory[]> {
    return this.getHistoryRepo(manager).find({
      where: { batchId },
      relations: { changer: true },
      order: { changedAt: 'ASC' },
    });
  }

  // --- Batch Members ---
  public async findActiveMenteeMembership(
    userId: string,
    manager?: EntityManager,
  ): Promise<BatchMember | null> {
    return this.getMemberRepo(manager).findOne({
      where: {
        userId,
        memberRole: BatchMemberRole.MENTEE,
        isActive: true,
      },
      relations: {
        batch: true,
      },
    });
  }

  public async findActiveMemberInBatch(
    batchId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<BatchMember | null> {
    return this.getMemberRepo(manager).findOne({
      where: {
        batchId,
        userId,
        isActive: true,
      },
      relations: {
        user: true,
      },
    });
  }

  public async findMemberInBatch(
    batchId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<BatchMember | null> {
    return this.getMemberRepo(manager).findOne({
      where: {
        batchId,
        userId,
      },
      relations: {
        user: true,
      },
    });
  }

  public async findMembersByBatchId(
    batchId: string,
    manager?: EntityManager,
  ): Promise<BatchMember[]> {
    return this.getMemberRepo(manager).find({
      where: {
        batchId,
        isActive: true,
      },
      relations: {
        user: true,
      },
      order: {
        joinedAt: 'ASC',
      },
    });
  }

  public async addMember(
    batchId: string,
    userId: string,
    memberRole: BatchMemberRole,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<BatchMember> {
    const repo = this.getMemberRepo(manager);
    const member = repo.create({
      batchId,
      userId,
      memberRole,
      isActive: true,
      joinedAt: new Date(),
      createdBy: actorId ?? null,
      updatedBy: actorId ?? null,
    });
    return repo.save(member);
  }

  public async removeMember(
    membershipId: string,
    reason: BatchReasonToLeave = BatchReasonToLeave.REMOVED,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = this.getMemberRepo(manager);
    await repo.update(membershipId, {
      isActive: false,
      leftAt: new Date(),
      reasonToLeave: reason,
      updatedBy: actorId ?? null,
    });
  }

  public async countActiveMentors(batchId: string, manager?: EntityManager): Promise<number> {
    return this.getMemberRepo(manager).count({
      where: {
        batchId,
        memberRole: BatchMemberRole.MENTOR,
        isActive: true,
      },
    });
  }

  public async closeoutActiveMentees(
    batchId: string,
    actorId?: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = this.getMemberRepo(manager);
    const activeMentees = await repo.find({
      where: {
        batchId,
        memberRole: BatchMemberRole.MENTEE,
        isActive: true,
      },
    });

    if (activeMentees.length > 0) {
      const now = new Date();
      await repo.update(
        { id: In(activeMentees.map((m) => m.id)) },
        {
          isActive: false,
          leftAt: now,
          reasonToLeave: BatchReasonToLeave.BATCH_COMPLETED,
          updatedBy: actorId ?? null,
        },
      );
    }
  }

  public async closeActiveMembershipsForUser(
    userId: string,
    reason: BatchReasonToLeave = BatchReasonToLeave.ROLE_CHANGE,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(BatchMember) : this.memberRepo;
    await repo.update(
      { userId, isActive: true },
      {
        isActive: false,
        leftAt: new Date(),
        reasonToLeave: reason,
      },
    );
  }
}

export const batchRepository = new BatchRepository();
