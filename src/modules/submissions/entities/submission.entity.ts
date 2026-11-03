import { Check, Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { AuditableEntity } from '../../../core/db';
import { CourseAllocation } from '../../allocations';
import { Batch } from '../../batches';
import { Assignment } from '../../courses';
import { User } from '../../users';
import { SubmissionStatus } from './submission.enums';

export { SubmissionStatus };

export interface SubmissionData {
  pdfUrl?: string | null;
  zipUrl?: string | null;
  linkUrl?: string | null;
}

@Entity({ name: 'submissions' })
@Unique('uq_sub_version', ['courseAllocationId', 'assignmentId', 'version'])
@Index('idx_sub_queue', ['batchId', 'submittedAt'])
@Index('idx_sub_status_time', ['status', 'submittedAt'])
@Index('idx_sub_allocation_assignment', ['courseAllocationId', 'assignmentId'])
@Index('idx_sub_grader', ['gradedBy'])
@Index('idx_submissions_perf_metrics', ['status', 'marks', 'isLate'], {
  where: `"deleted_at" IS NULL`,
})
@Index('idx_submissions_active_latest_ver', ['courseAllocationId', 'assignmentId', 'version'], {
  where: `"deleted_at" IS NULL`,
})
@Index('idx_submissions_queue_lookup', ['batchId', 'status', 'submittedAt'], {
  where: `"deleted_at" IS NULL`,
})
@Check('chk_sub_has_data', `submission_data <> '{}'::jsonb`)
@Check('chk_sub_marks', `marks IS NULL OR marks >= 0`)
@Check(
  'chk_sub_graded_fields',
  `status <> 'GRADED' OR (marks IS NOT NULL AND graded_by IS NOT NULL AND graded_at IS NOT NULL)`,
)
export class Submission extends AuditableEntity {
  @Column({ name: 'course_allocation_id', type: 'uuid' })
  courseAllocationId!: string;

  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId!: string;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @Column({ name: 'version', type: 'int', default: 1 })
  version!: number;

  @Column({ name: 'submission_data', type: 'jsonb' })
  submissionData!: SubmissionData;

  @Column({
    name: 'submitted_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  submittedAt!: Date;

  @Column({ name: 'is_late', type: 'boolean', default: false })
  isLate!: boolean;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SubmissionStatus,
    default: SubmissionStatus.SUBMITTED,
  })
  status!: SubmissionStatus;

  // Grade columns (populated by Hetvi's Module 10 per Fixed Decision #27)
  @Column({
    name: 'marks',
    type: 'numeric',
    precision: 8,
    scale: 2,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | number | null) =>
        value !== null && value !== undefined ? Number(value) : null,
    },
  })
  marks!: number | null;

  @Column({ name: 'grade_label', type: 'varchar', length: 50, nullable: true })
  gradeLabel!: string | null;

  @Column({ name: 'feedback', type: 'text', nullable: true })
  feedback!: string | null;

  @Column({ name: 'graded_by', type: 'uuid', nullable: true })
  gradedBy!: string | null;

  @Column({ name: 'graded_at', type: 'timestamptz', nullable: true })
  gradedAt!: Date | null;

  @ManyToOne(() => CourseAllocation, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'course_allocation_id',
    foreignKeyConstraintName: 'FK_submissions_course_allocation',
  })
  courseAllocation?: CourseAllocation;

  @ManyToOne(() => Assignment, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'assignment_id',
    foreignKeyConstraintName: 'FK_submissions_assignment',
  })
  assignment?: Assignment;

  @ManyToOne(() => Batch, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'batch_id',
    foreignKeyConstraintName: 'FK_submissions_batch',
  })
  batch?: Batch | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'graded_by',
    foreignKeyConstraintName: 'FK_submissions_grader',
  })
  grader?: User | null;
}
