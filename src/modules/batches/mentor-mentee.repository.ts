import { DataSource, EntityManager, Repository } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { BatchReasonToLeave } from './entities/batch.enums';
import { MentorMentee } from './entities/mentor-mentee.entity';

export class MentorMenteeRepository {
  private get repo(): Repository<MentorMentee> {
    return this.dataSource.getRepository(MentorMentee);
  }

  constructor(private readonly dataSource: DataSource = AppDataSource) {}

  private getRepo(manager?: EntityManager): Repository<MentorMentee> {
    return manager ? manager.getRepository(MentorMentee) : this.repo;
  }

  public async findActiveByMenteeAndBatch(
    batchId: string,
    menteeId: string,
    manager?: EntityManager,
  ): Promise<MentorMentee | null> {
    return await this.getRepo(manager).findOne({
      where: {
        batchId,
        menteeId,
        isActive: true,
      },
      relations: ['mentor', 'mentee', 'batch'],
    });
  }

  public async createMapping(
    data: { batchId: string; mentorId: string; menteeId: string },
    manager?: EntityManager,
    actorId?: string,
  ): Promise<MentorMentee> {
    const repo = this.getRepo(manager);
    const mapping = repo.create({
      batchId: data.batchId,
      mentorId: data.mentorId,
      menteeId: data.menteeId,
      isActive: true,
      startDate: new Date(),
      createdBy: actorId ?? null,
      updatedBy: actorId ?? null,
    });
    return await repo.save(mapping);
  }

  public async closeMapping(
    mappingId: string,
    endReason: BatchReasonToLeave,
    manager?: EntityManager,
    actorId?: string,
  ): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      isActive: false,
      endDate: new Date(),
      endReason,
    };
    if (actorId) {
      updatePayload.updatedBy = actorId;
    }
    await this.getRepo(manager).update(mappingId, updatePayload);
  }

  public async findActiveMappingsByBatch(
    batchId: string,
    manager?: EntityManager,
  ): Promise<MentorMentee[]> {
    return await this.getRepo(manager).find({
      where: { batchId, isActive: true },
      relations: ['mentor', 'mentee'],
      order: { startDate: 'ASC' },
    });
  }

  public async findAllMappingsByBatch(
    batchId: string,
    manager?: EntityManager,
  ): Promise<MentorMentee[]> {
    return await this.getRepo(manager).find({
      where: { batchId },
      relations: ['mentor', 'mentee'],
      order: { createdAt: 'DESC' },
    });
  }

  public async findActiveMappingsForMentor(
    mentorId: string,
    batchId?: string,
    manager?: EntityManager,
  ): Promise<MentorMentee[]> {
    const query = this.getRepo(manager)
      .createQueryBuilder('mm')
      .innerJoinAndSelect('mm.mentee', 'mentee')
      .innerJoinAndSelect('mm.batch', 'batch')
      .where('mm.mentor_id = :mentorId', { mentorId })
      .andWhere('mm.is_active = true')
      .andWhere('mm.deleted_at IS NULL');

    if (batchId) {
      query.andWhere('mm.batch_id = :batchId', { batchId });
    }

    return await query.orderBy('mm.start_date', 'ASC').getMany();
  }

  public async findActiveMappingForMentee(
    menteeId: string,
    manager?: EntityManager,
  ): Promise<MentorMentee | null> {
    return await this.getRepo(manager).findOne({
      where: { menteeId, isActive: true },
      relations: ['mentor', 'batch'],
    });
  }

  public async closeAllMappingsForBatch(
    batchId: string,
    endReason: BatchReasonToLeave,
    manager?: EntityManager,
    actorId?: string,
  ): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      isActive: false,
      endDate: new Date(),
      endReason,
    };
    if (actorId) {
      updatePayload.updatedBy = actorId;
    }
    await this.getRepo(manager).update({ batchId, isActive: true }, updatePayload);
  }

  public async closeAllMappingsForMember(
    batchId: string,
    userId: string,
    endReason: BatchReasonToLeave,
    manager?: EntityManager,
    actorId?: string,
  ): Promise<void> {
    const repo = this.getRepo(manager);
    const updatePayload: Record<string, unknown> = {
      isActive: false,
      endDate: new Date(),
      endReason,
    };
    if (actorId) {
      updatePayload.updatedBy = actorId;
    }
    await repo
      .createQueryBuilder()
      .update(MentorMentee)
      .set(updatePayload)
      .where('batch_id = :batchId AND is_active = true', { batchId })
      .andWhere('(mentor_id = :userId OR mentee_id = :userId)', { userId })
      .execute();
  }

  public async closeAllActiveMappingsForUser(
    userId: string,
    endReason: BatchReasonToLeave,
    manager?: EntityManager,
    actorId?: string,
  ): Promise<void> {
    const repo = this.getRepo(manager);
    const updatePayload: Record<string, unknown> = {
      isActive: false,
      endDate: new Date(),
      endReason,
    };
    if (actorId) {
      updatePayload.updatedBy = actorId;
    }
    await repo
      .createQueryBuilder()
      .update(MentorMentee)
      .set(updatePayload)
      .where('is_active = true AND (mentor_id = :userId OR mentee_id = :userId)', { userId })
      .execute();
  }
}

export const mentorMenteeRepository = new MentorMenteeRepository();
