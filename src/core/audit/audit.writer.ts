/**
 * Audit Writer re-export for backward-compatibility with core consumers.
 * Canonical implementation resides in src/modules/audit/audit.writer.ts.
 */
export { logAudit, type LogAuditParams } from '../../modules/audit/audit.writer';
export { AuditType } from '../../modules/audit/entities/audit.enums';
