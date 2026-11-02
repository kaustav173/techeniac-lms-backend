import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '../../src/core/errors';
import { CourseAllocation, CourseAllocationStatus } from '../../src/modules/allocations';
import { Batch, BatchMember, BatchStatus } from '../../src/modules/batches';
import { Assignment, AssignmentScope, Course, SubmissionMode } from '../../src/modules/courses';
import {
  Submission,
  submissionsRepository,
  SubmissionsService,
  SubmissionStatus,
} from '../../src/modules/submissions';
import { User, UserRole } from '../../src/modules/users';

void describe('SubmissionsService Unit Tests (Module 9)', () => {
  let service: SubmissionsService;

  const menteeId = '11111111-1111-4111-a111-111111111111';
  const courseId = '22222222-2222-4222-a222-222222222222';
  const assignmentId = '33333333-3333-4333-a333-333333333333';
  const allocationId = '44444444-4444-4444-a444-444444444444';
  const batchId = '55555555-5555-4555-a555-555555555555';

  const baseUser: User = {
    id: menteeId,
    email: 'mentee@TechEniac.com',
    name: 'Mentee Raj',
    role: UserRole.MENTEE,
    isActive: true,
  } as User;

  const baseCourse: Course = {
    id: courseId,
    title: 'TypeScript Advanced',
  } as Course;

  const baseBatch: Batch = {
    id: batchId,
    name: 'Batch Alpha',
    status: BatchStatus.LIVE,
  } as Batch;

  const baseAssignment: Assignment = {
    id: assignmentId,
    courseId,
    topicId: null,
    scope: AssignmentScope.COURSE,
    displayOrder: 1,
    title: 'Final Capstone Project',
    instructions: 'Submit GitHub repository URL',
    estimatedMinutes: 120,
    maxMarks: 100,
    passMarks: 50,
    allowLate: true,
    pdfMode: SubmissionMode.OPTIONAL,
    zipMode: SubmissionMode.OPTIONAL,
    urlMode: SubmissionMode.REQUIRED,
    resources: null,
    course: baseCourse,
  } as Assignment;

  const baseAllocation: CourseAllocation = {
    id: allocationId,
    userId: menteeId,
    courseId,
    batchId,
    status: CourseAllocationStatus.IN_PROGRESS,
    startDate: new Date(),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    progressPercent: 0,
    batch: baseBatch,
    course: baseCourse,
    assignmentOverrides: [],
  } as unknown as CourseAllocation;

  beforeEach(() => {
    service = new SubmissionsService();

    // Default repository stubs
    submissionsRepository.findCourseAllocation = () => {
      return Promise.resolve(baseAllocation);
    };

    submissionsRepository.findOpenCourseAllocationsForMentee = () => {
      return Promise.resolve([baseAllocation]);
    };

    submissionsRepository.findAssignmentById = (id) => {
      if (id === assignmentId) return Promise.resolve(baseAssignment);
      return Promise.resolve(null);
    };

    submissionsRepository.findLatestSubmission = () => {
      return Promise.resolve(null);
    };

    submissionsRepository.findSubmissionsForAllocationAndAssignment = () => {
      return Promise.resolve([]);
    };

    submissionsRepository.findSubmissionsByAllocationsAndAssignments = () => {
      return Promise.resolve([]);
    };

    submissionsRepository.findAssignmentsByCourseIds = () => {
      return Promise.resolve([baseAssignment]);
    };

    submissionsRepository.findActiveBatchMember = () => {
      return Promise.resolve({
        id: 'bm-1',
        batchId,
        userId: menteeId,
        batch: baseBatch,
      } as BatchMember);
    };

    submissionsRepository.findUserById = (id) => {
      if (id === menteeId) return Promise.resolve(baseUser);
      return Promise.resolve(null);
    };

    submissionsRepository.findMentorMapping = () => {
      return Promise.resolve(null);
    };

    submissionsRepository.saveSubmission = (sub) => {
      const created = Object.assign(new Submission(), sub, { id: 'sub-new-1' });
      return Promise.resolve(created);
    };
  });

  void describe('Allocation Resolution & Overrides (getAllocationForCourse)', () => {
    void it('resolves active allocation and maps batchStatus accurately', async () => {
      const ctx = await service.getAllocationForCourse(menteeId, courseId);
      assert.equal(ctx.allocationId, allocationId);
      assert.equal(ctx.batchStatus, BatchStatus.LIVE);
      assert.equal(ctx.isBatchActive, true);
    });

    void it('applies assignment-specific due date override when present', async () => {
      const overrideDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const allocWithOverride = {
        ...baseAllocation,
        assignmentOverrides: [
          {
            assignmentId,
            dueDate: overrideDate,
          },
        ],
      } as unknown as CourseAllocation;

      submissionsRepository.findCourseAllocation = () => Promise.resolve(allocWithOverride);

      const ctx = await service.getAllocationForCourse(menteeId, courseId, undefined, assignmentId);
      assert.equal(ctx.overrideDueDate?.getTime(), overrideDate.getTime());
    });

    void it('throws ForbiddenError when mentee is not enrolled in the course (fail-closed)', async () => {
      submissionsRepository.findCourseAllocation = () => Promise.resolve(null);

      await assert.rejects(
        () => service.getAllocationForCourse(menteeId, courseId),
        (err: Error) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /not enrolled/);
          return true;
        },
      );
    });

    void it('throws ForbiddenError when requested allocation does not belong to mentee (IDOR guard)', async () => {
      submissionsRepository.findCourseAllocation = (_uId, _cId, reqId) => {
        if (reqId === 'foreign-alloc-id') return Promise.resolve(null);
        return Promise.resolve(baseAllocation);
      };

      await assert.rejects(
        () => service.getAllocationForCourse(menteeId, courseId, 'foreign-alloc-id'),
        (err: Error) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /not enrolled/);
          return true;
        },
      );
    });
  });

  void describe('Derived Status Aggregations (getMyAssignments)', () => {
    void it('returns PENDING when an assignment has no submissions and is before deadline', async () => {
      const result = await service.getMyAssignments(menteeId, {
        page: 1,
        limit: 20,
        status: 'ALL',
      });

      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.status, 'PENDING');
    });

    void it('returns OVERDUE when an assignment has no submissions, allows late, and is past deadline', async () => {
      const pastAllocation: CourseAllocation = {
        ...baseAllocation,
        dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
      };

      submissionsRepository.findOpenCourseAllocationsForMentee = () =>
        Promise.resolve([pastAllocation]);

      const result = await service.getMyAssignments(menteeId, {
        page: 1,
        limit: 20,
        status: 'ALL',
      });

      assert.equal(result.items[0]?.status, 'OVERDUE');
    });

    void it('returns CLOSED when an assignment is unsubmitted and batch is ON_HOLD (SUB-22)', async () => {
      const onHoldAllocation: CourseAllocation = {
        ...baseAllocation,
        batch: { id: batchId, name: 'Batch Alpha', status: BatchStatus.ON_HOLD } as Batch,
      };

      submissionsRepository.findOpenCourseAllocationsForMentee = () =>
        Promise.resolve([onHoldAllocation]);

      const result = await service.getMyAssignments(menteeId, {
        page: 1,
        limit: 20,
        status: 'ALL',
      });

      assert.equal(result.items[0]?.status, 'CLOSED');
    });

    void it('reflects latest submission status when submission exists', async () => {
      const sub = {
        id: 'sub-1',
        courseAllocationId: allocationId,
        assignmentId,
        version: 1,
        status: SubmissionStatus.SUBMITTED,
        submittedAt: new Date(),
      } as Submission;

      submissionsRepository.findSubmissionsByAllocationsAndAssignments = () =>
        Promise.resolve([sub]);

      const result = await service.getMyAssignments(menteeId, {
        page: 1,
        limit: 20,
        status: 'ALL',
      });

      assert.equal(result.items[0]?.status, 'SUBMITTED');
    });

    void it('paginates multiple assignments across pages in fast-path (status ALL)', async () => {
      const assignment2 = {
        ...baseAssignment,
        id: 'assign-2',
        title: 'Assignment 2',
      };
      submissionsRepository.findAssignmentsByCourseIds = () =>
        Promise.resolve([baseAssignment, assignment2]);

      const page1 = await service.getMyAssignments(menteeId, {
        page: 1,
        limit: 1,
        status: 'ALL',
      });

      assert.equal(page1.items.length, 1);
      assert.equal(page1.total, 2);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.page, 1);
      assert.equal(page1.items[0]?.id, assignmentId);

      const page2 = await service.getMyAssignments(menteeId, {
        page: 2,
        limit: 1,
        status: 'ALL',
      });

      assert.equal(page2.items.length, 1);
      assert.equal(page2.total, 2);
      assert.equal(page2.totalPages, 2);
      assert.equal(page2.page, 2);
      assert.equal(page2.items[0]?.id, 'assign-2');
    });
  });

  void describe('Submission Creation & Concurrency (submitAssignment)', () => {
    void it('throws UnprocessableEntityError when confirmedComplete is not true (SUB-06)', async () => {
      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: false,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /confirm you have completed/);
          return true;
        },
      );
    });

    void it('throws NotFoundError when assignment does not exist', async () => {
      submissionsRepository.findAssignmentById = () => Promise.resolve(null);

      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: true,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof NotFoundError);
          return true;
        },
      );
    });

    void it('blocks submission when batch is ON_HOLD (SUB-22)', async () => {
      const onHoldAllocation: CourseAllocation = {
        ...baseAllocation,
        batch: { id: batchId, name: 'Batch Alpha', status: BatchStatus.ON_HOLD } as Batch,
      };

      submissionsRepository.findCourseAllocation = () => Promise.resolve(onHoldAllocation);

      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: true,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /blocked because the batch is on_hold/);
          return true;
        },
      );
    });

    void it('blocks submission when late and allowLate is false (SUB-14)', async () => {
      const pastAllocation: CourseAllocation = {
        ...baseAllocation,
        dueDate: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      };

      const disallowLateAssignment = {
        ...baseAssignment,
        allowLate: false,
      } as Assignment;

      submissionsRepository.findCourseAllocation = () => Promise.resolve(pastAllocation);
      submissionsRepository.findAssignmentById = () => Promise.resolve(disallowLateAssignment);

      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: true,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /Late submission is not allowed/);
          return true;
        },
      );
    });

    void it('blocks resubmission when assignment is already GRADED (SUB-16)', async () => {
      const gradedSubmission = {
        id: 'sub-graded',
        version: 1,
        status: SubmissionStatus.GRADED,
      } as Submission;

      submissionsRepository.findLatestSubmission = () => Promise.resolve(gradedSubmission);

      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: true,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /already been graded/);
          return true;
        },
      );
    });

    void it('increments version to 2 on valid resubmission (SUB-15)', async () => {
      const previousSubmission = {
        id: 'sub-v1',
        version: 1,
        status: SubmissionStatus.SUBMITTED,
      } as Submission;

      submissionsRepository.findLatestSubmission = () => Promise.resolve(previousSubmission);

      let savedVersion = 0;
      submissionsRepository.saveSubmission = (sub) => {
        savedVersion = sub.version;
        return Promise.resolve(Object.assign(new Submission(), sub, { id: 'sub-v2' }));
      };

      const result = await service.submitAssignment(menteeId, {
        assignmentId,
        confirmedComplete: true,
        submissionData: { linkUrl: 'https://github.com/example/repo' },
      });

      assert.equal(result.version, 2);
      assert.equal(savedVersion, 2);
    });

    void it('converts concurrent version conflict (23505) into ConflictError (SUB-18)', async () => {
      submissionsRepository.saveSubmission = () => {
        const error = new Error('duplicate key value violates unique constraint "uq_sub_version"');
        (error as unknown as { code: string }).code = '23505';
        return Promise.reject(error);
      };

      await assert.rejects(
        () =>
          service.submitAssignment(menteeId, {
            assignmentId,
            confirmedComplete: true,
            submissionData: { linkUrl: 'https://github.com/example/repo' },
          }),
        (err: Error) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /submitted concurrently/);
          return true;
        },
      );
    });
  });
});
