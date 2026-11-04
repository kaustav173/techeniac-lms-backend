import { AuditRepository, auditRepository, CreateAuditLogData } from './audit.repository';
import { AuditLog } from './entities/audit-log.entity';
import { AuditQueryParams } from './schemas/audit.schemas';

export class AuditService {
  private repository: AuditRepository | null;

  constructor(repository?: AuditRepository) {
    this.repository = repository ?? null;
  }

  private get repo(): AuditRepository {
    if (!this.repository) {
      this.repository = auditRepository;
    }
    return this.repository;
  }

  public async record(data: CreateAuditLogData): Promise<AuditLog> {
    return this.repo.create(data);
  }

  public async getAuditLogs(params: AuditQueryParams) {
    const page = Math.max(1, Number(params?.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(params?.limit) || 10));

    const { items, total } = await this.repo.findWithFilters({
      ...params,
      page,
      limit,
    });
    const totalPages = Math.ceil(total / limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }
}

export const auditService = new AuditService();
