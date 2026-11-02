import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';

import { app } from '../src/app';
import { hashPassword, signAccessToken } from '../src/core/auth';
import { AppDataSource, closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
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

async function runDashboardTests(): Promise<void> {
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

  const cleanup = async () => {
    if (createdUserIds.length > 0) {
      await AppDataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeDatabase();
  };

  const createTestUser = async (role: UserRole): Promise<{ token: string; id: string }> => {
    const email = `test-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@TechEniac.test`;
    const passwordHash = await hashPassword('Password123!');
    const user = await userRepository.create({
      name: `Test ${role}`,
      email,
      passwordHash,
      role,
    });
    createdUserIds.push(user.id);

    const token = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    return { token, id: user.id };
  };

  try {
    logger.info('--- M12: Running Dashboard & Navigation Integration Tests ---');

    const admin = await createTestUser(UserRole.SUPER_ADMIN);
    const mentor = await createTestUser(UserRole.MENTOR);
    const actualMentee = await createTestUser(UserRole.MENTEE);

    // DSH-01: Admin Dashboard Endpoint
    logger.info('Test 1: GET /dashboard/admin with SUPER_ADMIN token');
    const adminRes = await fetch(`${baseUrl}/dashboard/admin`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const adminData = (await adminRes.json()) as ApiResponse<{
      users: { totalUsers: number };
      batches: { totalBatches: number };
    }>;
    if (adminRes.status === 200 && adminData.success && adminData.data?.users !== undefined) {
      logger.info('PASS: Admin dashboard returned 200 with metrics');
    } else {
      logger.error({ status: adminRes.status, body: adminData }, 'FAIL: Admin dashboard');
      failures++;
    }

    // DSH-02: Mentor Dashboard Endpoint
    logger.info('Test 2: GET /dashboard/mentor with MENTOR token');
    const mentorRes = await fetch(`${baseUrl}/dashboard/mentor`, {
      headers: { Authorization: `Bearer ${mentor.token}` },
    });
    const mentorData = (await mentorRes.json()) as ApiResponse<{
      assignedBatchesCount: number;
      activeMenteesCount: number;
      latestSubmissions: unknown[];
      isZeroState: boolean;
    }>;
    if (
      mentorRes.status === 200 &&
      mentorData.success &&
      mentorData.data?.latestSubmissions !== undefined &&
      mentorData.data.isZeroState === true // New mentor has 0 batches and 0 mentees (DSH-08)
    ) {
      logger.info('PASS: Mentor dashboard returned 200 with zero state for new mentor (DSH-08)');
    } else {
      logger.error({ status: mentorRes.status, body: mentorData }, 'FAIL: Mentor dashboard');
      failures++;
    }

    // DSH-03: Mentee Dashboard Endpoint
    logger.info('Test 3: GET /dashboard/mentee with MENTEE token');
    const menteeRes = await fetch(`${baseUrl}/dashboard/mentee`, {
      headers: { Authorization: `Bearer ${actualMentee.token}` },
    });
    const menteeData = (await menteeRes.json()) as ApiResponse<{
      activeCoursesCount: number;
      completedCoursesCount: number;
      overallProgressPercent: number;
      recentSubmissions: unknown[];
      upcomingDeadlines: unknown[];
    }>;
    if (
      menteeRes.status === 200 &&
      menteeData.success &&
      menteeData.data?.overallProgressPercent !== undefined
    ) {
      logger.info('PASS: Mentee dashboard returned 200 with progress and deadlines');
    } else {
      logger.error({ status: menteeRes.status, body: menteeData }, 'FAIL: Mentee dashboard');
      failures++;
    }

    // FR-12.3: Role Isolation - Mentee accessing Admin dashboard -> 403 Forbidden
    logger.info('Test 4: Role isolation - MENTEE calling /dashboard/admin -> 403');
    const forbiddenRes = await fetch(`${baseUrl}/dashboard/admin`, {
      headers: { Authorization: `Bearer ${actualMentee.token}` },
    });
    if (forbiddenRes.status === 403) {
      logger.info('PASS: Cross-role dashboard call returns 403 Forbidden');
    } else {
      logger.error({ status: forbiddenRes.status }, 'FAIL: Expected 403 Forbidden');
      failures++;
    }

    // DSH-10: Settings Endpoint Prohibition - /api/v1/settings -> 404
    logger.info('Test 5: DSH-10 Prohibition - /api/v1/settings returns 404');
    const settingsRes = await fetch(`${baseUrl}/settings`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    if (settingsRes.status === 404) {
      logger.info('PASS: /api/v1/settings returned 404 Not Found');
    } else {
      logger.error({ status: settingsRes.status }, 'FAIL: Expected 404 Not Found');
      failures++;
    }

    logger.info(`--- All M12 Tests Completed with ${failures} failure(s) ---`);
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    process.exit(1);
  }
}

void runDashboardTests();
