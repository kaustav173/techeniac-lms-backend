import { DataSource, Repository } from 'typeorm';

import { AppDataSource } from '../../core/db';
import { CourseAllocation, CourseAllocationStatus } from '../allocations';
import { Batch, MentorMentee } from '../batches';
import { TopicProgress, TopicProgressStatus } from '../progress';
import { Submission, SubmissionStatus } from '../submissions';
import { User, UserRole } from '../users';
import type { PerformanceScopeFilter } from './performance.policy';
import type {
  GradeDistributionBucket,
  LearningHistoryAllocation,
  LearningHistoryAssignment,
  LearningHistoryBatch,
  LearningHistoryResult,
  MenteePerformanceRow,
  PerformanceFilterQuery,
  PerformanceOverviewMetrics,
} from './schemas/performance.schemas';

function normalizeEndDate(dateStr: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(`${dateStr}T23:59:59.999Z`);
  }
  return new Date(dateStr);
}

export class PerformanceRepository {
  private readonly db: DataSource;

  constructor(dataSource: DataSource = AppDataSource) {
    this.db = dataSource;
  }

  private get submissionRepo(): Repository<Submission> {
    return this.db.getRepository(Submission);
  }

  private get allocationRepo(): Repository<CourseAllocation> {
    return this.db.getRepository(CourseAllocation);
  }

  private get topicProgressRepo(): Repository<TopicProgress> {
    return this.db.getRepository(TopicProgress);
  }

  private get userRepo(): Repository<User> {
    return this.db.getRepository(User);
  }

  private get mentorMenteeRepo(): Repository<MentorMentee> {
    return this.db.getRepository(MentorMentee);
  }

  /**
   * Calculates platform/mentor-scoped aggregate performance metrics (FR-11.1, FR-11.2, FR-11.3).
   */
  async getPerformanceOverview(
    filter: PerformanceFilterQuery,
    scope: PerformanceScopeFilter,
  ): Promise<PerformanceOverviewMetrics> {
    // 1. Resolve scoped mentee IDs if restricted by mentor scope or admin mentor filter
    let resolvedMenteeIds = scope.allowedMenteeIds;

    if (scope.isSuperAdmin && filter.mentorId) {
      const mappings = await this.mentorMenteeRepo.find({
        where: { mentorId: filter.mentorId, isActive: true },
        select: ['menteeId'],
      });
      const adminScopedIds = mappings.map((m) => m.menteeId);
      resolvedMenteeIds = resolvedMenteeIds
        ? resolvedMenteeIds.filter((id) => adminScopedIds.includes(id))
        : adminScopedIds;
    }

    // If mentor scope has zero mapped mentees, return empty summary immediately (PER-03)
    if (!scope.isSuperAdmin && (!resolvedMenteeIds || resolvedMenteeIds.length === 0)) {
      return this.getEmptyOverview();
    }

    const targetBatchId = filter.batchId ?? scope.scopedBatchId;

    // 2. Query submission aggregates
    const subQb = this.submissionRepo
      .createQueryBuilder('sub')
      .innerJoin(CourseAllocation, 'alloc', 'alloc.id = sub.course_allocation_id')
      .where('sub.deleted_at IS NULL')
      .andWhere('alloc.deleted_at IS NULL');

    if (targetBatchId) {
      subQb.andWhere('(sub.batch_id = :batchId OR alloc.batch_id = :batchId)', {
        batchId: targetBatchId,
      });
    }

    if (resolvedMenteeIds && resolvedMenteeIds.length > 0) {
      subQb.andWhere('alloc.user_id IN (:...menteeIds)', { menteeIds: resolvedMenteeIds });
    }

    if (filter.courseId) {
      subQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }

    if (filter.startDate) {
      subQb.andWhere('sub.submitted_at >= :startDate', { startDate: new Date(filter.startDate) });
    }

    if (filter.endDate) {
      subQb.andWhere('sub.submitted_at <= :endDate', { endDate: normalizeEndDate(filter.endDate) });
    }

    if (filter.gradeRange && filter.gradeRange !== 'ALL') {
      subQb.andWhere('sub.grade_label = :gradeLabel', { gradeLabel: filter.gradeRange });
    }

    const subStats = await subQb
      .select([
        'COUNT(sub.id) as total_submissions',
        'AVG(CASE WHEN sub.status = :gradedStatus THEN sub.marks ELSE NULL END) as avg_marks',
        'COUNT(CASE WHEN sub.is_late = false THEN 1 ELSE NULL END) as on_time_count',
      ])
      .setParameter('gradedStatus', SubmissionStatus.GRADED)
      .getRawOne<{
        total_submissions: string;
        avg_marks: string | null;
        on_time_count: string;
      }>();

    const totalSubmissions = parseInt(subStats?.total_submissions ?? '0', 10);
    const averageMarks = subStats?.avg_marks
      ? parseFloat(parseFloat(subStats.avg_marks).toFixed(2))
      : null;
    const onTimeCount = parseInt(subStats?.on_time_count ?? '0', 10);
    const onTimeRate =
      totalSubmissions > 0 ? parseFloat(((onTimeCount / totalSubmissions) * 100).toFixed(2)) : null;

    // 3. Query grade distribution
    const gradeRows = await subQb
      .clone()
      .andWhere('sub.status = :gradedStatus', { gradedStatus: SubmissionStatus.GRADED })
      .andWhere('sub.grade_label IS NOT NULL')
      .select(['sub.grade_label as grade', 'COUNT(sub.id) as count'])
      .groupBy('sub.grade_label')
      .getRawMany<{ grade: string; count: string }>();

    const totalGraded = gradeRows.reduce((acc, row) => acc + parseInt(row.count, 10), 0);
    const gradeDistribution: Record<'A+' | 'A' | 'B' | 'C' | 'D' | 'F', GradeDistributionBucket> = {
      'A+': { count: 0, percentage: 0 },
      A: { count: 0, percentage: 0 },
      B: { count: 0, percentage: 0 },
      C: { count: 0, percentage: 0 },
      D: { count: 0, percentage: 0 },
      F: { count: 0, percentage: 0 },
    };

    for (const row of gradeRows) {
      const g = row.grade as keyof typeof gradeDistribution;
      if (gradeDistribution[g] !== undefined) {
        const count = parseInt(row.count, 10);
        gradeDistribution[g] = {
          count,
          percentage: totalGraded > 0 ? parseFloat(((count / totalGraded) * 100).toFixed(2)) : 0,
        };
      }
    }

    // 4. Query course allocation stats (completion %, overdue count, total mentees)
    const allocQb = this.allocationRepo
      .createQueryBuilder('alloc')
      .where('alloc.deleted_at IS NULL');

    if (targetBatchId) {
      allocQb.andWhere('alloc.batch_id = :batchId', { batchId: targetBatchId });
    }

    if (resolvedMenteeIds && resolvedMenteeIds.length > 0) {
      allocQb.andWhere('alloc.user_id IN (:...menteeIds)', { menteeIds: resolvedMenteeIds });
    }

    if (filter.courseId) {
      allocQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }

    if (filter.status) {
      allocQb.andWhere('alloc.status = :status', { status: filter.status });
    }

    const allocStats = await allocQb
      .select([
        'COUNT(DISTINCT alloc.user_id) as total_mentees',
        'AVG(alloc.progress_percent) as avg_progress',
        `COUNT(CASE WHEN alloc.due_date < NOW() AND alloc.status IN (:...openStatuses) THEN 1 ELSE NULL END) as overdue_allocations`,
      ])
      .setParameter('openStatuses', [
        CourseAllocationStatus.ASSIGNED,
        CourseAllocationStatus.IN_PROGRESS,
      ])
      .getRawOne<{
        total_mentees: string;
        avg_progress: string | null;
        overdue_allocations: string;
      }>();

    const totalMentees = parseInt(allocStats?.total_mentees ?? '0', 10);
    const completionPercentage = allocStats?.avg_progress
      ? parseFloat(parseFloat(allocStats.avg_progress).toFixed(2))
      : 0;
    const overdueAllocations = parseInt(allocStats?.overdue_allocations ?? '0', 10);

    // 5. Query overdue topic progress (PER-13)
    const tpQb = this.topicProgressRepo
      .createQueryBuilder('tp')
      .innerJoin(CourseAllocation, 'alloc', 'alloc.id = tp.course_allocation_id')
      .where('tp.deleted_at IS NULL')
      .andWhere('alloc.deleted_at IS NULL')
      .andWhere('tp.status != :completedStatus', { completedStatus: TopicProgressStatus.COMPLETED })
      .andWhere('tp.deadline IS NOT NULL AND tp.deadline < NOW()');

    if (targetBatchId) {
      tpQb.andWhere('alloc.batch_id = :batchId', { batchId: targetBatchId });
    }
    if (resolvedMenteeIds && resolvedMenteeIds.length > 0) {
      tpQb.andWhere('alloc.user_id IN (:...menteeIds)', { menteeIds: resolvedMenteeIds });
    }
    if (filter.courseId) {
      tpQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }

    const overdueTopicsCount = await tpQb.getCount();
    const totalOverdue = overdueAllocations + overdueTopicsCount;

    return {
      averageMarks,
      gradeDistribution,
      onTimeRate,
      completionPercentage,
      overdueCount: totalOverdue,
      totalMentees,
      totalSubmissions,
    };
  }

  /**
   * Retrieves paginated per-mentee performance breakdown (FR-11.2, FR-11.3, PER-01, PER-02, PER-03).
   */
  async getMenteePerformanceList(
    filter: PerformanceFilterQuery,
    scope: PerformanceScopeFilter,
  ): Promise<{ mentees: MenteePerformanceRow[]; total: number }> {
    let resolvedMenteeIds = scope.allowedMenteeIds;

    if (scope.isSuperAdmin && filter.mentorId) {
      const mappings = await this.mentorMenteeRepo.find({
        where: { mentorId: filter.mentorId, isActive: true },
        select: ['menteeId'],
      });
      const adminScopedIds = mappings.map((m) => m.menteeId);
      resolvedMenteeIds = resolvedMenteeIds
        ? resolvedMenteeIds.filter((id) => adminScopedIds.includes(id))
        : adminScopedIds;
    }

    if (!scope.isSuperAdmin && (!resolvedMenteeIds || resolvedMenteeIds.length === 0)) {
      return { mentees: [], total: 0 };
    }

    const targetBatchId = filter.batchId ?? scope.scopedBatchId;

    const qb = this.userRepo
      .createQueryBuilder('u')
      .leftJoin(CourseAllocation, 'alloc', 'alloc.user_id = u.id AND alloc.deleted_at IS NULL')
      .leftJoin(Batch, 'b', 'b.id = alloc.batch_id')
      .where('u.role = :menteeRole', { menteeRole: UserRole.MENTEE })
      .andWhere('u.deleted_at IS NULL');

    if (targetBatchId) {
      qb.andWhere('alloc.batch_id = :batchId', { batchId: targetBatchId });
    }

    if (resolvedMenteeIds && resolvedMenteeIds.length > 0) {
      qb.andWhere('u.id IN (:...menteeIds)', { menteeIds: resolvedMenteeIds });
    }

    if (filter.courseId) {
      qb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }

    if (filter.status) {
      qb.andWhere('alloc.status = :status', { status: filter.status });
    }

    if (filter.search) {
      qb.andWhere('(LOWER(u.name) LIKE LOWER(:search) OR LOWER(u.email) LIKE LOWER(:search))', {
        search: `%${filter.search}%`,
      });
    }

    // Grouping by mentee and batch
    qb.select([
      'u.id as mentee_id',
      'u.name as mentee_name',
      'u.email as mentee_email',
      'b.id as batch_id',
      'b.name as batch_name',
      'COUNT(DISTINCT alloc.id) as assigned_courses_count',
      `COUNT(DISTINCT CASE WHEN alloc.status = :completedStatus THEN alloc.id ELSE NULL END) as completed_courses_count`,
      'AVG(alloc.progress_percent) as avg_progress',
    ]).setParameter('completedStatus', CourseAllocationStatus.COMPLETED);

    qb.groupBy('u.id')
      .addGroupBy('u.name')
      .addGroupBy('u.email')
      .addGroupBy('b.id')
      .addGroupBy('b.name');

    const rawRows = await qb.getRawMany<{
      mentee_id: string;
      mentee_name: string;
      mentee_email: string;
      batch_id: string | null;
      batch_name: string | null;
      assigned_courses_count: string;
      completed_courses_count: string;
      avg_progress: string | null;
    }>();

    if (rawRows.length === 0) {
      return { mentees: [], total: 0 };
    }

    const canPrePaginate =
      (!filter.gradeRange || filter.gradeRange === 'ALL') &&
      (!filter.sortBy ||
        filter.sortBy === 'name' ||
        filter.sortBy === 'completionPercentage' ||
        filter.sortBy === 'batch' ||
        filter.sortBy === 'courses');

    const order = filter.sortOrder === 'ASC' ? 1 : -1;
    const totalRaw = rawRows.length;
    let targetRows = [...rawRows];

    if (canPrePaginate) {
      if (filter.sortBy === 'completionPercentage') {
        targetRows.sort(
          (a, b) =>
            ((parseFloat(a.avg_progress ?? '0') || 0) - (parseFloat(b.avg_progress ?? '0') || 0)) *
            order,
        );
      } else if (filter.sortBy === 'batch') {
        targetRows.sort((a, b) => (a.batch_name ?? '').localeCompare(b.batch_name ?? '') * order);
      } else if (filter.sortBy === 'courses') {
        targetRows.sort(
          (a, b) =>
            (parseInt(a.assigned_courses_count, 10) - parseInt(b.assigned_courses_count, 10)) *
            order,
        );
      } else {
        targetRows.sort((a, b) => a.mentee_name.localeCompare(b.mentee_name) * order);
      }

      const startIndex = (filter.page - 1) * filter.limit;
      targetRows = targetRows.slice(startIndex, startIndex + filter.limit);
    }

    // Enrich target mentees with submission metrics
    const menteeIds = targetRows.map((r) => r.mentee_id);

    if (menteeIds.length === 0) {
      return { mentees: [], total: totalRaw };
    }

    const subAggQb = this.submissionRepo
      .createQueryBuilder('sub')
      .innerJoin(CourseAllocation, 'alloc', 'alloc.id = sub.course_allocation_id')
      .where('alloc.user_id IN (:...menteeIds)', { menteeIds })
      .andWhere('sub.deleted_at IS NULL');

    if (filter.startDate) {
      subAggQb.andWhere('sub.submitted_at >= :startDate', {
        startDate: new Date(filter.startDate),
      });
    }
    if (filter.endDate) {
      subAggQb.andWhere('sub.submitted_at <= :endDate', {
        endDate: normalizeEndDate(filter.endDate),
      });
    }
    if (filter.courseId) {
      subAggQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }
    if (targetBatchId) {
      subAggQb.andWhere('(sub.batch_id = :batchId OR alloc.batch_id = :batchId)', {
        batchId: targetBatchId,
      });
    }

    subAggQb
      .select([
        'alloc.user_id as mentee_id',
        'AVG(CASE WHEN sub.status = :gradedStatus THEN sub.marks ELSE NULL END) as avg_marks',
        'COUNT(sub.id) as total_submissions',
        'COUNT(CASE WHEN sub.is_late = false THEN 1 ELSE NULL END) as on_time_count',
      ])
      .setParameter('gradedStatus', SubmissionStatus.GRADED)
      .groupBy('alloc.user_id');

    // Overdue calculations per mentee
    const overdueAllocQb = this.allocationRepo
      .createQueryBuilder('alloc')
      .where('alloc.user_id IN (:...menteeIds)', { menteeIds })
      .andWhere('alloc.deleted_at IS NULL')
      .andWhere('alloc.due_date < NOW()')
      .andWhere('alloc.status IN (:...openStatuses)', {
        openStatuses: [CourseAllocationStatus.ASSIGNED, CourseAllocationStatus.IN_PROGRESS],
      });

    if (targetBatchId) {
      overdueAllocQb.andWhere('alloc.batch_id = :batchId', { batchId: targetBatchId });
    }
    if (filter.courseId) {
      overdueAllocQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }

    overdueAllocQb
      .select(['alloc.user_id as user_id', 'COUNT(alloc.id) as count'])
      .groupBy('alloc.user_id');

    // Latest grade label per mentee
    const latestSubsQb = this.submissionRepo
      .createQueryBuilder('sub')
      .innerJoin(CourseAllocation, 'alloc', 'alloc.id = sub.course_allocation_id')
      .where('alloc.user_id IN (:...menteeIds)', { menteeIds })
      .andWhere('sub.status = :gradedStatus', { gradedStatus: SubmissionStatus.GRADED })
      .andWhere('sub.deleted_at IS NULL');

    if (filter.startDate) {
      latestSubsQb.andWhere('sub.submitted_at >= :startDate', {
        startDate: new Date(filter.startDate),
      });
    }
    if (filter.endDate) {
      latestSubsQb.andWhere('sub.submitted_at <= :endDate', {
        endDate: normalizeEndDate(filter.endDate),
      });
    }
    if (filter.courseId) {
      latestSubsQb.andWhere('alloc.course_id = :courseId', { courseId: filter.courseId });
    }
    if (targetBatchId) {
      latestSubsQb.andWhere('(sub.batch_id = :batchId OR alloc.batch_id = :batchId)', {
        batchId: targetBatchId,
      });
    }

    latestSubsQb
      .orderBy('sub.submitted_at', 'DESC')
      .select(['alloc.user_id as user_id', 'sub.grade_label as grade_label']);

    // Concurrently execute all three sub-queries
    const [subAggregates, overdueAllocList, latestSubs] = await Promise.all([
      subAggQb.getRawMany<{
        mentee_id: string;
        avg_marks: string | null;
        total_submissions: string;
        on_time_count: string;
      }>(),
      overdueAllocQb.getRawMany<{ user_id: string; count: string }>(),
      latestSubsQb.getRawMany<{ user_id: string; grade_label: string }>(),
    ]);

    const subMap = new Map<
      string,
      { avgMarks: number | null; totalSub: number; onTimeSub: number }
    >();
    for (const sa of subAggregates) {
      subMap.set(sa.mentee_id, {
        avgMarks: sa.avg_marks ? parseFloat(parseFloat(sa.avg_marks).toFixed(2)) : null,
        totalSub: parseInt(sa.total_submissions, 10),
        onTimeSub: parseInt(sa.on_time_count, 10),
      });
    }

    const overdueAllocMap = new Map<string, number>();
    for (const oa of overdueAllocList) {
      overdueAllocMap.set(oa.user_id, parseInt(oa.count, 10));
    }

    const latestGradeMap = new Map<string, string>();
    for (const ls of latestSubs) {
      if (!latestGradeMap.has(ls.user_id)) {
        latestGradeMap.set(ls.user_id, ls.grade_label);
      }
    }

    // Compile rows
    let enrichedRows: MenteePerformanceRow[] = targetRows.map((r) => {
      const subInfo = subMap.get(r.mentee_id);
      const totalSubs = subInfo?.totalSub ?? 0;
      const onTimeSubs = subInfo?.onTimeSub ?? 0;
      const onTimeRate =
        totalSubs > 0 ? parseFloat(((onTimeSubs / totalSubs) * 100).toFixed(2)) : 100;

      return {
        menteeId: r.mentee_id,
        menteeName: r.mentee_name,
        menteeEmail: r.mentee_email,
        batchId: r.batch_id,
        batchName: r.batch_name,
        assignedCoursesCount: parseInt(r.assigned_courses_count, 10),
        completedCoursesCount: parseInt(r.completed_courses_count, 10),
        completionPercentage: r.avg_progress
          ? parseFloat(parseFloat(r.avg_progress).toFixed(2))
          : 0,
        averageMarks: subInfo?.avgMarks ?? null,
        totalSubmissions: totalSubs,
        onTimeSubmissions: onTimeSubs,
        onTimeRate,
        overdueCount: overdueAllocMap.get(r.mentee_id) ?? 0,
        latestGrade: latestGradeMap.get(r.mentee_id) ?? null,
      };
    });

    if (canPrePaginate) {
      return { mentees: enrichedRows, total: totalRaw };
    }

    // Grade range filter check
    if (filter.gradeRange && filter.gradeRange !== 'ALL') {
      enrichedRows = enrichedRows.filter((r) => r.latestGrade === filter.gradeRange);
    }

    // Sorting (PER-02)
    enrichedRows.sort((a, b) => {
      switch (filter.sortBy) {
        case 'averageMarks':
          return ((a.averageMarks ?? 0) - (b.averageMarks ?? 0)) * order;
        case 'completionPercentage':
          return (a.completionPercentage - b.completionPercentage) * order;
        case 'onTimeRate':
          return (a.onTimeRate - b.onTimeRate) * order;
        case 'overdueCount':
          return (a.overdueCount - b.overdueCount) * order;
        case 'batch':
          return (a.batchName ?? '').localeCompare(b.batchName ?? '') * order;
        case 'courses':
          return (a.assignedCoursesCount - b.assignedCoursesCount) * order;
        case 'grade':
          return (a.latestGrade ?? '').localeCompare(b.latestGrade ?? '') * order;
        case 'name':
        default:
          return a.menteeName.localeCompare(b.menteeName) * order;
      }
    });

    const total = enrichedRows.length;
    const startIndex = (filter.page - 1) * filter.limit;
    const paginatedMentees = enrichedRows.slice(startIndex, startIndex + filter.limit);

    return { mentees: paginatedMentees, total };
  }

  /**
   * Resolves personal learning history for the logged-in user (FR-11.4, FR-11.5, PER-04, PER-07, PER-08, PER-09, PER-10).
   * Note: strictly resolves for `userId`, ignoring any external query overrides.
   */
  async getLearningHistory(userId: string, batchIdFilter?: string): Promise<LearningHistoryResult> {
    const user = await this.userRepo.findOne({
      where: { id: userId, deletedAt: undefined },
      select: ['id', 'name', 'email'],
    });

    if (!user) {
      return {
        user: { id: userId, name: 'Unknown', email: '' },
        batches: [],
        summary: {
          totalAllocations: 0,
          completedAllocations: 0,
          overallProgress: 0,
          averageMarks: null,
        },
      };
    }

    // Find course allocations for this user
    const allocQb = this.allocationRepo
      .createQueryBuilder('alloc')
      .innerJoinAndSelect('alloc.course', 'course')
      .leftJoinAndSelect('alloc.batch', 'batch')
      .where('alloc.user_id = :userId', { userId })
      .andWhere('alloc.deleted_at IS NULL');

    if (batchIdFilter) {
      allocQb.andWhere('alloc.batch_id = :batchId', { batchId: batchIdFilter });
    }

    const allocations = await allocQb.orderBy('alloc.start_date', 'DESC').getMany();

    if (allocations.length === 0) {
      return {
        user: { id: user.id, name: user.name, email: user.email },
        batches: [],
        summary: {
          totalAllocations: 0,
          completedAllocations: 0,
          overallProgress: 0,
          averageMarks: null,
        },
      };
    }

    const allocationIds = allocations.map((a) => a.id);
    const submissions = await this.submissionRepo
      .createQueryBuilder('sub')
      .innerJoinAndSelect('sub.assignment', 'assignment')
      .where('sub.course_allocation_id IN (:...allocationIds)', { allocationIds })
      .andWhere('sub.deleted_at IS NULL')
      .orderBy('sub.version', 'DESC')
      .getMany();

    // Map submissions to allocations
    const subsByAlloc = new Map<string, LearningHistoryAssignment[]>();
    for (const sub of submissions) {
      const list = subsByAlloc.get(sub.courseAllocationId) ?? [];
      list.push({
        assignmentId: sub.assignmentId,
        assignmentTitle: sub.assignment?.title ?? 'Assignment',
        maxMarks: Number(sub.assignment?.maxMarks ?? 100),
        passMarks: Number(sub.assignment?.passMarks ?? 50),
        version: sub.version,
        submittedAt: sub.submittedAt,
        isLate: sub.isLate,
        status: sub.status,
        marks: sub.marks ? Number(sub.marks) : null,
        gradeLabel: sub.gradeLabel ?? null,
        feedback: sub.feedback ?? null,
      });
      subsByAlloc.set(sub.courseAllocationId, list);
    }

    // Group allocations by batch
    const batchMap = new Map<string, LearningHistoryBatch>();
    let totalProgressSum = 0;
    let completedAllocations = 0;
    let totalGradedMarksSum = 0;
    let totalGradedCount = 0;

    for (const alloc of allocations) {
      const batchId = alloc.batchId ?? 'unbatched';
      const batchName = alloc.batch?.name ?? 'Individual Allocation';
      const batchStatus = alloc.batch?.status ?? 'INDIVIDUAL';
      const batchStart = alloc.batch?.startDate ? new Date(alloc.batch.startDate) : alloc.startDate;
      const batchEnd = alloc.batch?.endDate ? new Date(alloc.batch.endDate) : null;

      let entry = batchMap.get(batchId);
      if (!entry) {
        entry = {
          batchId,
          batchName,
          status: batchStatus,
          startDate: batchStart,
          endDate: batchEnd,
          courseAllocations: [],
        };
        batchMap.set(batchId, entry);
      }

      const allocAssignments = subsByAlloc.get(alloc.id) ?? [];
      for (const assign of allocAssignments) {
        if (assign.marks !== null) {
          totalGradedMarksSum += assign.marks;
          totalGradedCount++;
        }
      }

      const progressNum = Number(alloc.progressPercent);
      totalProgressSum += progressNum;
      if (alloc.status === CourseAllocationStatus.COMPLETED) {
        completedAllocations++;
      }

      const allocItem: LearningHistoryAllocation = {
        allocationId: alloc.id,
        courseId: alloc.courseId,
        courseTitle: alloc.course?.title ?? 'Course',
        progressPercent: progressNum,
        status: alloc.status,
        startDate: alloc.startDate,
        dueDate: alloc.dueDate,
        completedAt: alloc.completedAt ?? null,
        assignments: allocAssignments,
      };

      entry.courseAllocations.push(allocItem);
    }

    const totalAllocations = allocations.length;
    const overallProgress =
      totalAllocations > 0 ? parseFloat((totalProgressSum / totalAllocations).toFixed(2)) : 0;
    const averageMarks =
      totalGradedCount > 0 ? parseFloat((totalGradedMarksSum / totalGradedCount).toFixed(2)) : null;

    return {
      user: { id: user.id, name: user.name, email: user.email },
      batches: Array.from(batchMap.values()),
      summary: {
        totalAllocations,
        completedAllocations,
        overallProgress,
        averageMarks,
      },
    };
  }

  private getEmptyOverview(): PerformanceOverviewMetrics {
    return {
      averageMarks: null,
      gradeDistribution: {
        'A+': { count: 0, percentage: 0 },
        A: { count: 0, percentage: 0 },
        B: { count: 0, percentage: 0 },
        C: { count: 0, percentage: 0 },
        D: { count: 0, percentage: 0 },
        F: { count: 0, percentage: 0 },
      },
      onTimeRate: null,
      completionPercentage: 0,
      overdueCount: 0,
      totalMentees: 0,
      totalSubmissions: 0,
    };
  }
}

export const performanceRepository = new PerformanceRepository();
