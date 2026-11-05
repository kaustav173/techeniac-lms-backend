import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { AuditableEntity } from '../../../core/db/auditable.entity';
import { User } from '../../users';
import { AuditAction, AuditLogType, AuditType } from './audit.enums';

export { AuditAction, AuditLogType, AuditType };

/**
 * AuditLog Entity
 *
 * Implements M14 Audit Log per LMS DBML specification.
 * Extends AuditableEntity for standard tracking fields (id, created_at, updated_at, deleted_at, created_by, updated_by).
 * Note: Audit logs are strictly read-only and append-only. updated_at and deleted_at exist
 * for base entity compliance but are never mutated in practice.
 */
@Entity({ name: 'audit_logs' })
@Index('idx_audit_type_time', ['type', 'createdAt'])
@Index('idx_audit_entity', ['entity', 'entityId'])
@Index('idx_audit_actor_time', ['actorId', 'createdAt'])
@Index('idx_audit_time', ['createdAt'])
export class AuditLog extends AuditableEntity {
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id', foreignKeyConstraintName: 'FK_audit_logs_actor_id' })
  actor!: User | null;

  @Column({
    name: 'type',
    type: 'enum',
    enum: AuditLogType,
  })
  type!: AuditLogType;

  @Column({ name: 'entity', type: 'varchar', length: 100 })
  entity!: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId!: string | null;

  @Column({ name: 'action', type: 'varchar', length: 100 })
  action!: string;

  @Column({ name: 'old_value', type: 'jsonb', nullable: true })
  oldValue!: Record<string, unknown> | null;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue!: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'country', type: 'varchar', length: 100, nullable: true })
  country!: string | null;
}
