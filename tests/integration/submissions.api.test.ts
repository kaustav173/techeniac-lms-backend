import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { CourseAllocation, CourseAllocationStatus } from '../../src/modules/allocations';
import { Batch, BatchMember, BatchStatus } from '../../src/modules/batches';
import { Assignment, AssignmentScope, Course, SubmissionMode } from '../../src/modules/courses';
import {
  gradingRepository,
  Submission,
  submissionsRepository,
  SubmissionStatus,
} from '../../src/modules/submissions';
import { User, userRepository, UserRole } from '../../src/modules/users';

void describe('Submissions API Integration Tests (Module 9)', () => {
  let server: Server;
  let baseUrl: string;

  const menteeId = '11111111-1111-4111-a111-111111111111';
  const nonMenteeId = '33333333-3333-4333-a333-333333333333';
  const courseId = '44444444-4444-4444-a444-444444444444';
  const assignmentId = '55555555-5555-4555-a555-555555555555';
  const allocationId = '66666666-6666-4666-a666-666666666666';
  const superAdminId = '99999999-9999-4999-a999-999999999999';

  let tokenMentee: string;
  let tokenNonMentee: string;
  let tokenSuperAdmin: string;

  before(async () => {
    tokenSuperAdmin = signAccessToken({
      sub: superAdminId,
      email: 'admin@TechEniac.com',
      role: 'SUPER_ADMIN',
      tokenVersion: 1,
    });
    tokenMentee = signAccessToken({
      sub: menteeId,
      email: 'mentee@TechEniac.com',
      role: 'MENTEE',
      tokenVersion: 1,
    });

    tokenNonMentee = signAccessToken({
      sub: nonMenteeId,
      email: 'mentor@TechEniac.com',
      role: 'MENTOR',
      tokenVersion: 1,
    });

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 4000;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  after(() => {
    server.close();
  });

  const baseAssignment = {
    id: assignmentId,
    courseId,
    topicId: null,
    scope: AssignmentScope.COURSE,
    displayOrder: 1,
    title: 'Final Project Submission',
    instructions: 'Submit project links',
    estimatedMinutes: 120,
    maxMarks: 100,
    passMarks: 50,
    allowLate: true,
    pdfMode: SubmissionMode.OPTIONAL,
    zipMode: SubmissionMode.OPTIONAL,
    urlMode: SubmissionMode.OPTIONAL,
    resources: null,
    course: { id: courseId, title: 'Node.js Mastery' } as Course,
  } as Assignment;

  const baseAllocation = {
    id: allocationId,
    courseId,
    userId: menteeId,
    status: CourseAllocationStatus.IN_PROGRESS,
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    startDate: new Date(),
    progressPercent: 0,
    batchId: 'batch-1',
    batch: { id: 'batch-1', status: BatchStatus.LIVE } as Batch,
    course: { id: courseId, title: 'Node.js Mastery' } as Course,
    assignmentOverrides: [],
  } as unknown as CourseAllocation;

  beforeEach(() => {
    // Stub course allocation resolution
    submissionsRepository.findCourseAllocation = (uId, cId, reqAllocId) => {
      if (uId === menteeId && cId === courseId && (!reqAllocId || reqAllocId === allocationId)) {
        return Promise.resolve(baseAllocation);
      }
      return Promise.resolve(null);
    };

    submissionsRepository.findOpenCourseAllocationsForMentee = (uId) => {
      if (uId === menteeId) {
        return Promise.resolve([baseAllocation]);
      }
      return Promise.resolve([]);
    };

    // Stub user resolution
    userRepository.findById = (id: string): Promise<User | null> => {
      if (id === superAdminId) {
        return Promise.resolve({
          id: superAdminId,
          email: 'admin@TechEniac.com',
          name: 'Super Admin',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === menteeId) {
        return Promise.resolve({
          id: menteeId,
          email: 'mentee@TechEniac.com',
          name: 'Raj Mentee',
          role: UserRole.MENTEE,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === nonMenteeId) {
        return Promise.resolve({
          id: nonMenteeId,
          email: 'mentor@TechEniac.com',
          name: 'Kaustav Mentor',
          role: UserRole.MENTOR,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === '99999999-9999-4999-a999-999999999999') {
        return Promise.resolve({
          id: '99999999-9999-4999-a999-999999999999',
          email: 'admin@TechEniac.com',
          name: 'Super Admin',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      return Promise.resolve(null);
    };

    submissionsRepository.findUserById = (id: string) => userRepository.findById(id);

    // Default repository stubs
    submissionsRepository.findAssignmentById = () => Promise.resolve(baseAssignment);

    submissionsRepository.findLatestSubmission = () => Promise.resolve(null);

    submissionsRepository.saveSubmission = (sub: Submission) =>
      Promise.resolve({
        ...sub,
        id: '77777777-7777-4777-a777-777777777777',
      });

    submissionsRepository.findActiveBatchMember = () =>
      Promise.resolve({
        userId: menteeId,
        isActive: true,
        batch: { id: 'batch-1', status: BatchStatus.LIVE },
      } as unknown as BatchMember);

    submissionsRepository.findActiveCourses = () =>
      Promise.resolve([baseAssignment.course as Course]);

    submissionsRepository.findMentorMapping = () => Promise.resolve(null);
  });

  void describe('Access Control & Roles (SUB-21)', () => {
    void it('rejects non-mentee with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/submissions/my-assignments`, {
        headers: { Authorization: `Bearer ${tokenNonMentee}` },
      });
      assert.equal(res.status, 403);
    });

    void it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/submissions/my-assignments`);
      assert.equal(res.status, 401);
    });

    void it('rejects submission with 403 Forbidden when mentee is not enrolled (fail-closed)', async () => {
      submissionsRepository.findCourseAllocation = () => Promise.resolve(null);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work' },
        }),
      });

      assert.equal(res.status, 403);
    });
  });

  void describe('Dynamic Modes & Field Validation (SUB-02–07, SUB-24–26, VAL-14, VAL-20)', () => {
    void it('SUB-02: accepts PDF submission when PDF mode is enabled', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            pdfUrl: 'https://example.com/report.pdf',
          },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.version, 1);
      assert.equal(json.data.status, SubmissionStatus.SUBMITTED);
      assert.equal(json.data.submissionData.pdfUrl, 'https://example.com/report.pdf');
    });

    void it('SUB-03: accepts ZIP submission only', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            zipUrl: 'https://example.com/code.zip',
          },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.submissionData.zipUrl, 'https://example.com/code.zip');
    });

    void it('SUB-04: accepts URL submission only', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            linkUrl: 'https://github.com/TechEniac/lms',
          },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.submissionData.linkUrl, 'https://github.com/TechEniac/lms');
    });

    void it('SUB-05: accepts PDF + ZIP + URL together', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            pdfUrl: 'https://example.com/report.pdf',
            zipUrl: 'https://example.com/code.zip',
            linkUrl: 'https://github.com/TechEniac/lms',
          },
        }),
      });

      assert.equal(res.status, 201);
    });

    void it('SUB-06: rejects submission without ticking confirmation checkbox', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: false,
          submissionData: {
            linkUrl: 'https://example.com/work',
          },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(json.error.message, /confirm you have completed/i);
    });

    void it('SUB-07: rejects submission with no fields provided', async () => {
      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            linkUrl: '',
            pdfUrl: '',
          },
        }),
      });

      assert.equal(res.status, 400); // Zod refine rejection
    });

    void it('VAL-14 / SUB-24: rejects field when mode is OFF', async () => {
      submissionsRepository.findAssignmentById = () =>
        Promise.resolve({
          ...baseAssignment,
          pdfMode: SubmissionMode.OFF,
          urlMode: SubmissionMode.REQUIRED,
        } as Assignment);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            pdfUrl: 'https://example.com/unallowed.pdf',
            linkUrl: 'https://github.com/work',
          },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(json.error.message, /PDF submission is disabled/i);
    });

    void it('SUB-25: rejects when required field is empty', async () => {
      submissionsRepository.findAssignmentById = () =>
        Promise.resolve({
          ...baseAssignment,
          pdfMode: SubmissionMode.REQUIRED,
          urlMode: SubmissionMode.OPTIONAL,
        } as Assignment);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            linkUrl: 'https://github.com/work',
          },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(json.error.message, /PDF submission is required/i);
    });

    void it('VAL-20: rejects javascript: and credentialed URLs', async () => {
      const resJs = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            linkUrl: 'javascript:alert(1)',
          },
        }),
      });
      assert.equal(resJs.status, 422);

      const resCreds = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: {
            linkUrl: 'https://user:password@github.com/repo',
          },
        }),
      });
      assert.equal(resCreds.status, 422);
    });
  });

  void describe('Late Policies (SUB-13, SUB-14)', () => {
    void it('SUB-13: marks is_late true when submitted after deadline and late is allowed', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      submissionsRepository.findCourseAllocation = () =>
        Promise.resolve({
          ...baseAllocation,
          dueDate: pastDate,
        });

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          courseAllocationId: allocationId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work' },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.isLate, true);
    });

    void it('SUB-14: blocks late submission when allow_late is false', async () => {
      submissionsRepository.findAssignmentById = () =>
        Promise.resolve({
          ...baseAssignment,
          allowLate: false,
        } as Assignment);

      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      submissionsRepository.findCourseAllocation = () =>
        Promise.resolve({
          ...baseAllocation,
          dueDate: pastDate,
        });

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          courseAllocationId: allocationId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work' },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(json.error.message, /Late submission is not allowed/i);
    });
  });

  void describe('Versioned Resubmissions & Grading Locks (SUB-15, SUB-16, SUB-17)', () => {
    void it('SUB-15: resubmission before grading increments version to 2', async () => {
      submissionsRepository.findLatestSubmission = () =>
        Promise.resolve({
          id: 'prev-sub',
          version: 1,
          status: SubmissionStatus.SUBMITTED,
        } as Submission);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work-v2' },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.version, 2);
    });

    void it('SUB-16: resubmission after grading without request is blocked', async () => {
      submissionsRepository.findLatestSubmission = () =>
        Promise.resolve({
          id: 'prev-sub',
          version: 1,
          status: SubmissionStatus.GRADED,
          marks: 90,
        } as Submission);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work-v2' },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(
        json.error.message,
        /Cannot resubmit an assignment that has already been graded/i,
      );
    });

    void it('SUB-17: resubmission when RESUBMIT_REQUESTED is allowed and increments version', async () => {
      submissionsRepository.findLatestSubmission = () =>
        Promise.resolve({
          id: 'prev-sub',
          version: 1,
          status: SubmissionStatus.RESUBMIT_REQUESTED,
        } as Submission);

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work-v2' },
        }),
      });

      assert.equal(res.status, 201);
      const json = (await res.json()) as { data: Submission };
      assert.equal(json.data.version, 2);
    });
  });

  void describe('Batch Read-Only Locks & Double Submit Protection (SUB-18, SUB-22)', () => {
    void it('SUB-22: blocks submissions when batch is ON_HOLD or COMPLETED', async () => {
      submissionsRepository.findCourseAllocation = () =>
        Promise.resolve({
          ...baseAllocation,
          batch: { id: 'batch-1', status: BatchStatus.ON_HOLD } as Batch,
        });

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work' },
        }),
      });

      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: { message: string } };
      assert.match(json.error.message, /batch is on_hold/i);
    });

    void it('SUB-18: double submit returns 409 Conflict', async () => {
      submissionsRepository.saveSubmission = () => {
        const error = Object.assign(
          new Error('duplicate key value violates unique constraint "uq_sub_version"'),
          { code: '23505' },
        );
        return Promise.reject(error);
      };

      const res = await fetch(`${baseUrl}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenMentee}`,
        },
        body: JSON.stringify({
          assignmentId,
          confirmedComplete: true,
          submissionData: { linkUrl: 'https://github.com/work' },
        }),
      });

      assert.equal(res.status, 409);
    });
  });

  void describe('My Assignments Aggregated List (FR-9.1, FR-9.3, SUB-01, SUB-23)', () => {
    void it('SUB-01, SUB-23: retrieves assignments with status and instructions', async () => {
      submissionsRepository.findAssignmentsByCourseIds = () => Promise.resolve([baseAssignment]);

      submissionsRepository.findSubmissionsByAllocationsAndAssignments = () => Promise.resolve([]);

      const res = await fetch(`${baseUrl}/submissions/my-assignments`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as { data: Array<{ id: string; status: string }> };
      assert.equal(json.data.length, 1);
      const firstItem = json.data[0];
      assert(firstItem);
      assert.equal(firstItem.id, assignmentId);
      assert.equal(firstItem.status, 'PENDING');
    });

    void it('fetches assignment detail with submission versions', async () => {
      submissionsRepository.findSubmissionsForAllocationAndAssignment = () =>
        Promise.resolve([
          {
            id: 'sub-1',
            version: 1,
            status: SubmissionStatus.SUBMITTED,
            submittedAt: new Date(),
          } as Submission,
        ]);

      const res = await fetch(`${baseUrl}/submissions/assignments/${assignmentId}`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as { data: { versions: Submission[] } };
      assert.equal(json.data.versions.length, 1);
      const firstVersion = json.data.versions[0];
      assert(firstVersion);
      assert.equal(firstVersion.version, 1);
    });
  });

  void describe('Submission Queue & Grading Endpoints (Module 10)', () => {
    void it('blocks MENTEE from accessing submission queue with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/submissions/queue`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });
      assert.equal(res.status, 403);
    });

    void it('rejects invalid fromDate string with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/submissions/queue?fromDate=not-a-valid-date`, {
        headers: { Authorization: `Bearer ${tokenSuperAdmin}` },
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const detail = json.error.details?.find((d) => d.field === 'fromDate');
      assert.match(detail?.message ?? '', /fromDate must be a valid date/);
    });

    void it('rejects invalid toDate string with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/submissions/queue?toDate=invalid`, {
        headers: { Authorization: `Bearer ${tokenSuperAdmin}` },
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const detail = json.error.details?.find((d) => d.field === 'toDate');
      assert.match(detail?.message ?? '', /toDate must be a valid date/);
    });

    void it('returns 200 with standard pagination envelope for submission queue', async () => {
      const originalQueue = gradingRepository.getSubmissionQueue.bind(gradingRepository);
      try {
        gradingRepository.getSubmissionQueue = () =>
          Promise.resolve({
            items: [
              {
                id: 'sub-queue-1',
                courseAllocationId: allocationId,
                assignmentId,
                assignmentTitle: 'Project 1',
                maxMarks: 100,
                passMarks: 50,
                courseId,
                courseTitle: 'TypeScript Master',
                topicId: null,
                topicTitle: null,
                batchId: null,
                batchName: null,
                version: 1,
                submittedAt: new Date(),
                isLate: false,
                status: SubmissionStatus.SUBMITTED,
                marks: null,
                gradeLabel: null,
                feedback: null,
                gradedBy: null,
                gradedAt: null,
                mentee: { id: menteeId, name: 'Alice', email: 'alice@TechEniac.com' },
              },
            ],
            total: 1,
            page: 1,
            limit: 20,
            totalPages: 1,
          });

        const res = await fetch(`${baseUrl}/submissions/queue?sort=latest`, {
          headers: { Authorization: `Bearer ${tokenSuperAdmin}` },
        });

        assert.equal(res.status, 200);
        const json = (await res.json()) as {
          success: boolean;
          data: unknown[];
          meta: { page: number; limit: number; total: number; totalPages: number };
        };
        assert.equal(json.success, true);
        assert.equal(json.data.length, 1);
        assert.equal(json.meta.total, 1);
      } finally {
        gradingRepository.getSubmissionQueue = originalQueue;
      }
    });

    void it('rejects grading when marks are negative or missing with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/submissions/sub-1/grade`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenSuperAdmin}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ marks: -5 }),
      });
      assert.equal(res.status, 400);
    });

    void it('rejects resubmission request when feedback is empty with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/submissions/sub-1/resubmit-request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenSuperAdmin}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feedback: '' }),
      });
      assert.equal(res.status, 400);
    });
  });
});
