import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { app } from '../src/app';
import { hashPassword, signAccessToken } from '../src/core/auth';
import { AppDataSource, closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
import { BatchMemberRole, BatchStatus } from '../src/modules/batches';
import { userRepository, UserRole } from '../src/modules/users';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function runProgressTests(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Integration test script cannot be run in production environments');
  }

  await initializeDatabase();

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 4000;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let failures = 0;
  const createdUserIds: string[] = [];
  let createdBatchId: string | null = null;
  let createdCourseId: string | null = null;
  const createdTopicIds: string[] = [];
  let createdAllocationId: string | null = null;

  try {
    logger.info(
      { baseUrl },
      'Running M8 Learning Progress Verification Tests (PRG-01..20, ALC-24)...',
    );

    const uniqueSuffix = Date.now().toString().slice(-6);

    async function createDisposableUser(name: string, role: UserRole, prefix: string) {
      const email = `${prefix}-m8-${uniqueSuffix}@TechEniac.com`;
      const password = process.env.TEST_PASSWORD || `TestP@ss-${randomUUID()}`;
      const passwordHash = await hashPassword(password);
      const u = await userRepository.create({
        name,
        email,
        passwordHash,
        role,
        mustChangePassword: false,
      });
      createdUserIds.push(u.id);
      return u;
    }

    const admin = await createDisposableUser('Super Admin M8', UserRole.SUPER_ADMIN, 'admin');
    const mentorA = await createDisposableUser('Mentor Alpha M8', UserRole.MENTOR, 'mentor-a');
    const mentorB = await createDisposableUser('Mentor Beta M8', UserRole.MENTOR, 'mentor-b');
    const mentee1 = await createDisposableUser('Mentee One M8', UserRole.MENTEE, 'mentee-1');
    const mentee2 = await createDisposableUser('Mentee Two M8', UserRole.MENTEE, 'mentee-2');

    const tokenAdmin = signAccessToken({
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    });
    const tokenMentorA = signAccessToken({
      sub: mentorA.id,
      email: mentorA.email,
      role: mentorA.role,
      tokenVersion: mentorA.tokenVersion,
    });
    const tokenMentorB = signAccessToken({
      sub: mentorB.id,
      email: mentorB.email,
      role: mentorB.role,
      tokenVersion: mentorB.tokenVersion,
    });
    const tokenMentee1 = signAccessToken({
      sub: mentee1.id,
      email: mentee1.email,
      role: mentee1.role,
      tokenVersion: mentee1.tokenVersion,
    });
    const tokenMentee2 = signAccessToken({
      sub: mentee2.id,
      email: mentee2.email,
      role: mentee2.role,
      tokenVersion: mentee2.tokenVersion,
    });

    // 1. Create a Batch
    const batchRes = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenAdmin}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Progress Cohort ${uniqueSuffix}`,
        code: `M8-${uniqueSuffix.toUpperCase()}`,
        startDate: '2026-11-01',
        endDate: '2026-12-31',
      }),
    });
    const batchData = (await batchRes.json()) as ApiResponse<{
      batch?: { id: string };
      id?: string;
    }>;
    const batchId = (batchData.data?.batch?.id ?? batchData.data?.id) as string;
    createdBatchId = batchId;
    if (!batchId) {
      logger.error({ batchData, status: batchRes.status }, 'Failed to create batch');
    }

    // Add Mentor A to Batch
    await fetch(`${baseUrl}/batches/${batchId}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userIds: [mentorA.id],
        memberRole: BatchMemberRole.MENTOR,
      }),
    });

    // Add Mentees to Batch
    await fetch(`${baseUrl}/batches/${batchId}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userIds: [mentee1.id, mentee2.id],
        memberRole: BatchMemberRole.MENTEE,
      }),
    });

    // Activate Batch: DRAFT -> LIVE
    await fetch(`${baseUrl}/batches/${batchId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: BatchStatus.LIVE, reason: 'Cohort started' }),
    });

    // Map Mentee 1 to Mentor A
    const mapRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mentorId: mentorA.id, menteeIds: [mentee1.id] }),
    });
    if (mapRes.status !== 201) {
      const err = await mapRes.json();
      logger.error({ err, status: mapRes.status }, 'Failed to map mentee');
    }

    // 2. Create a Course with 3 active topics
    const courseRes = await fetch(`${baseUrl}/courses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Progress Course ${uniqueSuffix}`,
        description: 'M8 Test Course',
        estimatedMinutes: 300,
        isActive: true,
      }),
    });
    const courseData = (await courseRes.json()) as ApiResponse<{ id: string }>;
    const courseId = courseData.data?.id as string;
    createdCourseId = courseId;

    // Add 3 topics
    const topic1Res = await fetch(`${baseUrl}/courses/${courseId}/topics`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Topic 1 - Basics',
        displayOrder: 1,
        estimatedMinutes: 60,
        isActive: true,
      }),
    });
    const topic1Data = (await topic1Res.json()) as ApiResponse<{ id: string }>;
    const topic1Id = topic1Data.data?.id as string;
    if (topic1Id) createdTopicIds.push(topic1Id);

    const topic2Res = await fetch(`${baseUrl}/courses/${courseId}/topics`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Topic 2 - Core',
        displayOrder: 2,
        estimatedMinutes: 120,
        isActive: true,
      }),
    });
    const topic2Data = (await topic2Res.json()) as ApiResponse<{ id: string }>;
    const topic2Id = topic2Data.data?.id as string;
    if (topic2Id) createdTopicIds.push(topic2Id);

    const topic3Res = await fetch(`${baseUrl}/courses/${courseId}/topics`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Topic 3 - Capstone',
        displayOrder: 3,
        estimatedMinutes: 120,
        isActive: true,
      }),
    });
    const topic3Data = (await topic3Res.json()) as ApiResponse<{ id: string }>;
    const topic3Id = topic3Data.data?.id as string;
    if (topic3Id) createdTopicIds.push(topic3Id);

    // 3. Allocate course to Mentee 1
    const allocRes = await fetch(`${baseUrl}/course-allocations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        targetType: 'SELECTED_MENTEES',
        batchId,
        menteeIds: [mentee1.id],
        startDate: '2026-11-01T00:00:00.000Z',
        dueDate: '2026-11-30T00:00:00.000Z',
      }),
    });
    const allocData = (await allocRes.json()) as ApiResponse<{
      created: Array<{ id: string; userId: string }>;
    }>;
    const allocationId = allocData.data?.created[0]?.id as string;
    createdAllocationId = allocationId;

    // Allow event bus microtask to settle
    await new Promise((r) => setTimeout(r, 200));

    // TEST 1: Topic progress initialized in NOT_STARTED (ALC-24, PRG-01, PRG-02)
    {
      const res = await fetch(`${baseUrl}/course-allocations/${allocationId}/topic-progress`, {
        headers: { Authorization: `Bearer ${tokenMentee1}` },
      });
      const data = (await res.json()) as ApiResponse<{
        allocation: { progressPercent: number; status: string };
        topics: Array<{ topicId: string; status: string }>;
      }>;

      if (
        res.status === 200 &&
        data.data?.topics.length === 3 &&
        data.data.topics.every((t) => t.status === 'NOT_STARTED') &&
        data.data.allocation.status === 'ASSIGNED'
      ) {
        logger.info(
          '✔ Test 1: Allocation created and initialized 3 NOT_STARTED topic rows (PRG-01)',
        );
      } else {
        logger.error({ status: res.status, data }, '✖ Test 1 Failed');
        failures++;
      }
    }

    // TEST 2: Mentee moves Topic 1 to IN_PROGRESS -> Allocation moves to IN_PROGRESS (PRG-03)
    {
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic1Id}/status`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenMentee1}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'IN_PROGRESS', note: 'Started video lecture' }),
        },
      );
      const data = (await res.json()) as ApiResponse<{
        topicProgress: { status: string; note: string };
        allocation: { status: string; progressPercent: number };
      }>;

      if (
        res.status === 200 &&
        data.data?.topicProgress.status === 'IN_PROGRESS' &&
        data.data.allocation.status === 'IN_PROGRESS' &&
        data.data.allocation.progressPercent === 0
      ) {
        logger.info(
          '✔ Test 2: Mentee updated topic to IN_PROGRESS; allocation status moved to IN_PROGRESS (PRG-03)',
        );
      } else {
        logger.error({ status: res.status, data }, '✖ Test 2 Failed');
        failures++;
      }
    }

    // TEST 3: Mentee completes Topic 1 -> Recalculation to 33.33% (PRG-04)
    {
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic1Id}/status`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenMentee1}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'COMPLETED' }),
        },
      );
      const data = (await res.json()) as ApiResponse<{
        topicProgress: { status: string; completedAt: string | null };
        allocation: { progressPercent: number };
      }>;

      if (
        res.status === 200 &&
        data.data?.topicProgress.status === 'COMPLETED' &&
        data.data.allocation.progressPercent === 33.33 &&
        data.data.topicProgress.completedAt !== null
      ) {
        logger.info(
          '✔ Test 3: Mentee completed Topic 1; recalculated allocation progress to 33.33% (PRG-04)',
        );
      } else {
        logger.error({ status: res.status, data }, '✖ Test 3 Failed');
        failures++;
      }
    }

    // TEST 4: Another mentee cannot update Topic 2 on Mentee 1's allocation (PRG-10)
    {
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic2Id}/status`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenMentee2}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'COMPLETED' }),
        },
      );

      if (res.status === 403) {
        logger.info('✔ Test 4: Denied another mentee from modifying topic progress (PRG-10)');
      } else {
        logger.error({ status: res.status }, '✖ Test 4 Failed');
        failures++;
      }
    }

    // TEST 5: Unmapped Mentor B cannot view Mentee 1's progress (PRG-10)
    {
      const res = await fetch(`${baseUrl}/course-allocations/${allocationId}/topic-progress`, {
        headers: { Authorization: `Bearer ${tokenMentorB}` },
      });

      if (res.status === 403) {
        logger.info(
          '✔ Test 5: Denied unmapped Mentor B from viewing Mentee 1 course progress (PRG-10)',
        );
      } else {
        logger.error({ status: res.status }, '✖ Test 5 Failed');
        failures++;
      }
    }

    // TEST 6: Mapped Mentor A can view Mentee 1's progress (PRG-09)
    {
      const res = await fetch(`${baseUrl}/course-allocations/${allocationId}/topic-progress`, {
        headers: { Authorization: `Bearer ${tokenMentorA}` },
      });
      const data = (await res.json()) as ApiResponse<{
        allocation: { progressPercent: number };
      }>;

      if (res.status === 200 && data.data?.allocation.progressPercent === 33.33) {
        logger.info(
          '✔ Test 6: Mapped Mentor A successfully viewed Mentee 1 course progress (PRG-09)',
        );
      } else {
        logger.error({ status: res.status, data }, '✖ Test 6 Failed');
        failures++;
      }
    }

    // TEST 7: Mentor A sets valid topic deadline (start <= deadline <= due) (PRG-17)
    {
      const validDeadline = '2026-11-15T18:00:00.000Z';
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic2Id}/deadline`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenMentorA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deadline: validDeadline }),
        },
      );
      const data = (await res.json()) as ApiResponse<{ deadline: string }>;

      if (res.status === 200 && data.data?.deadline === validDeadline) {
        logger.info('✔ Test 7: Mapped Mentor A set topic deadline successfully (PRG-17)');
      } else {
        logger.error({ status: res.status, data }, '✖ Test 7 Failed');
        failures++;
      }
    }

    // TEST 8: Rejects topic deadline outside range (PRG-18)
    {
      const invalidDeadline = '2026-12-05T00:00:00.000Z'; // Beyond due date 2026-11-30
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic2Id}/deadline`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenMentorA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deadline: invalidDeadline }),
        },
      );

      if (res.status === 400) {
        logger.info(
          '✔ Test 8: Rejected deadline outside allocation start/due range with 400 ValidationError (PRG-18)',
        );
      } else {
        logger.error({ status: res.status }, '✖ Test 8 Failed');
        failures++;
      }
    }

    // TEST 9: Mentee completes all remaining topics -> 100% and COMPLETED (PRG-06)
    {
      await fetch(`${baseUrl}/course-allocations/${allocationId}/topics/${topic2Id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenMentee1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      });

      const res3 = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic3Id}/status`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenMentee1}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'COMPLETED' }),
        },
      );
      const data3 = (await res3.json()) as ApiResponse<{
        allocation: { status: string; progressPercent: number };
      }>;

      if (
        res3.status === 200 &&
        data3.data?.allocation.progressPercent === 100 &&
        data3.data.allocation.status === 'COMPLETED'
      ) {
        logger.info(
          '✔ Test 9: Mentee completed 100% of topics; allocation automatically moved to COMPLETED (PRG-06)',
        );
      } else {
        logger.error({ status: res3.status, data: data3 }, '✖ Test 9 Failed');
        failures++;
      }
    }

    // TEST 10: Completed allocation becomes read-only; rejects further topic changes (PRG-13)
    {
      const res = await fetch(
        `${baseUrl}/course-allocations/${allocationId}/topics/${topic1Id}/status`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenMentee1}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'IN_PROGRESS' }),
        },
      );

      if (res.status === 403) {
        logger.info(
          '✔ Test 10: Completed allocation is frozen; rejected status modification (PRG-13)',
        );
      } else {
        logger.error({ status: res.status }, '✖ Test 10 Failed');
        failures++;
      }
    }

    // TEST 11: Progress Tracker for Admin and Mentor (FR-8.7)
    {
      const res = await fetch(`${baseUrl}/progress/trackers?batchId=${batchId}`, {
        headers: { Authorization: `Bearer ${tokenMentorA}` },
      });
      const data = (await res.json()) as ApiResponse<
        Array<{
          menteeId: string;
          progressPercent: number;
          completedTopicsCount: number;
          totalActiveTopics: number;
        }>
      > & { meta?: { page: number; limit: number; total: number; totalPages: number } };

      if (
        res.status === 200 &&
        Array.isArray(data.data) &&
        data.data.length >= 1 &&
        data.data[0]?.progressPercent === 100 &&
        data.data[0]?.completedTopicsCount === 3
      ) {
        logger.info(
          '✔ Test 11: Mentor progress tracker returned scoped progress metrics for mapped mentees (FR-8.7)',
        );
      } else {
        logger.error({ status: res.status, data }, '✖ Test 11 Failed');
        failures++;
      }
    }

    logger.info('All M8 Learning Progress acceptance tests executed!');
  } catch (err) {
    logger.error({ err }, 'Error during M8 progress tests execution');
    failures++;
  } finally {
    logger.info('Cleaning up M8 test fixtures from database...');
    try {
      if (createdAllocationId) {
        await AppDataSource.query('DELETE FROM topic_progress WHERE course_allocation_id = $1', [
          createdAllocationId,
        ]);
        await AppDataSource.query('DELETE FROM course_allocations WHERE id = $1', [
          createdAllocationId,
        ]);
      }
      if (createdTopicIds.length > 0) {
        await AppDataSource.query('DELETE FROM topics WHERE id = ANY($1::uuid[])', [
          createdTopicIds,
        ]);
      }
      if (createdCourseId) {
        await AppDataSource.query('DELETE FROM courses WHERE id = $1', [createdCourseId]);
      }
      if (createdBatchId) {
        await AppDataSource.query('DELETE FROM mentor_mentees WHERE batch_id = $1', [
          createdBatchId,
        ]);
        await AppDataSource.query('DELETE FROM batch_members WHERE batch_id = $1', [
          createdBatchId,
        ]);
        await AppDataSource.query('DELETE FROM batches WHERE id = $1', [createdBatchId]);
      }
      if (createdUserIds.length > 0) {
        await AppDataSource.query('DELETE FROM tokens WHERE user_id = ANY($1::uuid[])', [
          createdUserIds,
        ]).catch(() => { });
        await AppDataSource.query('DELETE FROM user_role_history WHERE user_id = ANY($1::uuid[])', [
          createdUserIds,
        ]).catch(() => { });
        await AppDataSource.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
      }
      logger.info('Cleaned up M8 test fixtures successfully');
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, 'Error during test teardown cleanup');
    }

    server.close();
    await closeDatabase();

    if (failures > 0) {
      console.error(`\nTest suite finished with ${failures} failure(s).`);
      process.exit(1);
    } else {
      console.log('\nAll 11 M8 Learning Progress tests passed successfully!');
      process.exit(0);
    }
  }
}

void runProgressTests();
