import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AuthenticatedUser } from '../../src/core/auth';
import { calculateGradeLabel } from '../../src/core/config/grade-scale';
import { AppDataSource } from '../../src/core/db';
import { emailService } from '../../src/core/email';
import { ForbiddenError, UnprocessableEntityError, ValidationError } from '../../src/core/errors';
import { CourseAllocation } from '../../src/modules/allocations';
import { MentorMentee } from '../../src/modules/batches';
import { Assignment } from '../../src/modules/courses';
import {
  GradingPolicy,
  gradingRepository,
  gradingService,
  Submission,
  submissionQueueQuerySchema,
  SubmissionStatus,
} from '../../src/modules/submissions';
import { User, UserRole } from '../../src/modules/users';

const createTestUser = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@TechEniac.com',
  role: UserRole.SUPER_ADMIN,
  mustChangePassword: false,
  tokenVersion: 1,
  ...overrides,
});

void describe('Module 10: Submission Queue, Review & Grading Unit Tests (REV-01 to REV-22)', () => {
  let policy: GradingPolicy;

  const superAdmin = createTestUser({ id: 'admin-1', role: UserRole.SUPER_ADMIN });
  const mentorA = createTestUser({ id: 'mentor-1', role: UserRole.MENTOR });
  const mentorB = createTestUser({ id: 'mentor-2', role: UserRole.MENTOR });

  const mockMenteeUser = {
    id: 'mentee-1',
    name: 'Mentee Alice',
    email: 'alice@TechEniac.com',
  } as User;

  const mockAssignment = {
    id: 'assign-1',
    title: 'Final Project',
    maxMarks: 100,
    passMarks: 50,
    instructions: 'Build a full stack app',
    courseId: 'course-1',
    course: { id: 'course-1', title: 'Web Development' },
    topicId: 'topic-1',
    topic: { id: 'topic-1', title: 'React Basics' },
  } as unknown as Assignment;

  const mockAllocation = {
    id: 'alloc-1',
    userId: 'mentee-1',
    courseId: 'course-1',
    user: mockMenteeUser,
  } as unknown as CourseAllocation;

  const createSubmissionRow = (overrides: Partial<Submission> = {}): Submission =>
    ({
      id: 'sub-1',
      courseAllocationId: 'alloc-1',
      assignmentId: 'assign-1',
      batchId: 'batch-1',
      version: 2,
      submissionData: { linkUrl: 'https://github.com/alice/project' },
      submittedAt: new Date('2026-10-28T10:00:00Z'),
      isLate: false,
      status: SubmissionStatus.SUBMITTED,
      marks: null,
      gradeLabel: null,
      feedback: null,
      gradedBy: null,
      gradedAt: null,
      assignment: mockAssignment,
      courseAllocation: mockAllocation,
      ...overrides,
    }) as unknown as Submission;

  beforeEach(() => {
    policy = new GradingPolicy();
  });

  void describe('Grade Scale Calculation (PRD Section 2.1 & Line 358)', () => {
    void it('correctly assigns letter grades across standard percentage boundaries', () => {
      assert.equal(calculateGradeLabel(95, 100), 'A+');
      assert.equal(calculateGradeLabel(90, 100), 'A+');
      assert.equal(calculateGradeLabel(89, 100), 'A');
      assert.equal(calculateGradeLabel(80, 100), 'A');
      assert.equal(calculateGradeLabel(75, 100), 'B');
      assert.equal(calculateGradeLabel(65, 100), 'C');
      assert.equal(calculateGradeLabel(55, 100), 'D');
      assert.equal(calculateGradeLabel(45, 100), 'F');
      assert.equal(calculateGradeLabel(0, 100), 'F');
    });

    void it('handles arbitrary max marks proportionally', () => {
      assert.equal(calculateGradeLabel(45, 50), 'A+'); // 90%
      assert.equal(calculateGradeLabel(40, 50), 'A'); // 80%
      assert.equal(calculateGradeLabel(25, 50), 'D'); // 50%
      assert.equal(calculateGradeLabel(20, 50), 'F'); // 40%
    });

    void it('returns F safely if maxMarks is non-positive', () => {
      assert.equal(calculateGradeLabel(10, 0), 'F');
      assert.equal(calculateGradeLabel(10, -5), 'F');
    });
  });

  void describe('Mentor Scoping & Review Permissions (REV-10, REV-11, REV-14, REV-16, REV-17, REV-20)', () => {
    void it('REV-11: Super Admin can review any submission regardless of batch or mapping', async () => {
      const sub = createSubmissionRow({ batchId: null });
      await assert.doesNotReject(async () => {
        await policy.assertCanReviewSubmission(superAdmin, sub, 'mentee-1');
      });
    });

    void it('REV-20: Mentor cannot review submissions with no batch (unbatched allocation routes to Super Admin)', async () => {
      const sub = createSubmissionRow({ batchId: null });
      await assert.rejects(
        async () => {
          await policy.assertCanReviewSubmission(mentorA, sub, 'mentee-1');
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /no assigned batch and is reviewable only by Super Admin/);
          return true;
        },
      );
    });

    void it('REV-10 / REV-16: Mentor cannot review submissions of mentees mapped to another mentor', async () => {
      const sub = createSubmissionRow({ batchId: 'batch-1' });
      // MentorMentee mapping only exists for mentorA, not mentorB
      await assert.rejects(
        async () => {
          await policy.assertCanReviewSubmission(mentorB, sub, 'mentee-1');
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          return true;
        },
      );
    });
  });

  void describe('Grading Rules & Version Locking (REV-07, REV-08, REV-09, REV-13, REV-22)', () => {
    void it('REV-08: rejects marks that exceed maximum marks or are negative', () => {
      const sub = createSubmissionRow({ version: 3 });
      assert.throws(
        () => policy.assertCanGrade(sub, 3, 105, 100),
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /Marks must be between 0 and the assignment maximum marks/);
          return true;
        },
      );

      assert.throws(
        () => policy.assertCanGrade(sub, 3, -1, 100),
        (err: unknown) => {
          assert(err instanceof ValidationError);
          return true;
        },
      );
    });

    void it('REV-22: blocks grading a past submission version when a newer version exists', () => {
      const sub = createSubmissionRow({ version: 1 });
      const latestVersion = 2; // mentee resubmitted to version 2

      assert.throws(
        () => policy.assertCanGrade(sub, latestVersion, 85, 100),
        (err: unknown) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /Only the latest submission version \(2\) can be graded/);
          return true;
        },
      );
    });

    void it('REV-22: blocks requesting resubmission on an outdated version', () => {
      const sub = createSubmissionRow({ version: 1 });
      const latestVersion = 3;

      assert.throws(
        () => policy.assertCanRequestResubmission(sub, latestVersion),
        (err: unknown) => {
          assert(err instanceof UnprocessableEntityError);
          assert.match(err.message, /Only the latest submission version/);
          return true;
        },
      );
    });

    void it('allows grading and resubmission requests on the latest version', () => {
      const sub = createSubmissionRow({ version: 2 });
      assert.doesNotThrow(() => policy.assertCanGrade(sub, 2, 85, 100));
      assert.doesNotThrow(() => policy.assertCanRequestResubmission(sub, 2));
    });
  });

  void describe('GradingService Orchestration & Concurrency Safety', () => {
    let originalTransaction: typeof AppDataSource.transaction;
    let originalLockAndFind: typeof gradingRepository.lockAndFindSubmission;
    let originalFindAllocation: typeof gradingRepository.findAllocationWithMentee;
    let originalFindLatestVersion: typeof gradingRepository.findLatestVersionNumber;
    let originalUpdateFields: typeof gradingRepository.updateGradingFields;
    let originalSendGradedEmail: typeof emailService.sendAssignmentGradedEmail;
    let originalSendResubmitEmail: typeof emailService.sendResubmissionRequestedEmail;
    let originalFindActiveMappings: typeof gradingRepository.findActiveMappingsForMentor;
    let originalGetSubmissionQueue: typeof gradingRepository.getSubmissionQueue;

    beforeEach(() => {
      originalTransaction = AppDataSource.transaction.bind(AppDataSource);
      originalLockAndFind = gradingRepository.lockAndFindSubmission.bind(gradingRepository);
      originalFindAllocation = gradingRepository.findAllocationWithMentee.bind(gradingRepository);
      originalFindLatestVersion = gradingRepository.findLatestVersionNumber.bind(gradingRepository);
      originalUpdateFields = gradingRepository.updateGradingFields.bind(gradingRepository);
      originalSendGradedEmail = emailService.sendAssignmentGradedEmail.bind(emailService);
      originalSendResubmitEmail = emailService.sendResubmissionRequestedEmail.bind(emailService);
      originalFindActiveMappings =
        gradingRepository.findActiveMappingsForMentor.bind(gradingRepository);
      originalGetSubmissionQueue = gradingRepository.getSubmissionQueue.bind(gradingRepository);
    });

    afterEach(() => {
      AppDataSource.transaction = originalTransaction;
      gradingRepository.lockAndFindSubmission = originalLockAndFind;
      gradingRepository.findAllocationWithMentee = originalFindAllocation;
      gradingRepository.findLatestVersionNumber = originalFindLatestVersion;
      gradingRepository.updateGradingFields = originalUpdateFields;
      emailService.sendAssignmentGradedEmail = originalSendGradedEmail;
      emailService.sendResubmissionRequestedEmail = originalSendResubmitEmail;
      gradingRepository.findActiveMappingsForMentor = originalFindActiveMappings;
      gradingRepository.getSubmissionQueue = originalGetSubmissionQueue;
    });

    void it('gradeSubmission executes within transaction, updates fields, and dispatches email', async () => {
      let transactionExecuted = false;
      let updatedPayload: Partial<Submission> | null = null;
      let emailDispatched = false;

      // Mock transaction runner
      AppDataSource.transaction = ((runInTx: (m: unknown) => Promise<unknown>) => {
        transactionExecuted = true;
        return runInTx({});
      }) as typeof AppDataSource.transaction;

      const mockSub = createSubmissionRow({
        id: 'sub-test-1',
        version: 1,
        status: SubmissionStatus.SUBMITTED,
        marks: null,
        gradeLabel: null,
      });

      const mockAlloc = {
        id: 'alloc-1',
        userId: 'mentee-1',
        user: { id: 'mentee-1', name: 'Mentee Alice', email: 'alice@TechEniac.com' } as User,
      } as unknown as CourseAllocation;

      gradingRepository.lockAndFindSubmission = () => Promise.resolve(mockSub);
      gradingRepository.findAllocationWithMentee = () => Promise.resolve(mockAlloc);
      gradingRepository.findLatestVersionNumber = () => Promise.resolve(1);
      gradingRepository.updateGradingFields = (_id, fields) => {
        updatedPayload = fields;
        return Promise.resolve();
      };

      emailService.sendAssignmentGradedEmail = (opts) => {
        emailDispatched = true;
        assert.equal(opts.marks, 90);
        assert.equal(opts.gradeLabel, 'A+');
        assert.equal(opts.to, 'alice@TechEniac.com');
        return Promise.resolve();
      };

      const result = await gradingService.gradeSubmission(
        'sub-test-1',
        { marks: 90, feedback: 'Well done' },
        superAdmin,
      );

      assert.equal(transactionExecuted, true);
      assert.notEqual(updatedPayload, null);
      assert.equal(updatedPayload?.marks, 90);
      assert.equal(updatedPayload?.gradeLabel, 'A+');
      assert.equal(updatedPayload?.status, SubmissionStatus.GRADED);
      assert.equal(result.grading.marks, 90);
      assert.equal(result.grading.gradeLabel, 'A+');
      assert.equal(emailDispatched, true);
    });

    void it('requestResubmission clears marks/gradeLabel, sets RESUBMIT_REQUESTED, and dispatches email', async () => {
      let updatedPayload: Partial<Submission> | null = null;
      let emailDispatched = false;

      AppDataSource.transaction = ((runInTx: (m: unknown) => Promise<unknown>) => {
        return runInTx({});
      }) as typeof AppDataSource.transaction;

      // Simulating a submission that was previously GRADED with 85 / B
      const mockSub = createSubmissionRow({
        id: 'sub-test-2',
        version: 1,
        status: SubmissionStatus.GRADED,
        marks: 85,
        gradeLabel: 'B',
      });

      const mockAlloc = {
        id: 'alloc-1',
        userId: 'mentee-1',
        user: { id: 'mentee-1', name: 'Mentee Alice', email: 'alice@TechEniac.com' } as User,
      } as unknown as CourseAllocation;

      gradingRepository.lockAndFindSubmission = () => Promise.resolve(mockSub);
      gradingRepository.findAllocationWithMentee = () => Promise.resolve(mockAlloc);
      gradingRepository.findLatestVersionNumber = () => Promise.resolve(1);
      gradingRepository.updateGradingFields = (_id, fields) => {
        updatedPayload = fields;
        return Promise.resolve();
      };

      emailService.sendResubmissionRequestedEmail = (opts) => {
        emailDispatched = true;
        assert.equal(opts.feedback, 'Please fix tests');
        assert.equal(opts.to, 'alice@TechEniac.com');
        return Promise.resolve();
      };

      const result = await gradingService.requestResubmission(
        'sub-test-2',
        { feedback: 'Please fix tests' },
        superAdmin,
      );

      assert.notEqual(updatedPayload, null);
      assert.equal(updatedPayload?.status, SubmissionStatus.RESUBMIT_REQUESTED);
      // Verify marks and gradeLabel are explicitly reset to null (REV-13 fix)
      assert.equal(updatedPayload?.marks, null);
      assert.equal(updatedPayload?.gradeLabel, null);
      assert.equal(result.grading.marks, null);
      assert.equal(result.grading.gradeLabel, null);
      assert.equal(emailDispatched, true);
    });

    void it('getSubmissionQueue for MENTOR returns empty queue immediately if no mappings exist', async () => {
      let queueQueryCalled = false;

      gradingRepository.findActiveMappingsForMentor = () => Promise.resolve([]);
      gradingRepository.getSubmissionQueue = () => {
        queueQueryCalled = true;
        return Promise.resolve({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 });
      };

      const result = await gradingService.getSubmissionQueue(
        { page: 1, limit: 20, sort: 'latest' },
        mentorA,
      );

      assert.equal(queueQueryCalled, false);
      assert.equal(result.items.length, 0);
      assert.equal(result.total, 0);
    });

    void it('getSubmissionQueue for MENTOR passes allowed pairs when mappings exist', async () => {
      let passedAllowedPairs: unknown = null;

      gradingRepository.findActiveMappingsForMentor = () =>
        Promise.resolve([{ batchId: 'batch-1', menteeId: 'mentee-1' } as MentorMentee]);
      gradingRepository.getSubmissionQueue = (_q, _role, _id, allowedPairs) => {
        passedAllowedPairs = allowedPairs;
        return Promise.resolve({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 });
      };

      await gradingService.getSubmissionQueue({ page: 1, limit: 20, sort: 'latest' }, mentorA);

      assert.deepEqual(passedAllowedPairs, [{ batchId: 'batch-1', menteeId: 'mentee-1' }]);
    });

    void it('defaults pagination limit to 10 in submissionQueueQuerySchema', () => {
      const parsed = submissionQueueQuerySchema.shape.query.parse({});
      assert.equal(parsed.limit, 10);
      assert.equal(parsed.page, 1);
    });
  });
});
