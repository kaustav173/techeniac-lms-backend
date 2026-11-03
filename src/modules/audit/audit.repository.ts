import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { AuditAction, AuditLogType } from './entities/audit.enums';
import { AuditLog } from './entities/audit-log.entity';
import { AuditQueryParams } from './schemas/audit.schemas';

export interface CreateAuditLogData {
  actorId?: string | null;
  type: AuditLogType;
  entity: string;
  entityId?: string | null;
  action: AuditAction | string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  ipAddress?: string | null;
  country?: string | null;
}

export class AuditRepository {
  private readonly repo: Repository<AuditLog>;

  constructor(dataSource: DataSource = AppDataSource) {
    this.repo = dataSource.getRepository(AuditLog);
  }

  public async create(data: CreateAuditLogData): Promise<AuditLog> {
    const log = this.repo.create({
      actorId: data.actorId ?? null,
      type: data.type,
      entity: data.entity,
      entityId: data.entityId ?? null,
      action: data.action,
      oldValue: data.oldValue ?? null,
      newValue: data.newValue ?? null,
      ipAddress: data.ipAddress ?? null,
      country: data.country ?? null,
    });
    return this.repo.save(log);
  }

  public async findWithFilters(
    params: AuditQueryParams,
  ): Promise<{ items: AuditLog[]; total: number }> {
    const qb: SelectQueryBuilder<AuditLog> = this.repo
      .createQueryBuilder('audit')
      .leftJoin('audit.actor', 'actor')
      .addSelect(['actor.id', 'actor.name', 'actor.email']);

    if (params.type) {
      qb.andWhere('audit.type = :type', { type: params.type });
    }

    if (params.actorId) {
      qb.andWhere('audit.actorId = :actorId', { actorId: params.actorId });
    }

    if (params.entity) {
      qb.andWhere('audit.entity ILIKE :entity', { entity: `%${params.entity}%` });
    }

    if (params.action) {
      qb.andWhere('audit.action ILIKE :action', { action: `%${params.action}%` });
    }

    if (params.startDate) {
      qb.andWhere('audit.createdAt >= :startDate', { startDate: new Date(params.startDate) });
    }

    if (params.endDate) {
      const end = new Date(params.endDate);
      // If end date is only YYYY-MM-DD or midnight, extend to end-of-day
      if (params.endDate.length <= 10) {
        end.setUTCHours(23, 59, 59, 999);
      }
      qb.andWhere('audit.createdAt <= :endDate', { endDate: end });
    }

    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));

    qb.orderBy('audit.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}

export const auditRepository = new AuditRepository();
