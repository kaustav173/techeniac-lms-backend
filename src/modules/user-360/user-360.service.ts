import type { AuthenticatedUser } from '../../core/auth';
import { ForbiddenError, NotFoundError } from '../../core/errors';
import type { CourseAllocation } from '../allocations';
import {
  type BatchMember,
  MentorMentee,
  MentorMenteeRepository,
  mentorMenteeRepository,
} from '../batches';
import type { Submission } from '../submissions';
import { SubmissionStatus } from '../submissions';
import type { SafeUser, UserRoleHistory } from '../users';
import { toSafeUser, UserRole } from '../users';
import { User360Repository, user360Repository } from './user-360.repository';
import type {
  AuditType,
  User360ExportParams,
  User360QueryParams,
  User360Tab,
} from './user-360.schemas';

export interface RoleHistoryItem {
  id: string;
  role: UserRole;
  fromAt: Date;
  toAt: Date | null;
  reason: string;
  changedBy: string | null;
  periodLabel: string;
}

export interface BatchHistoryItem {
  id: string;
  batchId: string;
  batchName: string;
  batchCode: string;
  role: string;
  joinedAt: Date;
  leftAt: Date | null;
  reasonToLeave: string | null;
  isActive: boolean;
  periodLabel: string;
}

export interface MentorMappingItem {
  id: string;
  batchId: string;
  batchCode: string;
  mappedRole: 'MENTOR' | 'MENTEE';
  peerId: string;
  peerName: string;
  peerEmail: string;
  startDate: Date;
  endDate: Date | null;
  isActive: boolean;
  endReason: string | null;
  periodLabel: string;
}

export interface CourseHistoryItem {
  id: string;
  courseId: string;
  courseTitle: string;
  batchId: string | null;
  batchCode: string | null;
  status: string;
  startDate: Date;
  dueDate: Date;
  completedAt: Date | null;
  progressPercent: number;
  periodLabel: string;
  role: UserRole;
}

export interface SubmissionHistoryItem {
  id: string;
  assignmentId: string;
  assignmentTitle: string;
  courseAllocationId: string;
  batchId: string | null;
  version: number;
  status: string;
  submittedAt: Date;
  isLate: boolean;
  marks: number | null;
  gradeLabel: string | null;
  feedback: string | null;
  gradedAt: Date | null;
  graderName: string | null;
  periodLabel: string;
  role: UserRole;
}

export interface PerformanceSummary {
  totalAllocations: number;
  completedAllocations: number;
  inProgressAllocations: number;
  averageProgressPercent: number;
  totalSubmissions: number;
  gradedSubmissions: number;
  averageMarks: number | null;
  onTimeSubmissions: number;
  lateSubmissions: number;
  onTimeRatePercent: number;
  gradeDistribution: Record<string, number>;
}

export type AuditAction = 'ROLE_CHANGED' | 'BATCH_JOINED' | 'BATCH_LEFT' | 'ASSIGNMENT_GRADED';

export interface AuditHistoryItem {
  id: string;
  type: AuditType;
  action: AuditAction;
  timestamp: Date;
  actorId: string | null;
  details: Record<string, unknown>;
  periodLabel: string;
  role: UserRole;
  batchId?: string;
}

export interface User360Profile {
  user: SafeUser;
  tabs: {
    profile: SafeUser;
    roleHistory: RoleHistoryItem[];
    batchHistory: BatchHistoryItem[];
    mentorMappingHistory: MentorMappingItem[];
    courseHistory: CourseHistoryItem[];
    assignmentGradeHistory: SubmissionHistoryItem[];
    performanceSummary: PerformanceSummary;
    audit: AuditHistoryItem[];
  };
}

export type User360TabResponse = {
  user: SafeUser;
  tabs: Partial<User360Profile['tabs']>;
};

export class User360Service {
  constructor(
    private readonly repository: User360Repository = user360Repository,
    private readonly mentorMenteeRepo: MentorMenteeRepository = mentorMenteeRepository,
  ) {}

  public async assertMentorCanAccessMentee(
    mentorId: string,
    menteeId: string,
    action: 'access' | 'export' = 'access',
  ): Promise<void> {
    const isMapped = await this.mentorMenteeRepo.isMenteeMappedToMentor(mentorId, menteeId);
    if (!isMapped) {
      throw new ForbiddenError(`Mentors can only ${action} 360 profiles of their assigned mentees`);
    }
  }

  public async getUser360(
    userId: string,
    query: User360QueryParams,
    authUser?: AuthenticatedUser,
  ): Promise<User360Profile | User360TabResponse> {
    if (authUser && (authUser.role as UserRole) === UserRole.MENTOR) {
      await this.assertMentorCanAccessMentee(authUser.id, userId, 'access');
    }

    const user = await this.repository.getUser(userId);
    if (!user) {
      throw new NotFoundError(`User with ID ${userId} not found`);
    }

    const safeUser = toSafeUser(user);
    const tab = query.tab ?? 'all';

    // Fast-path: profile tab requires no historical relationship queries
    if (tab === 'profile') {
      return { user: safeUser, tabs: { profile: safeUser } };
    }

    const needsBatchMemberships = tab === 'all' || tab === 'batch-history' || tab === 'audit';
    const needsMentorMappings = tab === 'all' || tab === 'mentor-mapping-history';
    const needsCourseAllocations =
      tab === 'all' || tab === 'course-history' || tab === 'performance-summary';
    const needsSubmissions =
      tab === 'all' ||
      tab === 'assignment-grade-history' ||
      tab === 'performance-summary' ||
      tab === 'audit';

    // roleHistory is unconditionally required across all tab builders to derive role period labels
    const [roleHistory, batchMemberships, mentorMappings, courseAllocations, submissions] =
      await Promise.all([
        this.repository.getRoleHistory(userId),
        needsBatchMemberships ? this.repository.getBatchMemberships(userId) : Promise.resolve([]),
        needsMentorMappings ? this.repository.getMentorMappings(userId) : Promise.resolve([]),
        needsCourseAllocations ? this.repository.getCourseAllocations(userId) : Promise.resolve([]),
        needsSubmissions ? this.repository.getSubmissions(userId) : Promise.resolve([]),
      ]);

    const fullProfile = this.aggregateProfile(
      safeUser,
      roleHistory,
      batchMemberships,
      mentorMappings,
      courseAllocations,
      submissions,
      query,
    );

    if (query.tab && query.tab !== 'all') {
      return this.filterByTab(fullProfile, query.tab);
    }

    return fullProfile;
  }

  public async exportUser360Csv(
    userId: string,
    query: User360ExportParams,
    authUser?: AuthenticatedUser,
  ): Promise<string> {
    if (authUser && (authUser.role as UserRole) === UserRole.MENTOR) {
      await this.assertMentorCanAccessMentee(authUser.id, userId, 'export');
    }

    const profile = (await this.getUser360(
      userId,
      {
        ...query,
        tab: 'all',
      },
      authUser,
    )) as User360Profile;

    const lines: string[] = [];

    // 1. Profile Section
    lines.push('--- USER 360 PROFILE ---');
    lines.push(`Name,${this.escapeCsv(profile.user.name)}`);
    lines.push(`Email,${this.escapeCsv(profile.user.email)}`);
    lines.push(`Current Role,${profile.user.role}`);
    lines.push(`Status,${profile.user.isActive ? 'Active' : 'Inactive'}`);
    lines.push(`Created At,${profile.user.createdAt.toISOString()}`);
    lines.push('');

    // 2. Role History
    lines.push('--- ROLE HISTORY ---');
    lines.push('Role,From,To,Reason,Period');
    for (const r of profile.tabs.roleHistory) {
      lines.push(
        `${r.role},${r.fromAt.toISOString()},${r.toAt ? r.toAt.toISOString() : 'Present'},${this.escapeCsv(r.reason)},${this.escapeCsv(r.periodLabel)}`,
      );
    }
    lines.push('');

    // 3. Batch History
    lines.push('--- BATCH HISTORY ---');
    lines.push('Batch Name,Batch Code,Role,Joined At,Left At,Reason To Leave,Status,Period');
    for (const b of profile.tabs.batchHistory) {
      lines.push(
        `${this.escapeCsv(b.batchName)},${b.batchCode},${b.role},${b.joinedAt.toISOString()},${b.leftAt ? b.leftAt.toISOString() : ''},${this.escapeCsv(b.reasonToLeave ?? '')},${b.isActive ? 'Active' : 'Left'},${this.escapeCsv(b.periodLabel)}`,
      );
    }
    lines.push('');

    // 4. Mentor Mappings
    lines.push('--- MENTOR MAPPINGS ---');
    lines.push(
      'Batch Code,User Role In Mapping,Peer Name,Peer Email,Start Date,End Date,Reason,Status',
    );
    for (const m of profile.tabs.mentorMappingHistory) {
      lines.push(
        `${m.batchCode},${m.mappedRole},${this.escapeCsv(m.peerName)},${m.peerEmail},${m.startDate.toISOString()},${m.endDate ? m.endDate.toISOString() : ''},${this.escapeCsv(m.endReason ?? '')},${m.isActive ? 'Active' : 'Ended'}`,
      );
    }
    lines.push('');

    // 5. Course Allocations
    lines.push('--- COURSE HISTORY ---');
    lines.push('Course Title,Batch,Status,Start Date,Due Date,Progress %,Completed At,Period');
    for (const c of profile.tabs.courseHistory) {
      lines.push(
        `${this.escapeCsv(c.courseTitle)},${c.batchCode ?? 'N/A'},${c.status},${c.startDate.toISOString()},${c.dueDate.toISOString()},${c.progressPercent}%,${c.completedAt ? c.completedAt.toISOString() : ''},${this.escapeCsv(c.periodLabel)}`,
      );
    }
    lines.push('');

    // 6. Submissions & Grades
    lines.push('--- ASSIGNMENT & GRADE HISTORY ---');
    lines.push('Assignment,Version,Status,Submitted At,Is Late,Marks,Grade,Grader,Feedback');
    for (const s of profile.tabs.assignmentGradeHistory) {
      lines.push(
        `${this.escapeCsv(s.assignmentTitle)},${s.version},${s.status},${s.submittedAt.toISOString()},${s.isLate ? 'YES' : 'NO'},${s.marks ?? ''},${s.gradeLabel ?? ''},${this.escapeCsv(s.graderName ?? '')},${this.escapeCsv(s.feedback ?? '')}`,
      );
    }
    lines.push('');

    // 7. Performance Summary
    lines.push('--- PERFORMANCE SUMMARY ---');
    lines.push(`Total Allocations,${profile.tabs.performanceSummary.totalAllocations}`);
    lines.push(`Completed Allocations,${profile.tabs.performanceSummary.completedAllocations}`);
    lines.push(
      `Average Progress,${profile.tabs.performanceSummary.averageProgressPercent.toFixed(1)}%`,
    );
    lines.push(`Total Submissions,${profile.tabs.performanceSummary.totalSubmissions}`);
    lines.push(`Graded Submissions,${profile.tabs.performanceSummary.gradedSubmissions}`);
    lines.push(
      `Average Marks,${profile.tabs.performanceSummary.averageMarks !== null ? profile.tabs.performanceSummary.averageMarks.toFixed(1) : 'N/A'}`,
    );
    lines.push(
      `On-Time Submission Rate,${profile.tabs.performanceSummary.onTimeRatePercent.toFixed(1)}%`,
    );
    lines.push('');

    return lines.join('\n');
  }

  private isWithinDateRange(
    start: Date,
    end: Date | null,
    startDate?: string,
    endDate?: string,
  ): boolean {
    if (startDate) {
      const qStart = new Date(startDate);
      const effectiveEnd = end ?? new Date();
      if (effectiveEnd < qStart) return false;
    }
    if (endDate) {
      const qEnd = new Date(endDate);
      if (start > qEnd) return false;
    }
    return true;
  }

  private buildRoleHistory(
    roleHistory: UserRoleHistory[],
    query: User360QueryParams,
  ): RoleHistoryItem[] {
    return roleHistory
      .map((rh) => ({
        id: rh.id,
        role: rh.role,
        fromAt: rh.fromAt,
        toAt: rh.toAt,
        reason: rh.reason,
        changedBy: rh.changedBy,
        periodLabel: this.formatPeriodLabel(rh.role, rh.fromAt, rh.toAt),
      }))
      .filter((rh) => {
        if (query.rolePeriod && rh.role !== query.rolePeriod) return false;
        if (!this.isWithinDateRange(rh.fromAt, rh.toAt, query.startDate, query.endDate)) {
          return false;
        }
        return true;
      });
  }

  private buildBatchHistory(
    batchMemberships: BatchMember[],
    roleHistory: UserRoleHistory[],
    userRole: UserRole,
    query: User360QueryParams,
  ): BatchHistoryItem[] {
    return batchMemberships
      .filter((bm) => {
        if (query.batchId && bm.batchId !== query.batchId) return false;
        const period = this.getRolePeriodForDate(bm.joinedAt, roleHistory, userRole);
        if (query.rolePeriod && period.role !== query.rolePeriod) return false;
        if (!this.isWithinDateRange(bm.joinedAt, bm.leftAt, query.startDate, query.endDate)) {
          return false;
        }
        return true;
      })
      .map((bm) => {
        const period = this.getRolePeriodForDate(bm.joinedAt, roleHistory, userRole);
        return {
          id: bm.id,
          batchId: bm.batchId,
          batchName: bm.batch?.name ?? 'Unknown Batch',
          batchCode: bm.batch?.code ?? 'N/A',
          role: bm.memberRole,
          joinedAt: bm.joinedAt,
          leftAt: bm.leftAt,
          reasonToLeave: bm.reasonToLeave,
          isActive: bm.isActive,
          periodLabel: period.label,
        };
      });
  }

  private buildMentorMappingHistory(
    mentorMappings: MentorMentee[],
    roleHistory: UserRoleHistory[],
    user: SafeUser,
    query: User360QueryParams,
  ): MentorMappingItem[] {
    return mentorMappings
      .filter((mm) => {
        if (query.batchId && mm.batchId !== query.batchId) return false;
        const period = this.getRolePeriodForDate(mm.startDate, roleHistory, user.role);
        if (query.rolePeriod && period.role !== query.rolePeriod) return false;
        if (!this.isWithinDateRange(mm.startDate, mm.endDate, query.startDate, query.endDate)) {
          return false;
        }
        return true;
      })
      .map((mm) => {
        const isUserMentor = mm.mentorId === user.id;
        const peer = isUserMentor ? mm.mentee : mm.mentor;
        const period = this.getRolePeriodForDate(mm.startDate, roleHistory, user.role);
        return {
          id: mm.id,
          batchId: mm.batchId,
          batchCode: mm.batch?.code ?? 'N/A',
          mappedRole: isUserMentor ? ('MENTOR' as const) : ('MENTEE' as const),
          peerId: peer?.id ?? (isUserMentor ? mm.menteeId : mm.mentorId),
          peerName: peer?.name ?? 'Unknown User',
          peerEmail: peer?.email ?? '',
          startDate: mm.startDate,
          endDate: mm.endDate,
          isActive: mm.isActive,
          endReason: mm.endReason,
          periodLabel: period.label,
        };
      });
  }

  private buildCourseHistory(
    courseAllocations: CourseAllocation[],
    roleHistory: UserRoleHistory[],
    userRole: UserRole,
    query: User360QueryParams,
  ): CourseHistoryItem[] {
    return courseAllocations
      .map((ca) => {
        const period = this.getRolePeriodForDate(ca.startDate, roleHistory, userRole);
        return {
          id: ca.id,
          courseId: ca.courseId,
          courseTitle: ca.course?.title ?? 'Untitled Course',
          batchId: ca.batchId,
          batchCode: ca.batch?.code ?? null,
          status: ca.status,
          startDate: ca.startDate,
          dueDate: ca.dueDate,
          completedAt: ca.completedAt,
          progressPercent: ca.progressPercent,
          periodLabel: period.label,
          role: period.role,
        };
      })
      .filter((c) => {
        if (query.batchId && c.batchId !== query.batchId) return false;
        if (query.rolePeriod && c.role !== query.rolePeriod) return false;
        if (
          !this.isWithinDateRange(
            c.startDate,
            c.completedAt ?? c.dueDate,
            query.startDate,
            query.endDate,
          )
        ) {
          return false;
        }
        return true;
      });
  }

  private buildSubmissionHistory(
    submissions: Submission[],
    roleHistory: UserRoleHistory[],
    userRole: UserRole,
    query: User360QueryParams,
  ): SubmissionHistoryItem[] {
    return submissions
      .map((sub) => {
        const period = this.getRolePeriodForDate(sub.submittedAt, roleHistory, userRole);
        return {
          id: sub.id,
          assignmentId: sub.assignmentId,
          assignmentTitle: sub.assignment?.title ?? 'Untitled Assignment',
          courseAllocationId: sub.courseAllocationId,
          batchId: sub.batchId,
          version: sub.version,
          status: sub.status,
          submittedAt: sub.submittedAt,
          isLate: sub.isLate,
          marks: sub.marks,
          gradeLabel: sub.gradeLabel,
          feedback: sub.feedback,
          gradedAt: sub.gradedAt,
          graderName: sub.grader?.name ?? null,
          periodLabel: period.label,
          role: period.role,
        };
      })
      .filter((s) => {
        if (query.batchId && s.batchId !== query.batchId) return false;
        if (query.rolePeriod && s.role !== query.rolePeriod) return false;
        if (!this.isWithinDateRange(s.submittedAt, s.submittedAt, query.startDate, query.endDate)) {
          return false;
        }
        return true;
      });
  }

  private buildPerformanceSummary(
    courseItems: CourseHistoryItem[],
    submissionItems: SubmissionHistoryItem[],
  ): PerformanceSummary {
    const totalAllocations = courseItems.length;
    const completedAllocations = courseItems.filter((c) => c.status === 'COMPLETED').length;
    const inProgressAllocations = courseItems.filter((c) => c.status === 'IN_PROGRESS').length;
    const averageProgressPercent =
      totalAllocations > 0
        ? courseItems.reduce((acc, c) => acc + c.progressPercent, 0) / totalAllocations
        : 0;

    const totalSubmissions = submissionItems.length;
    const gradedSubmissions = submissionItems.filter((s) => s.marks !== null).length;
    const marksSum = submissionItems.reduce((acc, s) => acc + (s.marks ?? 0), 0);
    const averageMarks = gradedSubmissions > 0 ? marksSum / gradedSubmissions : null;

    const onTimeSubmissions = submissionItems.filter((s) => !s.isLate).length;
    const lateSubmissions = submissionItems.filter((s) => s.isLate).length;
    const onTimeRatePercent =
      totalSubmissions > 0 ? (onTimeSubmissions / totalSubmissions) * 100 : 100;

    const gradeDistribution: Record<string, number> = {};
    for (const sub of submissionItems) {
      if (sub.gradeLabel) {
        gradeDistribution[sub.gradeLabel] = (gradeDistribution[sub.gradeLabel] ?? 0) + 1;
      }
    }

    return {
      totalAllocations,
      completedAllocations,
      inProgressAllocations,
      averageProgressPercent,
      totalSubmissions,
      gradedSubmissions,
      averageMarks,
      onTimeSubmissions,
      lateSubmissions,
      onTimeRatePercent,
      gradeDistribution,
    };
  }

  private buildAuditHistory(
    roleHistory: UserRoleHistory[],
    batchMemberships: BatchMember[],
    submissions: Submission[],
    userRole: UserRole,
    query: User360QueryParams,
  ): AuditHistoryItem[] {
    const auditItems: AuditHistoryItem[] = [];

    // Role changes
    for (const rh of roleHistory) {
      auditItems.push({
        id: `audit-role-${rh.id}`,
        type: 'USER_ROLE',
        action: 'ROLE_CHANGED',
        timestamp: rh.fromAt,
        actorId: rh.changedBy,
        details: { role: rh.role, reason: rh.reason },
        periodLabel: this.formatPeriodLabel(rh.role, rh.fromAt, rh.toAt),
        role: rh.role,
        batchId: undefined,
      });
    }

    // Batch memberships
    for (const bm of batchMemberships) {
      const joinPeriod = this.getRolePeriodForDate(bm.joinedAt, roleHistory, userRole);
      auditItems.push({
        id: `audit-bm-join-${bm.id}`,
        type: 'BATCH',
        action: 'BATCH_JOINED',
        timestamp: bm.joinedAt,
        actorId: bm.createdBy,
        details: { batchId: bm.batchId, role: bm.memberRole },
        periodLabel: joinPeriod.label,
        role: joinPeriod.role,
        batchId: bm.batchId,
      });
      if (bm.leftAt) {
        const leavePeriod = this.getRolePeriodForDate(bm.leftAt, roleHistory, userRole);
        auditItems.push({
          id: `audit-bm-leave-${bm.id}`,
          type: 'BATCH',
          action: 'BATCH_LEFT',
          timestamp: bm.leftAt,
          actorId: bm.updatedBy,
          details: { batchId: bm.batchId, reasonToLeave: bm.reasonToLeave },
          periodLabel: leavePeriod.label,
          role: leavePeriod.role,
          batchId: bm.batchId,
        });
      }
    }

    // Submissions and Grading
    for (const sub of submissions) {
      if (sub.status === SubmissionStatus.GRADED && sub.gradedAt) {
        const gradePeriod = this.getRolePeriodForDate(sub.gradedAt, roleHistory, userRole);
        auditItems.push({
          id: `audit-grade-${sub.id}`,
          type: 'GRADING',
          action: 'ASSIGNMENT_GRADED',
          timestamp: sub.gradedAt,
          actorId: sub.gradedBy,
          details: {
            assignmentId: sub.assignmentId,
            marks: sub.marks,
            gradeLabel: sub.gradeLabel,
            feedback: sub.feedback,
          },
          periodLabel: gradePeriod.label,
          role: gradePeriod.role,
          batchId: sub.batchId ?? undefined,
        });
      }
    }

    // Sort audit chronologically descending
    auditItems.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return auditItems.filter((a) => {
      if (query.auditType && a.type !== query.auditType) return false;
      if (query.rolePeriod && a.role !== query.rolePeriod) return false;
      if (query.batchId && a.batchId !== query.batchId) return false;
      if (!this.isWithinDateRange(a.timestamp, a.timestamp, query.startDate, query.endDate)) {
        return false;
      }
      return true;
    });
  }

  private aggregateProfile(
    user: SafeUser,
    roleHistory: UserRoleHistory[],
    batchMemberships: BatchMember[],
    mentorMappings: MentorMentee[],
    courseAllocations: CourseAllocation[],
    submissions: Submission[],
    query: User360QueryParams,
  ): User360Profile {
    const roleItems = this.buildRoleHistory(roleHistory, query);
    const batchItems = this.buildBatchHistory(batchMemberships, roleHistory, user.role, query);
    const mappingItems = this.buildMentorMappingHistory(mentorMappings, roleHistory, user, query);
    const courseItems = this.buildCourseHistory(courseAllocations, roleHistory, user.role, query);
    const submissionItems = this.buildSubmissionHistory(submissions, roleHistory, user.role, query);
    const performanceSummary = this.buildPerformanceSummary(courseItems, submissionItems);
    const auditItems = this.buildAuditHistory(
      roleHistory,
      batchMemberships,
      submissions,
      user.role,
      query,
    );

    return {
      user,
      tabs: {
        profile: user,
        roleHistory: roleItems,
        batchHistory: batchItems,
        mentorMappingHistory: mappingItems,
        courseHistory: courseItems,
        assignmentGradeHistory: submissionItems,
        performanceSummary,
        audit: auditItems,
      },
    };
  }

  private filterByTab(profile: User360Profile, tab: User360Tab): User360TabResponse {
    switch (tab) {
      case 'profile':
        return { user: profile.user, tabs: { profile: profile.user } };
      case 'role-history':
        return { user: profile.user, tabs: { roleHistory: profile.tabs.roleHistory } };
      case 'batch-history':
        return { user: profile.user, tabs: { batchHistory: profile.tabs.batchHistory } };
      case 'mentor-mapping-history':
        return {
          user: profile.user,
          tabs: { mentorMappingHistory: profile.tabs.mentorMappingHistory },
        };
      case 'course-history':
        return { user: profile.user, tabs: { courseHistory: profile.tabs.courseHistory } };
      case 'assignment-grade-history':
        return {
          user: profile.user,
          tabs: { assignmentGradeHistory: profile.tabs.assignmentGradeHistory },
        };
      case 'performance-summary':
        return {
          user: profile.user,
          tabs: { performanceSummary: profile.tabs.performanceSummary },
        };
      case 'audit':
        return { user: profile.user, tabs: { audit: profile.tabs.audit } };
      default:
        return profile;
    }
  }

  private getRolePeriodForDate(
    date: Date,
    history: UserRoleHistory[],
    fallbackRole: UserRole,
  ): { role: UserRole; label: string } {
    const sorted = [...history].sort(
      (a, b) => new Date(a.fromAt).getTime() - new Date(b.fromAt).getTime(),
    );
    for (const h of sorted) {
      const from = new Date(h.fromAt);
      const to = h.toAt ? new Date(h.toAt) : null;
      if (date >= from && (!to || date <= to)) {
        return {
          role: h.role,
          label: this.formatPeriodLabel(h.role, from, to),
        };
      }
    }
    return {
      role: fallbackRole,
      label: `As ${this.formatRoleName(fallbackRole)}`,
    };
  }

  private formatPeriodLabel(role: UserRole, from: Date, to: Date | null): string {
    const roleName = this.formatRoleName(role);
    const fromStr = this.formatMonthYear(from);
    const toStr = to ? this.formatMonthYear(to) : 'Present';
    return `As ${roleName}: ${fromStr}–${toStr}`;
  }

  private formatRoleName(role: UserRole): string {
    switch (role) {
      case UserRole.SUPER_ADMIN:
        return 'Super Admin';
      case UserRole.MENTOR:
        return 'Mentor';
      case UserRole.MENTEE:
      default:
        return 'Mentee';
    }
  }

  private formatMonthYear(date: Date): string {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  private escapeCsv(value: string): string {
    let v = value;
    if (/^[=+\-@\t\r]/.test(v)) {
      v = `'${v}`;
    }
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  }
}

export const user360Service = new User360Service();
