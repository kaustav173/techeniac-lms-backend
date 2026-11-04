import { Brackets, DataSource, Repository, SelectQueryBuilder } from 'typeorm';

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
      .addSelect(['actor.id', 'actor.name', 'actor.email', 'actor.role']);

    const typesToFilter: AuditLogType[] = [];
    if (params.types && Array.isArray(params.types) && params.types.length > 0) {
      typesToFilter.push(...params.types);
    } else if (params.type) {
      typesToFilter.push(params.type);
    }

    if (typesToFilter.length === 1) {
      qb.andWhere('audit.type = :type', { type: typesToFilter[0] });
    } else if (typesToFilter.length > 1) {
      qb.andWhere('audit.type IN (:...types)', { types: typesToFilter });
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

    if (params.search) {
      const searchTerm = `%${params.search}%`;
      qb.andWhere(
        new Brackets((subQb) => {
          subQb
            // 1. Activity (Action)
            .where('audit.action ILIKE :search', { search: searchTerm })
            .orWhere("REPLACE(audit.action, '_', ' ') ILIKE :search", { search: searchTerm })
            // 2. Type
            .orWhere('audit.type::text ILIKE :search', { search: searchTerm })
            .orWhere("REPLACE(audit.type::text, '_', ' ') ILIKE :search", { search: searchTerm })
            // 3. Actor (Name, Email, Role)
            .orWhere('actor.name ILIKE :search', { search: searchTerm })
            .orWhere('actor.email ILIKE :search', { search: searchTerm })
            .orWhere("REPLACE(actor.role::text, '_', ' ') ILIKE :search", { search: searchTerm })
            // 4. Target Entity (Entity name/type and display title)
            .orWhere('audit.entity ILIKE :search', { search: searchTerm })
            .orWhere("REPLACE(audit.entity, '_', ' ') ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'name' ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'title' ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'batchName' ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'courseTitle' ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'assignmentTitle' ILIKE :search", { search: searchTerm })
            .orWhere("audit.new_value ->> 'menteeName' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'name' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'title' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'batchName' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'courseTitle' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'assignmentTitle' ILIKE :search", { search: searchTerm })
            .orWhere("audit.old_value ->> 'menteeName' ILIKE :search", { search: searchTerm });
        }),
      );
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
    const orderDirection = params.sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    qb.orderBy('audit.createdAt', orderDirection)
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}

export const auditRepository = new AuditRepository();
