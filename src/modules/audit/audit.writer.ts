import { getRequestContext } from '../../core/http';
import { logger } from '../../core/logging';
import { auditRepository, type CreateAuditLogData } from './audit.repository';
import { AuditLog } from './entities/audit-log.entity';

export type LogAuditParams = CreateAuditLogData;

/**
 * Persists an audit log entry safely without throwing errors.
 * If database writing fails, logs operational metadata (excluding sensitive payload values/PII)
 * and returns null to ensure callers never crash.
 */
export async function logAudit(params: LogAuditParams): Promise<AuditLog | null> {
  try {
    const ctx = getRequestContext();
    const resolvedData: CreateAuditLogData = {
      ...params,
      ipAddress: params.ipAddress !== undefined ? params.ipAddress : (ctx?.ipAddress ?? null),
      country: params.country !== undefined ? params.country : (ctx?.country ?? null),
    };
    return await auditRepository.create(resolvedData);
  } catch (error) {
    logger.error(
      {
        err: error,
        type: params.type,
        entity: params.entity,
        entityId: params.entityId,
        action: params.action,
        actorId: params.actorId,
      },
      'Failed to record audit log entry',
    );
    return null;
  }
}
