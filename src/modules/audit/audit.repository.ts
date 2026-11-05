import { Brackets, DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { CourseAllocation } from '../allocations';
import { Batch } from '../batches';
import { Assignment, Course } from '../courses';
import { Submission } from '../submissions';
import { User } from '../users';
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

export interface TargetEntitiesBatchResult {
  allocations: Map<string, { courseTitle?: string; userName?: string }>;
  submissions: Map<
    string,
    {
      assignmentTitle?: string;
      studentName?: string;
      studentEmail?: string;
      gradeLabel?: string;
    }
  >;
  courses: Map<string, string>;
  users: Map<string, { name: string; email: string }>;
  batches: Map<string, string>;
  assignments: Map<string, string>;
}

export class AuditRepository {
  private readonly repo: Repository<AuditLog>;

  constructor(private readonly dataSource: DataSource = AppDataSource) {
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

  public async findTargetEntitiesBatch(params: {
    allocationIds: string[];
    submissionIds: string[];
    courseIds: string[];
    userIds: string[];
    batchIds: string[];
    assignmentIds: string[];
  }): Promise<TargetEntitiesBatchResult> {
    const result: TargetEntitiesBatchResult = {
      allocations: new Map(),
      submissions: new Map(),
      courses: new Map(),
      users: new Map(),
      batches: new Map(),
      assignments: new Map(),
    };

    if (params.allocationIds.length > 0) {
      try {
        const allocations = await this.dataSource.getRepository(CourseAllocation).find({
          where: { id: In(params.allocationIds) },
          relations: ['course', 'user'],
        });
        for (const a of allocations) {
          result.allocations.set(a.id, {
            courseTitle: a.course?.title,
            userName: a.user?.name,
          });
        }
      } catch {
        // ignore resolution error
      }
    }

    if (params.submissionIds.length > 0) {
      try {
        const submissions = await this.dataSource.getRepository(Submission).find({
          where: { id: In(params.submissionIds) },
          relations: ['assignment', 'courseAllocation', 'courseAllocation.user'],
        });
        for (const s of submissions) {
          result.submissions.set(s.id, {
            assignmentTitle: s.assignment?.title,
            studentName: s.courseAllocation?.user?.name,
            studentEmail: s.courseAllocation?.user?.email,
            gradeLabel: s.gradeLabel ?? undefined,
          });
        }
      } catch {
        // ignore resolution error
      }
    }

    if (params.courseIds.length > 0) {
      try {
        const courses = await this.dataSource.getRepository(Course).find({
          where: { id: In(params.courseIds) },
          select: ['id', 'title'],
        });
        for (const c of courses) {
          result.courses.set(c.id, c.title);
        }
      } catch {
        // ignore resolution error
      }
    }

    if (params.userIds.length > 0) {
      try {
        const users = await this.dataSource.getRepository(User).find({
          where: { id: In(params.userIds) },
          select: ['id', 'name', 'email'],
        });
        for (const u of users) {
          result.users.set(u.id, { name: u.name, email: u.email });
        }
      } catch {
        // ignore resolution error
      }
    }

    if (params.batchIds.length > 0) {
      try {
        const batches = await this.dataSource.getRepository(Batch).find({
          where: { id: In(params.batchIds) },
          select: ['id', 'name'],
        });
        for (const b of batches) {
          result.batches.set(b.id, b.name);
        }
      } catch {
        // ignore resolution error
      }
    }

    if (params.assignmentIds.length > 0) {
      try {
        const assignments = await this.dataSource.getRepository(Assignment).find({
          where: { id: In(params.assignmentIds) },
          select: ['id', 'title'],
        });
        for (const a of assignments) {
          result.assignments.set(a.id, a.title);
        }
      } catch {
        // ignore resolution error
      }
    }

    return result;
  }
}

export const auditRepository = new AuditRepository();
