import { logAudit } from '../../core/audit';
import type { AuthenticatedUser } from '../../core/auth';
import { calculateGradeLabel } from '../../core/config';
import { AppDataSource } from '../../core/db';
import { emailService } from '../../core/email';
import { NotFoundError } from '../../core/errors';
import { logger } from '../../core/logging';
import { type CourseAllocation } from '../allocations';
import { AuditType } from '../audit';
import { UserRole } from '../users';
import { Submission, SubmissionStatus } from './entities/submission.entity';
import { gradingPolicy } from './grading.policy';
import { gradingRepository, type PaginatedQueueResult } from './grading.repository';
import type {
  GradeSubmissionInput,
  RequestResubmissionInput,
  SubmissionQueueQuery,
} from './schemas/grading.schemas';

export interface SubmissionReviewDetails {
  id: string;
  courseAllocationId: string;
  assignmentId: string;
  assignmentTitle: string;
  instructions: string | null;
  maxMarks: number;
  passMarks: number;
  courseId: string;
  courseTitle: string;
  topicId: string | null;
  topicTitle: string | null;
  batchId: string | null;
  batchName: string | null;
  version: number;
  submittedAt: Date;
  isLate: boolean;
  status: SubmissionStatus;
  submissionData: {
    pdfUrl?: string | null;
    zipUrl?: string | null;
    linkUrl?: string | null;
  };
  mentee: {
    id: string;
    name: string;
    email: string;
  };
  grading: {
    marks: number | null;
    gradeLabel: string | null;
    feedback: string | null;
    gradedBy: string | null;
    gradedAt: Date | null;
  };
}

export class GradingService {
  async getSubmissionQueue(
    query: SubmissionQueueQuery,
    actor: AuthenticatedUser,
  ): Promise<PaginatedQueueResult> {
    const role = actor.role as UserRole;
    if (role === UserRole.MENTOR) {
      const mappings = await gradingRepository.findActiveMappingsForMentor(actor.id);
      if (mappings.length === 0) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        return {
          items: [],
          total: 0,
          page,
          limit,
          totalPages: 1,
        };
      }
      const allowedPairs = mappings.map((m) => ({ batchId: m.batchId, menteeId: m.menteeId }));
      return gradingRepository.getSubmissionQueue(query, UserRole.MENTOR, actor.id, allowedPairs);
    }

    return gradingRepository.getSubmissionQueue(query, role, actor.id);
  }

  async getReviewDetails(
    submissionId: string,
    actor: AuthenticatedUser,
  ): Promise<SubmissionReviewDetails> {
    const submission = await gradingRepository.findSubmissionById(submissionId);
    if (!submission) {
      throw new NotFoundError('Submission not found');
    }

    const allocation = await gradingRepository.findAllocationWithMentee(
      submission.courseAllocationId,
    );
    if (!allocation || !allocation.user) {
      throw new NotFoundError('Course allocation or mentee record not found');
    }

    await gradingPolicy.assertCanReviewSubmission(actor, submission, allocation.userId);

    return this.buildReviewDetailsDto(submission, allocation);
  }

  async gradeSubmission(
    submissionId: string,
    input: GradeSubmissionInput,
    actor: AuthenticatedUser,
  ): Promise<SubmissionReviewDetails> {
    let targetSubmission: Submission | null = null;
    let targetAllocation: CourseAllocation | null = null;
    let computedGradeLabel = '';
    let maxMarks = 100;
    let oldValues: {
      marks: number | null;
      gradeLabel: string | null;
      feedback: string | null;
      status: SubmissionStatus;
    } = { marks: null, gradeLabel: null, feedback: null, status: SubmissionStatus.SUBMITTED };

    try {
      await AppDataSource.transaction(async (manager) => {
        const submission = await gradingRepository.lockAndFindSubmission(submissionId, manager);
        if (!submission) {
          throw new NotFoundError('Submission not found');
        }

        const allocation = await gradingRepository.findAllocationWithMentee(
          submission.courseAllocationId,
          manager,
        );
        if (!allocation || !allocation.user) {
          throw new NotFoundError('Course allocation or mentee record not found');
        }

        await gradingPolicy.assertCanReviewSubmission(actor, submission, allocation.userId);

        const latestVersion = await gradingRepository.findLatestVersionNumber(
          submission.courseAllocationId,
          submission.assignmentId,
          manager,
        );
        maxMarks = Number(submission.assignment?.maxMarks ?? 100);

        gradingPolicy.assertCanGrade(
          submission,
          latestVersion ?? submission.version,
          input.marks,
          maxMarks,
        );

        computedGradeLabel = calculateGradeLabel(input.marks, maxMarks);

        oldValues = {
          marks: submission.marks !== null ? Number(submission.marks) : null,
          gradeLabel: submission.gradeLabel,
          feedback: submission.feedback,
          status: submission.status,
        };

        const now = new Date();
        const updatePayload: Partial<Submission> = {
          marks: input.marks,
          gradeLabel: computedGradeLabel,
          feedback: input.feedback ?? null,
          status: SubmissionStatus.GRADED,
          gradedBy: actor.id,
          gradedAt: now,
          updatedBy: actor.id,
        };

        await gradingRepository.updateGradingFields(submission.id, updatePayload, manager);

        Object.assign(submission, updatePayload);
        targetSubmission = submission;
        targetAllocation = allocation;
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          auditType: 'GRADING',
          action: 'GRADE_SUBMISSION_FAILED',
          submissionId,
          attemptedValues: { marks: input.marks, feedback: input.feedback },
        },
        'Failed to grade submission',
      );
      throw error;
    }

    if (!targetSubmission || !targetAllocation) {
      throw new NotFoundError('Submission not found');
    }

    const safeSubmission = targetSubmission as Submission;
    const safeAllocation = targetAllocation as CourseAllocation;

    // Post-commit audit logging: captures verified persisted state
    await logAudit({
      actorId: actor.id,
      type: AuditType.GRADING,
      entity: 'Submission',
      entityId: safeSubmission.id,
      action: 'GRADE_SUBMISSION',
      oldValue: oldValues,
      newValue: {
        marks: input.marks,
        gradeLabel: computedGradeLabel,
        feedback: input.feedback ?? null,
        status: SubmissionStatus.GRADED,
      },
    });

    logger.info(
      {
        auditType: 'GRADING',
        action: 'GRADE_SUBMISSION',
        submissionId: safeSubmission.id,
        gradedBy: actor.id,
        oldValues,
        newValues: {
          marks: input.marks,
          gradeLabel: computedGradeLabel,
          feedback: input.feedback ?? null,
          status: SubmissionStatus.GRADED,
        },
      },
      'Submission graded successfully',
    );

    // Dispatch graded notification email to mentee (non-blocking)
    const mentee = safeAllocation.user;
    if (mentee) {
      void emailService.sendAssignmentGradedEmail({
        to: mentee.email,
        recipientName: mentee.name || mentee.email || 'Mentee',
        assignmentTitle: safeSubmission.assignment?.title || 'Assignment',
        courseTitle: safeSubmission.assignment?.course?.title || 'Course',
        marks: input.marks,
        maxMarks,
        gradeLabel: computedGradeLabel,
        feedback: input.feedback,
      });
    }

    // Return DTO directly from verified updated data without re-querying
    return this.buildReviewDetailsDto(safeSubmission, safeAllocation);
  }

  async requestResubmission(
    submissionId: string,
    input: RequestResubmissionInput,
    actor: AuthenticatedUser,
  ): Promise<SubmissionReviewDetails> {
    let targetSubmission: Submission | null = null;
    let targetAllocation: CourseAllocation | null = null;
    let previousStatus: SubmissionStatus = SubmissionStatus.SUBMITTED;

    try {
      await AppDataSource.transaction(async (manager) => {
        const submission = await gradingRepository.lockAndFindSubmission(submissionId, manager);
        if (!submission) {
          throw new NotFoundError('Submission not found');
        }

        const allocation = await gradingRepository.findAllocationWithMentee(
          submission.courseAllocationId,
          manager,
        );
        if (!allocation || !allocation.user) {
          throw new NotFoundError('Course allocation or mentee record not found');
        }

        await gradingPolicy.assertCanReviewSubmission(actor, submission, allocation.userId);

        const latestVersion = await gradingRepository.findLatestVersionNumber(
          submission.courseAllocationId,
          submission.assignmentId,
          manager,
        );

        gradingPolicy.assertCanRequestResubmission(submission, latestVersion ?? submission.version);

        previousStatus = submission.status;
        const now = new Date();

        // When requesting resubmission on an already graded submission, explicitly clear marks
        // and gradeLabel so contradictory states cannot persist (REV-13)
        const updatePayload: Partial<Submission> = {
          status: SubmissionStatus.RESUBMIT_REQUESTED,
          marks: null,
          gradeLabel: null,
          feedback: input.feedback,
          gradedBy: actor.id,
          gradedAt: now,
          updatedBy: actor.id,
        };

        await gradingRepository.updateGradingFields(submission.id, updatePayload, manager);

        Object.assign(submission, updatePayload);
        targetSubmission = submission;
        targetAllocation = allocation;
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          auditType: 'GRADING',
          action: 'REQUEST_RESUBMISSION_FAILED',
          submissionId,
          attemptedValues: { feedback: input.feedback },
        },
        'Failed to request resubmission',
      );
      throw error;
    }

    if (!targetSubmission || !targetAllocation) {
      throw new NotFoundError('Submission not found');
    }

    const safeSubmission = targetSubmission as Submission;
    const safeAllocation = targetAllocation as CourseAllocation;

    // Post-commit audit logging
    await logAudit({
      actorId: actor.id,
      type: AuditType.GRADING,
      entity: 'Submission',
      entityId: safeSubmission.id,
      action: 'REQUEST_RESUBMISSION',
      oldValue: { status: previousStatus },
      newValue: {
        status: SubmissionStatus.RESUBMIT_REQUESTED,
        feedback: input.feedback,
      },
    });

    logger.info(
      {
        auditType: 'GRADING',
        action: 'REQUEST_RESUBMISSION',
        submissionId: safeSubmission.id,
        requestedBy: actor.id,
        previousStatus,
        feedback: input.feedback,
      },
      'Resubmission requested on submission',
    );

    const mentee = safeAllocation.user;
    if (mentee) {
      void emailService.sendResubmissionRequestedEmail({
        to: mentee.email,
        recipientName: mentee.name || mentee.email || 'Mentee',
        assignmentTitle: safeSubmission.assignment?.title || 'Assignment',
        courseTitle: safeSubmission.assignment?.course?.title || 'Course',
        feedback: input.feedback,
      });
    }

    return this.buildReviewDetailsDto(safeSubmission, safeAllocation);
  }

  private buildReviewDetailsDto(
    submission: Submission,
    allocation: CourseAllocation,
  ): SubmissionReviewDetails {
    const menteeName = allocation.user?.name || allocation.user?.email || '';

    return {
      id: submission.id,
      courseAllocationId: submission.courseAllocationId,
      assignmentId: submission.assignmentId,
      assignmentTitle: submission.assignment?.title || '',
      instructions: submission.assignment?.instructions || null,
      maxMarks: Number(submission.assignment?.maxMarks ?? 100),
      passMarks: Number(submission.assignment?.passMarks ?? 0),
      courseId: submission.assignment?.courseId || '',
      courseTitle: submission.assignment?.course?.title || '',
      topicId: submission.assignment?.topicId || null,
      topicTitle: submission.assignment?.topic?.title || null,
      batchId: submission.batchId,
      batchName: submission.batch?.name || null,
      version: submission.version,
      submittedAt: submission.submittedAt,
      isLate: submission.isLate,
      status: submission.status,
      submissionData: {
        pdfUrl: submission.submissionData?.pdfUrl || null,
        zipUrl: submission.submissionData?.zipUrl || null,
        linkUrl: submission.submissionData?.linkUrl || null,
      },
      mentee: {
        id: allocation.userId,
        name: menteeName,
        email: allocation.user?.email || '',
      },
      grading: {
        marks: submission.marks !== null ? Number(submission.marks) : null,
        gradeLabel: submission.gradeLabel,
        feedback: submission.feedback,
        gradedBy: submission.gradedBy,
        gradedAt: submission.gradedAt,
      },
    };
  }
}

export const gradingService = new GradingService();
