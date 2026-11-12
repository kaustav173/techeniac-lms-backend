import { logAudit } from '../../core/audit';
import { emailService } from '../../core/email/email.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '../../core/errors';
import { logger } from '../../core/logging';
import { safeUrl } from '../../core/utils/sanitizer';
import { CourseAllocation } from '../allocations';
import { AuditType } from '../audit';
import { BatchStatus } from '../batches';
import { Assignment, SubmissionMode } from '../courses';
import { User, UserRole } from '../users';
import { Submission, SubmissionData, SubmissionStatus } from './entities/submission.entity';
import type {
  AssignmentDerivedStatus,
  CreateSubmissionInput,
  ListMyAssignmentsQuery,
} from './schemas/submissions.schemas';
import { submissionsRepository } from './submissions.repository';

export interface AllocationContext {
  allocationId: string;
  courseId: string;
  batchId: string | null;
  menteeId: string;
  dueDate: Date;
  batchStatus: BatchStatus;
  isBatchActive: boolean;
  overrideDueDate?: Date | null;
  assignmentOverrides?: Record<string, string>;
}

export interface AssignmentWithSubmissionStatus {
  id: string;
  courseId: string;
  allocationId?: string;
  courseTitle: string;
  topicId: string | null;
  topicTitle: string | null;
  scope: string;
  title: string;
  instructions: string | null;
  estimatedMinutes: number;
  maxMarks: number;
  passMarks: number;
  allowLate: boolean;
  pdfMode: SubmissionMode;
  zipMode: SubmissionMode;
  urlMode: SubmissionMode;
  resources: unknown;
  dueDate: string;
  status: AssignmentDerivedStatus;
  latestSubmission?: {
    id: string;
    version: number;
    submittedAt: string;
    isLate: boolean;
    status: SubmissionStatus;
    marks: number | null;
    gradeLabel: string | null;
    feedback: string | null;
  } | null;
}

export class SubmissionsService {
  async getMyAssignments(
    menteeId: string,
    query: ListMyAssignmentsQuery,
  ): Promise<{
    items: AssignmentWithSubmissionStatus[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const user = await submissionsRepository.findUserById(menteeId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const isMenteeRole = user.role === UserRole.MENTEE && user.isActive;

    // Retrieve active course allocations for this mentee
    const allocations = await this.getMenteeAllocations(menteeId);
    if (allocations.length === 0) {
      return { items: [], total: 0, page: query.page, limit: query.limit, totalPages: 0 };
    }

    const courseIds = allocations.map((a) => a.courseId);
    const allocationByCourseId = new Map(allocations.map((a) => [a.courseId, a]));

    const assignments = await submissionsRepository.findAssignmentsByCourseIds(
      courseIds,
      query.courseId,
      query.topicId,
    );

    // Fetch submissions for target assignments
    const allocationIds = allocations.map((a) => a.allocationId);
    const hasStatusFilter = Boolean(query.status && query.status !== 'ALL');
    const totalAssignmentsCount = assignments.length;

    // Fast-path: When viewing unfiltered assignments (default view), paginate assignments before querying submissions
    const targetAssignments = hasStatusFilter
      ? assignments
      : assignments.slice((query.page - 1) * query.limit, query.page * query.limit);

    const assignmentIds = targetAssignments.map((a) => a.id);

    const allSubmissions = await submissionsRepository.findSubmissionsByAllocationsAndAssignments(
      allocationIds,
      assignmentIds,
    );

    const latestSubmissionMap = new Map<string, Submission>();
    for (const sub of allSubmissions) {
      const key = `${sub.courseAllocationId}:${sub.assignmentId}`;
      if (!latestSubmissionMap.has(key)) {
        latestSubmissionMap.set(key, sub);
      }
    }

    const now = new Date();
    const items: AssignmentWithSubmissionStatus[] = [];

    for (const assignment of targetAssignments) {
      const alloc = allocationByCourseId.get(assignment.courseId);
      if (!alloc) continue;

      const overrideDueDateStr = alloc.assignmentOverrides?.[assignment.id];
      const effectiveDueDate = overrideDueDateStr ? new Date(overrideDueDateStr) : alloc.dueDate;

      const key = `${alloc.allocationId}:${assignment.id}`;
      const latestSub = latestSubmissionMap.get(key) || null;

      let derivedStatus: AssignmentDerivedStatus;

      if (!isMenteeRole) {
        // Role change from Mentee marks unsubmitted assignments CLOSED (SUB-21)
        derivedStatus = latestSub ? latestSub.status : 'CLOSED';
      } else if (
        alloc.batchStatus === BatchStatus.ON_HOLD ||
        alloc.batchStatus === BatchStatus.COMPLETED ||
        alloc.batchStatus === BatchStatus.ARCHIVED
      ) {
        // Batch read-only locks unsubmitted assignments as CLOSED (SUB-22)
        derivedStatus = latestSub ? latestSub.status : 'CLOSED';
      } else if (latestSub) {
        derivedStatus = latestSub.status;
      } else if (now > effectiveDueDate) {
        derivedStatus = 'OVERDUE';
      } else {
        derivedStatus = 'PENDING';
      }

      if (query.status && query.status !== 'ALL' && derivedStatus !== query.status) {
        continue;
      }

      items.push({
        id: assignment.id,
        courseId: assignment.courseId,
        allocationId: alloc.allocationId,
        courseTitle: assignment.course?.title || '',
        topicId: assignment.topicId,
        topicTitle: assignment.topic?.title || null,
        scope: assignment.scope,
        title: assignment.title,
        instructions: assignment.instructions,
        estimatedMinutes: assignment.estimatedMinutes,
        maxMarks: assignment.maxMarks,
        passMarks: assignment.passMarks,
        allowLate: assignment.allowLate,
        pdfMode: assignment.pdfMode,
        zipMode: assignment.zipMode,
        urlMode: assignment.urlMode,
        resources: assignment.resources,
        dueDate: effectiveDueDate.toISOString(),
        status: derivedStatus,
        latestSubmission: latestSub
          ? {
              id: latestSub.id,
              version: latestSub.version,
              submittedAt: latestSub.submittedAt.toISOString(),
              isLate: latestSub.isLate,
              status: latestSub.status,
              marks: latestSub.marks,
              gradeLabel: latestSub.gradeLabel,
              feedback: latestSub.feedback,
            }
          : null,
      });
    }

    if (!hasStatusFilter) {
      const totalPages = Math.ceil(totalAssignmentsCount / query.limit);
      return {
        items,
        total: totalAssignmentsCount,
        page: query.page,
        limit: query.limit,
        totalPages,
      };
    }

    const total = items.length;
    const startIndex = (query.page - 1) * query.limit;
    const paginatedItems = items.slice(startIndex, startIndex + query.limit);
    const totalPages = Math.ceil(total / query.limit);

    return {
      items: paginatedItems,
      total,
      page: query.page,
      limit: query.limit,
      totalPages,
    };
  }

  async getAssignmentSubmissionDetails(
    menteeId: string,
    assignmentId: string,
  ): Promise<{
    assignment: Assignment;
    allocation: {
      allocationId: string;
      dueDate: string;
      batchId: string | null;
      batchStatus: BatchStatus;
      isBatchActive: boolean;
    };
    versions: Submission[];
  }> {
    const assignment = await submissionsRepository.findAssignmentById(assignmentId);
    if (!assignment) {
      throw new NotFoundError('Assignment not found');
    }

    const alloc = await this.getAllocationForCourse(
      menteeId,
      assignment.courseId,
      undefined,
      assignmentId,
    );

    const versions = await submissionsRepository.findSubmissionsForAllocationAndAssignment(
      alloc.allocationId,
      assignmentId,
    );

    return {
      assignment,
      allocation: {
        allocationId: alloc.allocationId,
        dueDate: alloc.dueDate.toISOString(),
        batchId: alloc.batchId,
        batchStatus: alloc.batchStatus,
        isBatchActive: alloc.isBatchActive,
      },
      versions,
    };
  }

  async submitAssignment(menteeId: string, input: CreateSubmissionInput): Promise<Submission> {
    // 1. Verify user role is MENTEE (SUB-21)
    const user = await submissionsRepository.findUserById(menteeId);
    if (!user || user.role !== UserRole.MENTEE || !user.isActive) {
      throw new ForbiddenError('Access denied: Only active mentees can submit assignments');
    }

    // 2. Mandatory confirmation checkbox check (SUB-06)
    if (input.confirmedComplete !== true) {
      throw new UnprocessableEntityError('Please confirm you have completed the assignment');
    }

    // 3. Find assignment
    const assignment = await submissionsRepository.findAssignmentById(input.assignmentId);
    if (!assignment) {
      throw new NotFoundError('Assignment not found');
    }

    // 4. Validate submission fields against assignment settings (SUB-07, SUB-24, SUB-25, SUB-26, VAL-14)
    const sanitizedData: SubmissionData = {};
    const data = input.submissionData;

    // Check PDF field
    if (data.pdfUrl && data.pdfUrl.trim().length > 0) {
      if (assignment.pdfMode === SubmissionMode.OFF) {
        throw new UnprocessableEntityError('PDF submission is disabled for this assignment');
      }
      sanitizedData.pdfUrl = safeUrl(data.pdfUrl);
    } else if (assignment.pdfMode === SubmissionMode.REQUIRED) {
      throw new UnprocessableEntityError('PDF submission is required for this assignment');
    }

    // Check ZIP field
    if (data.zipUrl && data.zipUrl.trim().length > 0) {
      if (assignment.zipMode === SubmissionMode.OFF) {
        throw new UnprocessableEntityError('ZIP submission is disabled for this assignment');
      }
      sanitizedData.zipUrl = safeUrl(data.zipUrl);
    } else if (assignment.zipMode === SubmissionMode.REQUIRED) {
      throw new UnprocessableEntityError('ZIP submission is required for this assignment');
    }

    // Check URL field
    if (data.linkUrl && data.linkUrl.trim().length > 0) {
      if (assignment.urlMode === SubmissionMode.OFF) {
        throw new UnprocessableEntityError('URL submission is disabled for this assignment');
      }
      sanitizedData.linkUrl = safeUrl(data.linkUrl);
    } else if (assignment.urlMode === SubmissionMode.REQUIRED) {
      throw new UnprocessableEntityError('URL submission is required for this assignment');
    }

    // 5. Allocation Context & Initial Batch status check (SUB-22)
    const alloc = await this.getAllocationForCourse(
      menteeId,
      assignment.courseId,
      input.courseAllocationId,
      assignment.id,
    );

    if (
      alloc.batchStatus === BatchStatus.ON_HOLD ||
      alloc.batchStatus === BatchStatus.COMPLETED ||
      alloc.batchStatus === BatchStatus.ARCHIVED
    ) {
      throw new UnprocessableEntityError(
        `Submissions are blocked because the batch is ${alloc.batchStatus.toLowerCase()}`,
      );
    }

    // 6. Check late status and policy (FR-9.5, SUB-13, SUB-14)
    const now = new Date();
    const effectiveDueDate = alloc.overrideDueDate || alloc.dueDate;
    const isLate = now > effectiveDueDate;
    if (isLate && !assignment.allowLate) {
      throw new UnprocessableEntityError('Late submission is not allowed for this assignment');
    }

    // 7 & 8. Transactionally verify batch & latest submission status and persist (SUB-18 concurrency safe)
    let savedSubmission: Submission;
    try {
      savedSubmission = await submissionsRepository.transaction(async (manager) => {
        // Re-verify batch status inside transaction
        if (
          alloc.batchStatus === BatchStatus.ON_HOLD ||
          alloc.batchStatus === BatchStatus.COMPLETED ||
          alloc.batchStatus === BatchStatus.ARCHIVED
        ) {
          throw new UnprocessableEntityError(
            `Submissions are blocked because the batch is ${alloc.batchStatus.toLowerCase()}`,
          );
        }

        // Re-check latest submission inside transaction
        const latestSubmission = await submissionsRepository.findLatestSubmission(
          alloc.allocationId,
          assignment.id,
          manager,
        );

        let nextVersion = 1;
        if (latestSubmission) {
          if (latestSubmission.status === SubmissionStatus.GRADED) {
            throw new UnprocessableEntityError(
              'Cannot resubmit an assignment that has already been graded unless a resubmission is requested by the mentor',
            );
          }
          nextVersion = latestSubmission.version + 1;
        }

        const newSubmission = submissionsRepository.createSubmission({
          courseAllocationId: alloc.allocationId,
          assignmentId: assignment.id,
          batchId: alloc.batchId,
          version: nextVersion,
          submissionData: sanitizedData,
          submittedAt: now,
          isLate,
          status: SubmissionStatus.SUBMITTED,
          createdBy: menteeId,
        });

        return await submissionsRepository.saveSubmission(newSubmission, manager);
      });
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || '';
      const errorCode = (err as { code?: string })?.code;
      if (errorMsg.includes('uq_sub_version') || errorCode === '23505') {
        throw new ConflictError(
          'A submission for this assignment version was already submitted concurrently',
        );
      }
      throw err;
    }

    // 9. Send "submission received" email (FR-13.1, SUB-02)
    this.sendSubmissionEmailAsync(user, assignment, savedSubmission, alloc.batchId).catch(() => {});

    await logAudit({
      actorId: menteeId,
      type: AuditType.SUBMISSION,
      entity: 'Submission',
      entityId: savedSubmission.id,
      action: 'SUBMIT_ASSIGNMENT',
      newValue: {
        courseAllocationId: alloc.allocationId,
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        userName: user.name,
        version: savedSubmission.version,
        isLate: savedSubmission.isLate,
      },
    });

    return savedSubmission;
  }

  private async sendSubmissionEmailAsync(
    mentee: User,
    assignment: Assignment,
    submission: Submission,
    batchId: string | null,
  ): Promise<void> {
    try {
      let recipientEmail = 'admin@TechEniac.com';
      let recipientName = 'Super Admin';

      if (batchId) {
        const mapping = await submissionsRepository.findMentorMapping(batchId, mentee.id);
        if (mapping?.mentor?.email) {
          recipientEmail = mapping.mentor.email;
          recipientName = mapping.mentor.name;
        }
      }

      await emailService.sendSubmissionReceivedEmail({
        to: recipientEmail,
        recipientName,
        menteeName: mentee.name,
        assignmentTitle: assignment.title,
        courseTitle: assignment.course?.title || 'Course',
        version: submission.version,
        submittedAt: submission.submittedAt,
      });
    } catch (err: unknown) {
      logger.error(
        { err, submissionId: submission.id },
        '[SubmissionsService] Failed to send submission received email notification',
      );
    }
  }

  public async getAllocationForCourse(
    menteeId: string,
    courseId: string,
    requestedAllocationId?: string,
    assignmentId?: string,
  ): Promise<AllocationContext> {
    let allocation: CourseAllocation | null = null;
    try {
      allocation = await submissionsRepository.findCourseAllocation(
        menteeId,
        courseId,
        requestedAllocationId,
      );
    } catch (err: unknown) {
      logger.error(
        { err, menteeId, courseId, requestedAllocationId },
        '[SubmissionsService] Failed to query course allocation',
      );
      throw err;
    }

    if (!allocation) {
      throw new ForbiddenError(
        'You are not enrolled in this course or your allocation is inactive',
      );
    }

    const batch = allocation.batch || null;
    const batchId = allocation.batchId || null;
    const batchStatus = batch?.status || BatchStatus.LIVE;
    const isBatchActive = batch ? batch.status === BatchStatus.LIVE : true;

    let overrideDueDate: Date | null = null;
    if (assignmentId && allocation.assignmentOverrides) {
      const override = allocation.assignmentOverrides.find((o) => o.assignmentId === assignmentId);
      if (override) {
        overrideDueDate = override.dueDate;
      }
    }

    const effectiveDueDate = overrideDueDate || allocation.dueDate;

    return {
      allocationId: allocation.id,
      courseId: allocation.courseId,
      batchId,
      menteeId: allocation.userId,
      dueDate: effectiveDueDate,
      batchStatus,
      isBatchActive,
      overrideDueDate,
    };
  }

  public async getMenteeAllocations(menteeId: string): Promise<AllocationContext[]> {
    let allocations: CourseAllocation[] = [];
    try {
      allocations = await submissionsRepository.findOpenCourseAllocationsForMentee(menteeId);
    } catch (err: unknown) {
      logger.error(
        { err, menteeId },
        '[SubmissionsService] Failed to query mentee course allocations',
      );
      throw err;
    }

    return allocations.map((allocation) => {
      const batch = allocation.batch || null;
      const batchId = allocation.batchId || null;
      const batchStatus = batch?.status || BatchStatus.LIVE;
      const isBatchActive = batch ? batch.status === BatchStatus.LIVE : true;

      const assignmentOverrides: Record<string, string> = {};
      if (allocation.assignmentOverrides) {
        for (const override of allocation.assignmentOverrides) {
          assignmentOverrides[override.assignmentId] = override.dueDate.toISOString();
        }
      }

      return {
        allocationId: allocation.id,
        courseId: allocation.courseId,
        batchId,
        menteeId: allocation.userId,
        dueDate: allocation.dueDate,
        batchStatus,
        isBatchActive,
        assignmentOverrides,
      };
    });
  }
}

export const submissionsService = new SubmissionsService();
