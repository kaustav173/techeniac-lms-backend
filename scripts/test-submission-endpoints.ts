import 'reflect-metadata';

import type { Server } from 'node:http';

import { app } from '../src/app';
import { signAccessToken } from '../src/core/auth';
import { AppDataSource, closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
import { CourseAllocation, CourseAllocationStatus } from '../src/modules/allocations';
import { Assignment, AssignmentScope, Course, SubmissionMode } from '../src/modules/courses';
import { Submission, SubmissionStatus } from '../src/modules/submissions';
import { User, UserRole } from '../src/modules/users';

interface ApiResponse<T = unknown> {
  success?: boolean;
  data?: T;
  meta?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function runTests(): Promise<void> {
  await initializeDatabase();

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 4000;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let failures = 0;

  const userRepo = AppDataSource.getRepository(User);
  const courseRepo = AppDataSource.getRepository(Course);
  const assignmentRepo = AppDataSource.getRepository(Assignment);
  const submissionRepo = AppDataSource.getRepository(Submission);
  const allocRepo = AppDataSource.getRepository(CourseAllocation);

  let testMentee: User | null = null;
  let testCourse: Course | null = null;
  let testAssignment: Assignment | null = null;
  let testAllocation: CourseAllocation | null = null;
  const createdSubmissionIds: string[] = [];

  try {
    logger.info({ baseUrl }, '=== Starting Module 9 Submissions Live API Verification ===');

    const uniqueSuffix = Date.now().toString().slice(-6);

    // 1. Create a dedicated test mentee for this script run
    testMentee = userRepo.create({
      name: `Test Mentee M9 ${uniqueSuffix}`,
      email: `test-mentee-m9-${uniqueSuffix}@TechEniac.com`,
      passwordHash: 'dummy_hash',
      role: UserRole.MENTEE,
      isActive: true,
      tokenVersion: 1,
    });
    testMentee = await userRepo.save(testMentee);
    logger.info({ menteeId: testMentee.id }, 'Created temporary test mentee');

    // 2. Create dedicated test course & assignment owned exclusively by this script
    testCourse = courseRepo.create({
      title: `Module 9 Test Course ${uniqueSuffix}`,
      description: 'Course created for automated testing',
      estimatedMinutes: 300,
      isActive: true,
      createdBy: testMentee.id,
    });
    testCourse = await courseRepo.save(testCourse);

    testAssignment = assignmentRepo.create({
      courseId: testCourse.id,
      topicId: null,
      scope: AssignmentScope.COURSE,
      displayOrder: 1,
      title: `Module 9 Test Assignment ${uniqueSuffix}`,
      instructions: 'Please submit URL or report link',
      estimatedMinutes: 60,
      maxMarks: 100,
      passMarks: 50,
      allowLate: true,
      pdfMode: SubmissionMode.OPTIONAL,
      zipMode: SubmissionMode.OPTIONAL,
      urlMode: SubmissionMode.REQUIRED,
    });
    testAssignment = await assignmentRepo.save(testAssignment);

    // 3. Create dedicated test course allocation so mentee is genuinely enrolled
    testAllocation = allocRepo.create({
      userId: testMentee.id,
      courseId: testCourse.id,
      status: CourseAllocationStatus.IN_PROGRESS,
      startDate: new Date(),
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      progressPercent: 0,
      createdBy: testMentee.id,
    });
    testAllocation = await allocRepo.save(testAllocation);
    logger.info({ allocationId: testAllocation.id }, 'Created temporary test course allocation');

    const token = signAccessToken({
      sub: testMentee.id,
      email: testMentee.email,
      role: testMentee.role,
      tokenVersion: testMentee.tokenVersion,
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // --- TEST 1: GET /api/v1/submissions/my-assignments ---
    const listRes = await fetch(`${baseUrl}/submissions/my-assignments`, { headers });
    const listData = (await listRes.json()) as ApiResponse<
      Array<{ id: string; title: string; status: string }>
    >;

    if (listRes.status === 200 && Array.isArray(listData.data)) {
      logger.info(
        { total: listData.meta?.total, count: listData.data.length },
        'PASS: GET /submissions/my-assignments',
      );
    } else {
      logger.error({ status: listRes.status, listData }, 'FAIL: GET /submissions/my-assignments');
      failures++;
    }

    // --- TEST 2: GET /api/v1/submissions/assignments/:id ---
    const detailRes = await fetch(`${baseUrl}/submissions/assignments/${testAssignment.id}`, {
      headers,
    });
    const detailData = (await detailRes.json()) as ApiResponse<{
      assignment: { id: string };
      versions: unknown[];
    }>;

    if (detailRes.status === 200 && detailData.data?.assignment.id === testAssignment.id) {
      logger.info('PASS: GET /submissions/assignments/:assignmentId');
    } else {
      logger.error(
        { status: detailRes.status, detailData },
        'FAIL: GET /submissions/assignments/:assignmentId',
      );
      failures++;
    }

    // --- TEST 3: POST /api/v1/submissions (Validation: Missing confirmation) ---
    const invalidConfirmRes = await fetch(`${baseUrl}/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assignmentId: testAssignment.id,
        confirmedComplete: false,
        submissionData: { linkUrl: 'https://github.com/TechEniac/lms-test' },
      }),
    });

    if (invalidConfirmRes.status === 422) {
      logger.info('PASS: Validation rejected unconfirmed submission with 422');
    } else {
      logger.error(
        { status: invalidConfirmRes.status },
        'FAIL: Expected 422 for unconfirmed submission',
      );
      failures++;
    }

    // --- TEST 4: POST /api/v1/submissions (Validation: Protocol Safety VAL-20) ---
    const maliciousUrlRes = await fetch(`${baseUrl}/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assignmentId: testAssignment.id,
        confirmedComplete: true,
        submissionData: { linkUrl: 'javascript:alert(document.cookie)' },
      }),
    });

    if (maliciousUrlRes.status === 422) {
      logger.info('PASS: Protocol safety rejected javascript: URL with 422');
    } else {
      logger.error({ status: maliciousUrlRes.status }, 'FAIL: Expected 422 for javascript: URL');
      failures++;
    }

    // --- TEST 5: POST /api/v1/submissions (Successful initial submission: Version 1) ---
    const submitV1Res = await fetch(`${baseUrl}/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assignmentId: testAssignment.id,
        confirmedComplete: true,
        submissionData: {
          linkUrl: 'https://github.com/TechEniac/lms-submission-v1',
          pdfUrl: 'https://example.com/project-report.pdf',
        },
      }),
    });
    const submitV1Data = (await submitV1Res.json()) as ApiResponse<{
      id: string;
      version: number;
      status: string;
    }>;

    if (
      submitV1Res.status === 201 &&
      submitV1Data.data?.version === 1 &&
      submitV1Data.data.status === 'SUBMITTED'
    ) {
      logger.info(
        { id: submitV1Data.data.id, version: submitV1Data.data.version },
        'PASS: POST /submissions Version 1 created in DB',
      );
      createdSubmissionIds.push(submitV1Data.data.id);
    } else {
      logger.error({ status: submitV1Res.status, submitV1Data }, 'FAIL: POST /submissions v1');
      failures++;
    }

    // --- TEST 6: POST /api/v1/submissions (Resubmission before grading: Version 2) ---
    const submitV2Res = await fetch(`${baseUrl}/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        assignmentId: testAssignment.id,
        confirmedComplete: true,
        submissionData: {
          linkUrl: 'https://github.com/TechEniac/lms-submission-v2',
        },
      }),
    });
    const submitV2Data = (await submitV2Res.json()) as ApiResponse<{
      id: string;
      version: number;
      status: string;
    }>;

    if (submitV2Res.status === 201 && submitV2Data.data?.version === 2) {
      logger.info(
        { id: submitV2Data.data.id, version: submitV2Data.data.version },
        'PASS: POST /submissions Version 2 resubmission created in DB',
      );
      createdSubmissionIds.push(submitV2Data.data.id);
    } else {
      logger.error({ status: submitV2Res.status, submitV2Data }, 'FAIL: POST /submissions v2');
      failures++;
    }

    // --- TEST 7: GET /api/v1/submissions/assignments/:id (Verify versions in DB) ---
    const historyRes = await fetch(`${baseUrl}/submissions/assignments/${testAssignment.id}`, {
      headers,
    });
    const historyData = (await historyRes.json()) as ApiResponse<{
      versions: Array<{ version: number }>;
    }>;

    if (
      historyRes.status === 200 &&
      Array.isArray(historyData.data?.versions) &&
      historyData.data.versions.length >= 2
    ) {
      logger.info(
        { versionCount: historyData.data.versions.length },
        'PASS: Verified version history persisted in PostgreSQL database',
      );
    } else {
      logger.error({ historyData }, 'FAIL: Version history verification');
      failures++;
    }

    // --- Summary ---
    if (failures === 0) {
      logger.info(
        '=== ALL MODULE 9 LIVE API ENDPOINTS VERIFIED AGAINST POSTGRESQL SUCCESSFULLY! ===',
      );
    } else {
      logger.error({ failures }, '=== SOME MODULE 9 API TESTS FAILED ===');
      process.exitCode = 1;
    }
  } finally {
    // Teardown: Clean up test fixtures created in the live database
    try {
      if (createdSubmissionIds.length > 0) {
        for (const id of createdSubmissionIds) {
          await submissionRepo.delete(id);
        }
        logger.info({ count: createdSubmissionIds.length }, 'Cleaned up live test submission rows');
      }

      if (testAssignment?.id) {
        await assignmentRepo.delete(testAssignment.id);
        logger.info({ assignmentId: testAssignment.id }, 'Cleaned up test assignment');
      }

      if (testAllocation?.id) {
        await allocRepo.delete(testAllocation.id);
        logger.info({ allocationId: testAllocation.id }, 'Cleaned up test allocation');
      }

      if (testCourse?.id) {
        await courseRepo.delete(testCourse.id);
        logger.info({ courseId: testCourse.id }, 'Cleaned up test course');
      }

      if (testMentee?.id) {
        await userRepo.delete(testMentee.id);
        logger.info({ menteeId: testMentee.id }, 'Cleaned up test mentee');
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, 'Error during test fixture teardown');
    }

    server.close();
    await closeDatabase();
  }

  process.exit(failures > 0 ? 1 : 0);
}

void runTests();
