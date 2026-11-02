import 'reflect-metadata';

import type { Server } from 'node:http';

import { app } from '../src/app';
import { closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
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

  try {
    logger.info({ baseUrl }, 'Running Course Builder HTTP Verification Tests...');

    // 1. Authenticate as Admin
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.SEED_ADMIN_EMAIL || 'admin@TechEniac.com',
        password: process.env.SEED_ADMIN_PASSWORD || 'Admin123456!',
      }),
    });
    const loginData = (await loginRes.json()) as ApiResponse<{
      tokens: { accessToken: string };
    }>;
    const token = loginData.data?.tokens.accessToken;

    if (!token) {
      throw new Error(
        `Failed to login as Admin for testing: status ${loginRes.status} ${JSON.stringify(loginData)}`,
      );
    }
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // 2. Create Course (CRS-01)
    const createCourseRes = await fetch(`${baseUrl}/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'HTTP Test Course',
        description: 'End-to-end HTTP integration test course',
        estimatedMinutes: 120,
      }),
    });
    const createCourseData = (await createCourseRes.json()) as ApiResponse<{
      id: string;
      title: string;
      updatedAt: string;
    }>;
    const courseId = createCourseData.data?.id;

    if (createCourseRes.status === 201 && courseId) {
      logger.info({ courseId }, 'PASS: Create Course endpoint');
    } else {
      logger.error({ status: createCourseRes.status, createCourseData }, 'FAIL: Create Course');
      failures++;
    }

    // 3. List Courses landing call verification (M6-LIST-1, FR-6.6)
    const listCoursesRes = await fetch(`${baseUrl}/courses`, {
      method: 'GET',
      headers,
    });
    const listCoursesData = (await listCoursesRes.json()) as ApiResponse<Array<{ id: string }>>;

    if (
      listCoursesRes.status === 200 &&
      listCoursesData.success &&
      Array.isArray(listCoursesData.data) &&
      listCoursesData.meta?.page === 1
    ) {
      logger.info(
        { total: listCoursesData.meta.total },
        'PASS: List Courses endpoint with defaults',
      );
    } else {
      logger.error({ status: listCoursesRes.status, listCoursesData }, 'FAIL: List Courses');
      failures++;
    }

    // 4. Create Topic (CRS-01, FR-6.1, FR-6.15)
    const createTopicRes = await fetch(`${baseUrl}/courses/${courseId}/topics`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Topic 1: Introduction',
        estimatedMinutes: 30,
      }),
    });
    const createTopicData = (await createTopicRes.json()) as ApiResponse<{
      id: string;
      title: string;
      displayOrder: number;
    }>;
    const topicId = createTopicData.data?.id;

    if (createTopicRes.status === 201 && topicId && createTopicData.data?.displayOrder === 0) {
      logger.info({ topicId }, 'PASS: Create Topic endpoint');
    } else {
      logger.error({ status: createTopicRes.status, createTopicData }, 'FAIL: Create Topic');
      failures++;
    }

    // 5. Create Subtopic with XSS sanitization (CRS-23, FR-6.4)
    const dirtyHtml =
      '<p>Clean text</p><script>alert("xss")</script><img src="x" onerror="alert(1)"/>';
    const createSubtopicRes = await fetch(`${baseUrl}/courses/topics/${topicId}/subtopics`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Subtopic 1: Overview',
        content: dirtyHtml,
        estimatedMinutes: 15,
      }),
    });
    const createSubtopicData = (await createSubtopicRes.json()) as ApiResponse<{
      id: string;
      content: string;
    }>;

    const sanitizedContent = createSubtopicData.data?.content ?? '';
    if (
      createSubtopicRes.status === 201 &&
      !sanitizedContent.includes('<script>') &&
      !sanitizedContent.includes('onerror') &&
      sanitizedContent.includes('<p>Clean text</p>')
    ) {
      logger.info('PASS: Create Subtopic endpoint + XSS sanitization');
    } else {
      logger.error(
        { status: createSubtopicRes.status, createSubtopicData },
        'FAIL: Subtopic sanitization',
      );
      failures++;
    }

    // 6. Create Assignment with submission mode validation (CRS-03, FR-6.5)
    const createAssignmentRes = await fetch(`${baseUrl}/courses/${courseId}/assignments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'COURSE',
        title: 'Final Project',
        instructions: 'Submit your solution repository',
        estimatedMinutes: 60,
        maxMarks: 100,
        passMarks: 70,
        urlMode: 'REQUIRED',
      }),
    });
    const createAssignmentData = (await createAssignmentRes.json()) as ApiResponse<{
      id: string;
      passMarks: number;
    }>;

    if (createAssignmentRes.status === 201 && createAssignmentData.data?.id) {
      logger.info('PASS: Create Course-level Assignment endpoint');
    } else {
      logger.error(
        { status: createAssignmentRes.status, createAssignmentData },
        'FAIL: Create Assignment',
      );
      failures++;
    }

    // 7. Optimistic Concurrency Check (CRS-19, FR-6.13)
    const staleUpdatedAt = new Date(Date.now() - 3600000).toISOString();
    const conflictRes = await fetch(`${baseUrl}/courses/${courseId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        title: 'Conflicting Course Title',
        expectedUpdatedAt: staleUpdatedAt,
      }),
    });
    const conflictData = (await conflictRes.json()) as ApiResponse;

    if (conflictRes.status === 409 && conflictData.error?.code === 'CONFLICT') {
      logger.info('PASS: 409 Optimistic Concurrency Conflict detected');
    } else {
      logger.error({ status: conflictRes.status, conflictData }, 'FAIL: 409 Conflict check');
      failures++;
    }

    // 8. Clone Course (CRS-21, FR-6.6)
    const cloneRes = await fetch(`${baseUrl}/courses/${courseId}/clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const cloneData = (await cloneRes.json()) as ApiResponse<{
      id: string;
      title: string;
      isActive: boolean;
    }>;

    if (
      cloneRes.status === 201 &&
      cloneData.data?.id &&
      cloneData.data.title.includes('(Copy)') &&
      cloneData.data.isActive === false
    ) {
      logger.info({ clonedId: cloneData.data.id }, 'PASS: Clone Course (Copy) inactive');
    } else {
      logger.error({ status: cloneRes.status, cloneData }, 'FAIL: Clone Course');
      failures++;
    }

    // 9. Soft Delete Course (FR-6.7)
    const deleteRes = await fetch(`${baseUrl}/courses/${courseId}`, {
      method: 'DELETE',
      headers,
    });
    const deleteData = (await deleteRes.json()) as ApiResponse;

    if (deleteRes.status === 200 && deleteData.success) {
      logger.info('PASS: Soft Delete Course');
    } else {
      logger.error({ status: deleteRes.status, deleteData }, 'FAIL: Soft Delete');
      failures++;
    }

    if (failures === 0) {
      logger.info('=== ALL COURSE BUILDER HTTP ENDPOINTS VERIFIED SUCCESSFULLY! ===');
    } else {
      logger.error({ failures }, '=== COURSE BUILDER HTTP TESTS HAD FAILURES ===');
      process.exitCode = 1;
    }
  } finally {
    server.close();
    await closeDatabase();
  }
}

void runTests();
