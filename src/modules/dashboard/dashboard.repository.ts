import { DataSource, In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { AssignmentDueOverride, CourseAllocation, CourseAllocationStatus } from '../allocations';
import { Batch, BatchMember, BatchMemberRole, BatchStatus, MentorMentee } from '../batches';
import { Assignment, Course } from '../courses';
import { Submission, SubmissionStatus } from '../submissions';
import { User, UserRole } from '../users';
import type {
  AdminDashboardResponse,
  LatestSubmissionItem,
  MenteeRecentSubmissionItem,
  MenteeUpcomingDeadlineItem,
} from './schemas/dashboard.schemas';

export class DashboardRepository {
  private readonly dataSource: DataSource;

  constructor(dataSource: DataSource = AppDataSource) {
    this.dataSource = dataSource;
  }

  private get userRepo(): Repository<User> {
    return this.dataSource.getRepository(User);
  }

  private get batchRepo(): Repository<Batch> {
    return this.dataSource.getRepository(Batch);
  }

  private get batchMemberRepo(): Repository<BatchMember> {
    return this.dataSource.getRepository(BatchMember);
  }

  private get mentorMenteeRepo(): Repository<MentorMentee> {
    return this.dataSource.getRepository(MentorMentee);
  }

  private get courseRepo(): Repository<Course> {
    return this.dataSource.getRepository(Course);
  }

  private get assignmentRepo(): Repository<Assignment> {
    return this.dataSource.getRepository(Assignment);
  }

  private get allocationRepo(): Repository<CourseAllocation> {
    return this.dataSource.getRepository(CourseAllocation);
  }

  private get submissionRepo(): Repository<Submission> {
    return this.dataSource.getRepository(Submission);
  }

  private get overrideRepo(): Repository<AssignmentDueOverride> {
    return this.dataSource.getRepository(AssignmentDueOverride);
  }

  public async getAdminMetrics(): Promise<AdminDashboardResponse> {
    const [
      usersByRole,
      batchesByStatus,
      totalCourses,
      publishedCourses,
      allocationsByStatus,
      submissionsByStatus,
    ] = await Promise.all([
      this.userRepo
        .createQueryBuilder('u')
        .select('u.role', 'role')
        .addSelect('COUNT(*)', 'count')
        .where('u.deletedAt IS NULL')
        .andWhere('u.isActive = true')
        .groupBy('u.role')
        .getRawMany<{ role: string; count: string }>(),

      this.batchRepo
        .createQueryBuilder('b')
        .select('b.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('b.deletedAt IS NULL')
        .groupBy('b.status')
        .getRawMany<{ status: string; count: string }>(),

      this.courseRepo.count({ where: { deletedAt: IsNull() } }),
      this.courseRepo.count({ where: { deletedAt: IsNull(), isActive: true } }),

      this.allocationRepo
        .createQueryBuilder('ca')
        .select('ca.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('ca.deletedAt IS NULL')
        .groupBy('ca.status')
        .getRawMany<{ status: string; count: string }>(),

      this.submissionRepo
        .createQueryBuilder('s')
        .select('s.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('s.deletedAt IS NULL')
        .groupBy('s.status')
        .getRawMany<{ status: string; count: string }>(),
    ]);

    const roleMap = new Map(usersByRole.map((r) => [r.role, Number(r.count)]));
    const batchMap = new Map(batchesByStatus.map((b) => [b.status, Number(b.count)]));
    const allocMap = new Map(allocationsByStatus.map((a) => [a.status, Number(a.count)]));
    const subMap = new Map(submissionsByStatus.map((s) => [s.status, Number(s.count)]));

    const menteesCount = roleMap.get(UserRole.MENTEE) ?? 0;
    const mentorsCount = roleMap.get(UserRole.MENTOR) ?? 0;
    const adminsCount = roleMap.get(UserRole.SUPER_ADMIN) ?? 0;
    const totalUsers = menteesCount + mentorsCount + adminsCount;

    const liveBatches = batchMap.get(BatchStatus.LIVE) ?? 0;
    const draftBatches = batchMap.get(BatchStatus.DRAFT) ?? 0;
    const completedBatches = batchMap.get(BatchStatus.COMPLETED) ?? 0;
    const onHoldBatches = batchMap.get(BatchStatus.ON_HOLD) ?? 0;
    const archivedBatches = batchMap.get(BatchStatus.ARCHIVED) ?? 0;
    const totalBatches =
      liveBatches + draftBatches + completedBatches + onHoldBatches + archivedBatches;

    const activeAllocations =
      (allocMap.get(CourseAllocationStatus.ASSIGNED) ?? 0) +
      (allocMap.get(CourseAllocationStatus.IN_PROGRESS) ?? 0);
    const completedAllocations = allocMap.get(CourseAllocationStatus.COMPLETED) ?? 0;

    const pendingReviewCount = subMap.get(SubmissionStatus.SUBMITTED) ?? 0;
    const gradedCount = subMap.get(SubmissionStatus.GRADED) ?? 0;
    const resubmitRequestedCount = subMap.get(SubmissionStatus.RESUBMIT_REQUESTED) ?? 0;

    return {
      users: {
        totalUsers,
        menteesCount,
        mentorsCount,
        adminsCount,
      },
      batches: {
        totalBatches,
        liveBatches,
        draftBatches,
        completedBatches,
        onHoldBatches,
        archivedBatches,
      },
      courses: {
        totalCourses,
        publishedCourses,
      },
      allocations: {
        activeAllocations,
        completedAllocations,
      },
      submissions: {
        pendingReviewCount,
        gradedCount,
        resubmitRequestedCount,
      },
    };
  }

  public async getMentorAssignedBatchesCount(mentorId: string): Promise<number> {
    const raw = await this.batchMemberRepo
      .createQueryBuilder('bm')
      .innerJoin(
        Batch,
        'b',
        'b.id = bm.batch_id AND b.deleted_at IS NULL AND b.status NOT IN (:...terminalStatuses)',
        { terminalStatuses: [BatchStatus.COMPLETED, BatchStatus.ARCHIVED] },
      )
      .where('bm.userId = :mentorId', { mentorId })
      .andWhere('bm.memberRole = :role', { role: BatchMemberRole.MENTOR })
      .andWhere('bm.isActive = true')
      .andWhere('bm.deletedAt IS NULL')
      .select('COUNT(DISTINCT bm.batchId)', 'count')
      .getRawOne<{ count: string }>();

    return raw ? Number(raw.count) : 0;
  }

  public async getMentorActiveMappings(mentorId: string): Promise<MentorMentee[]> {
    return this.mentorMenteeRepo
      .createQueryBuilder('mm')
      .innerJoin(
        Batch,
        'b',
        'b.id = mm.batch_id AND b.deleted_at IS NULL AND b.status NOT IN (:...terminalStatuses)',
        { terminalStatuses: [BatchStatus.COMPLETED, BatchStatus.ARCHIVED] },
      )
      .where('mm.mentorId = :mentorId', { mentorId })
      .andWhere('mm.isActive = true')
      .andWhere('mm.deletedAt IS NULL')
      .getMany();
  }

  private applyAllowedPairsFilter(
    qb: SelectQueryBuilder<Submission>,
    allowedPairs: Array<{ batchId: string; menteeId: string; startDate?: Date }>,
    paramPrefix: string = 'p',
  ): void {
    const pairClauses = allowedPairs.map((p, idx) => {
      const bKey = `${paramPrefix}_b_${idx}`;
      const mKey = `${paramPrefix}_m_${idx}`;
      qb.setParameter(bKey, p.batchId);
      qb.setParameter(mKey, p.menteeId);

      if (p.startDate) {
        const sKey = `${paramPrefix}_s_${idx}`;
        qb.setParameter(sKey, p.startDate);
        return `(s.batchId = :${bKey} AND ca.userId = :${mKey} AND s.submitted_at >= :${sKey})`;
      }

      return `(s.batchId = :${bKey} AND ca.userId = :${mKey})`;
    });

    qb.andWhere(`(${pairClauses.join(' OR ')})`);
  }

  public async getMentorSubmissionsStats(
    allowedPairs: Array<{ batchId: string; menteeId: string; startDate?: Date }>,
  ): Promise<{ pendingReviewCount: number; gradedCount: number }> {
    if (allowedPairs.length === 0) {
      return { pendingReviewCount: 0, gradedCount: 0 };
    }

    const qb = this.submissionRepo
      .createQueryBuilder('s')
      .innerJoin(CourseAllocation, 'ca', 'ca.id = s.course_allocation_id AND ca.deleted_at IS NULL')
      .select('s.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('s.deletedAt IS NULL')
      .andWhere('s.batchId IS NOT NULL');

    this.applyAllowedPairsFilter(qb, allowedPairs, 'ms');
    qb.groupBy('s.status');

    const results = await qb.getRawMany<{ status: string; count: string }>();
    const map = new Map(results.map((r) => [r.status, Number(r.count)]));

    return {
      pendingReviewCount: map.get(SubmissionStatus.SUBMITTED) ?? 0,
      gradedCount: map.get(SubmissionStatus.GRADED) ?? 0,
    };
  }

  public async getMentorLatestSubmissions(
    allowedPairs: Array<{ batchId: string; menteeId: string; startDate?: Date }>,
    limit: number = 10,
  ): Promise<LatestSubmissionItem[]> {
    if (allowedPairs.length === 0) {
      return [];
    }

    const qb = this.submissionRepo
      .createQueryBuilder('s')
      .innerJoin(CourseAllocation, 'ca', 'ca.id = s.course_allocation_id AND ca.deleted_at IS NULL')
      .innerJoin(Assignment, 'a', 'a.id = s.assignment_id AND a.deleted_at IS NULL')
      .innerJoin(Course, 'c', 'c.id = ca.course_id AND c.deleted_at IS NULL')
      .innerJoin(User, 'u', 'u.id = ca.user_id AND u.deleted_at IS NULL')
      .leftJoin(Batch, 'b', 'b.id = s.batch_id AND b.deleted_at IS NULL')
      .select([
        's.id AS "id"',
        's.assignment_id AS "assignmentId"',
        'a.title AS "assignmentTitle"',
        'ca.course_id AS "courseId"',
        'c.title AS "courseName"',
        'ca.user_id AS "menteeId"',
        'u.name AS "menteeName"',
        'u.email AS "menteeEmail"',
        's.batch_id AS "batchId"',
        'b.name AS "batchName"',
        's.version AS "version"',
        's.status AS "status"',
        's.is_late AS "isLate"',
        's.submitted_at AS "submittedAt"',
      ])
      .where('s.deletedAt IS NULL')
      .andWhere('s.batchId IS NOT NULL');

    this.applyAllowedPairsFilter(qb, allowedPairs, 'ls');
    qb.orderBy('s.submitted_at', 'DESC');
    qb.limit(limit);

    const rows = await qb.getRawMany<{
      id: string;
      assignmentId: string;
      assignmentTitle: string;
      courseId: string;
      courseName: string;
      menteeId: string;
      menteeName: string;
      menteeEmail: string;
      batchId: string | null;
      batchName: string | null;
      version: number;
      status: string;
      isLate: boolean;
      submittedAt: Date;
    }>();

    return rows.map((r) => ({
      id: r.id,
      assignmentId: r.assignmentId,
      assignmentTitle: r.assignmentTitle,
      courseId: r.courseId,
      courseName: r.courseName,
      menteeId: r.menteeId,
      menteeName: r.menteeName,
      menteeEmail: r.menteeEmail,
      batchId: r.batchId,
      batchName: r.batchName,
      version: Number(r.version),
      status: r.status,
      isLate: Boolean(r.isLate),
      submittedAt: new Date(r.submittedAt).toISOString(),
    }));
  }

  public async getMenteeAllocationsSummary(menteeId: string): Promise<{
    activeCoursesCount: number;
    completedCoursesCount: number;
    overallProgressPercent: number;
  }> {
    const allocations = await this.allocationRepo
      .createQueryBuilder('ca')
      .innerJoin(Course, 'c', 'c.id = ca.course_id AND c.deleted_at IS NULL AND c.is_active = true')
      .where('ca.userId = :menteeId', { menteeId })
      .andWhere('ca.deletedAt IS NULL')
      .getMany();

    const activeAllocations = allocations.filter(
      (a) =>
        a.status === CourseAllocationStatus.ASSIGNED ||
        a.status === CourseAllocationStatus.IN_PROGRESS,
    );
    const completedAllocations = allocations.filter(
      (a) => a.status === CourseAllocationStatus.COMPLETED,
    );

    let overallProgressPercent = 0;
    if (activeAllocations.length > 0) {
      const sum = activeAllocations.reduce((acc, a) => acc + Number(a.progressPercent || 0), 0);
      overallProgressPercent = Math.round((sum / activeAllocations.length) * 10) / 10;
    }

    return {
      activeCoursesCount: activeAllocations.length,
      completedCoursesCount: completedAllocations.length,
      overallProgressPercent,
    };
  }

  public async getMenteePendingAssignmentsCount(menteeId: string): Promise<number> {
    const allocations = await this.allocationRepo
      .createQueryBuilder('ca')
      .innerJoin(Course, 'c', 'c.id = ca.course_id AND c.deleted_at IS NULL AND c.is_active = true')
      .leftJoin(Batch, 'b', 'b.id = ca.batch_id AND b.deleted_at IS NULL')
      .where('ca.userId = :menteeId', { menteeId })
      .andWhere('ca.deletedAt IS NULL')
      .andWhere('ca.status IN (:...statuses)', {
        statuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .andWhere('(ca.batch_id IS NULL OR b.status NOT IN (:...terminalStatuses))', {
        terminalStatuses: [BatchStatus.ON_HOLD, BatchStatus.COMPLETED, BatchStatus.ARCHIVED],
      })
      .select(['ca.id AS "allocationId"', 'ca.course_id AS "courseId"', 'ca.due_date AS "dueDate"'])
      .getRawMany<{
        allocationId: string;
        courseId: string;
        dueDate: Date;
      }>();

    if (allocations.length === 0) {
      return 0;
    }

    const courseIds = [...new Set(allocations.map((a) => a.courseId))];
    const assignments = await this.assignmentRepo.find({
      where: {
        courseId: In(courseIds),
        deletedAt: IsNull(),
      },
      select: ['id', 'courseId'],
    });

    if (assignments.length === 0) {
      return 0;
    }

    const allocationIds = allocations.map((a) => a.allocationId);
    const assignmentIds = assignments.map((a) => a.id);

    const [submissions, overrides] = await Promise.all([
      this.submissionRepo.find({
        where: {
          courseAllocationId: In(allocationIds),
          assignmentId: In(assignmentIds),
          deletedAt: IsNull(),
        },
        order: { version: 'DESC' },
      }),
      this.overrideRepo.find({
        where: {
          courseAllocationId: In(allocationIds),
          assignmentId: In(assignmentIds),
          deletedAt: IsNull(),
        },
      }),
    ]);

    const latestSubmissionMap = new Map<string, Submission>();
    for (const sub of submissions) {
      const key = `${sub.courseAllocationId}:${sub.assignmentId}`;
      if (!latestSubmissionMap.has(key)) {
        latestSubmissionMap.set(key, sub);
      }
    }

    const overrideMap = new Map<string, Date>();
    for (const override of overrides) {
      const key = `${override.courseAllocationId}:${override.assignmentId}`;
      overrideMap.set(key, override.dueDate);
    }

    const now = new Date();
    let pendingCount = 0;

    for (const alloc of allocations) {
      const allocAssignments = assignments.filter((a) => a.courseId === alloc.courseId);
      for (const assignment of allocAssignments) {
        const key = `${alloc.allocationId}:${assignment.id}`;
        const latestSub = latestSubmissionMap.get(key);

        if (latestSub) {
          if (latestSub.status === SubmissionStatus.RESUBMIT_REQUESTED) {
            pendingCount++;
          }
        } else {
          const overrideDueDate = overrideMap.get(key);
          const effectiveDueDate = overrideDueDate ?? alloc.dueDate;
          if (new Date(effectiveDueDate) >= now) {
            pendingCount++;
          }
        }
      }
    }

    return pendingCount;
  }

  public async getMenteeRecentSubmissions(
    menteeId: string,
    limit: number = 5,
  ): Promise<MenteeRecentSubmissionItem[]> {
    const rows = await this.submissionRepo
      .createQueryBuilder('s')
      .innerJoin(CourseAllocation, 'ca', 'ca.id = s.course_allocation_id AND ca.deleted_at IS NULL')
      .innerJoin(Assignment, 'a', 'a.id = s.assignment_id AND a.deleted_at IS NULL')
      .innerJoin(Course, 'c', 'c.id = ca.course_id AND c.deleted_at IS NULL')
      .select([
        's.id AS "id"',
        's.assignment_id AS "assignmentId"',
        'a.title AS "assignmentTitle"',
        'c.title AS "courseName"',
        's.status AS "status"',
        's.marks AS "marks"',
        's.grade_label AS "gradeLabel"',
        's.is_late AS "isLate"',
        's.submitted_at AS "submittedAt"',
      ])
      .where('ca.userId = :menteeId', { menteeId })
      .andWhere('s.deletedAt IS NULL')
      .orderBy('s.submitted_at', 'DESC')
      .limit(limit)
      .getRawMany<{
        id: string;
        assignmentId: string;
        assignmentTitle: string;
        courseName: string;
        status: string;
        marks: string | number | null;
        gradeLabel: string | null;
        isLate: boolean;
        submittedAt: Date;
      }>();

    return rows.map((r) => ({
      id: r.id,
      assignmentId: r.assignmentId,
      assignmentTitle: r.assignmentTitle,
      courseName: r.courseName,
      status: r.status,
      marks: r.marks !== null && r.marks !== undefined ? Number(r.marks) : null,
      gradeLabel: r.gradeLabel,
      isLate: Boolean(r.isLate),
      submittedAt: new Date(r.submittedAt).toISOString(),
    }));
  }

  public async getMenteeUpcomingDeadlines(
    menteeId: string,
    limit: number = 5,
  ): Promise<Array<Omit<MenteeUpcomingDeadlineItem, 'isOverdue'>>> {
    const now = new Date();
    const allocations = await this.allocationRepo
      .createQueryBuilder('ca')
      .innerJoinAndSelect('ca.course', 'c', 'c.deleted_at IS NULL AND c.is_active = true')
      .where('ca.userId = :menteeId', { menteeId })
      .andWhere('ca.deletedAt IS NULL')
      .andWhere('ca.status IN (:...statuses)', {
        statuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      })
      .andWhere('ca.dueDate >= :now', { now })
      .orderBy('ca.dueDate', 'ASC')
      .take(limit)
      .getMany();

    return allocations.map((a) => ({
      allocationId: a.id,
      courseName: a.course?.title ?? 'Assigned Course',
      dueDate: new Date(a.dueDate).toISOString(),
      progressPercent: Number(a.progressPercent || 0),
    }));
  }
}

export const dashboardRepository = new DashboardRepository();
