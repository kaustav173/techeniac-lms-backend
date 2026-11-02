import 'reflect-metadata';

import type { Server } from 'node:http';

import { app } from '../src/app';
import { signAccessToken } from '../src/core/auth';
import { AppDataSource, closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
import { User, UserRole } from '../src/modules/users';

interface ApiResponse<T = unknown> {
  success?: boolean;
  data?: T;
  meta?: unknown;
  error?: {
    code: string;
    message: string;
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
  const createdUserIds: string[] = [];

  try {
    const uniqueSuffix = Date.now().toString().slice(-6);

    // 1. Create dedicated test users
    let adminUser = await userRepo.findOne({
      where: { role: UserRole.SUPER_ADMIN, isActive: true },
    });
    if (!adminUser) {
      adminUser = await userRepo.save(
        userRepo.create({
          name: `Admin Test ${uniqueSuffix}`,
          email: `admin-perf-${uniqueSuffix}@TechEniac.com`,
          passwordHash: 'dummy_hash',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          tokenVersion: 1,
        }),
      );
      createdUserIds.push(adminUser.id);
    }

    let mentorUser = await userRepo.findOne({ where: { role: UserRole.MENTOR, isActive: true } });
    if (!mentorUser) {
      mentorUser = await userRepo.save(
        userRepo.create({
          name: `Mentor Test ${uniqueSuffix}`,
          email: `mentor-perf-${uniqueSuffix}@TechEniac.com`,
          passwordHash: 'dummy_hash',
          role: UserRole.MENTOR,
          isActive: true,
          tokenVersion: 1,
        }),
      );
      createdUserIds.push(mentorUser.id);
    }

    let menteeUser = await userRepo.findOne({ where: { role: UserRole.MENTEE, isActive: true } });
    if (!menteeUser) {
      menteeUser = await userRepo.save(
        userRepo.create({
          name: `Mentee Test ${uniqueSuffix}`,
          email: `mentee-perf-${uniqueSuffix}@TechEniac.com`,
          passwordHash: 'dummy_hash',
          role: UserRole.MENTEE,
          isActive: true,
          tokenVersion: 1,
        }),
      );
      createdUserIds.push(menteeUser.id);
    }

    const adminToken = signAccessToken({
      sub: adminUser.id,
      email: adminUser.email,
      role: UserRole.SUPER_ADMIN,
      tokenVersion: adminUser.tokenVersion,
    });

    const mentorToken = signAccessToken({
      sub: mentorUser.id,
      email: mentorUser.email,
      role: UserRole.MENTOR,
      tokenVersion: mentorUser.tokenVersion,
    });

    const menteeToken = signAccessToken({
      sub: menteeUser.id,
      email: menteeUser.email,
      role: UserRole.MENTEE,
      tokenVersion: menteeUser.tokenVersion,
    });

    logger.info('--- Running Module 11 Performance Endpoints Tests ---');

    // Test 1: Unauthenticated request should fail with 401
    {
      const res = await fetch(`${baseUrl}/performance`);
      if (res.status === 401) {
        logger.info('✔ [401] Unauthenticated request to /performance correctly rejected');
      } else {
        logger.error(`❌ Expected 401 for unauthenticated request, got ${res.status}`);
        failures++;
      }
    }

    // Test 2: Mentee access to /performance should fail with 403 Forbidden
    {
      const res = await fetch(`${baseUrl}/performance`, {
        headers: { Authorization: `Bearer ${menteeToken}` },
      });
      if (res.status === 403) {
        logger.info('✔ [403] Mentee access to /performance correctly forbidden');
      } else {
        logger.error(`❌ Expected 403 for mentee accessing /performance, got ${res.status}`);
        failures++;
      }
    }

    // Test 3: Super Admin access to /performance should return 200 OK with metrics & mentees
    {
      const res = await fetch(`${baseUrl}/performance`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const body = (await res.json()) as ApiResponse<{ metrics: unknown; mentees: unknown[] }>;
      if (res.status === 200 && body.success && body.data?.metrics) {
        logger.info('✔ [200] Super Admin GET /performance returned overview metrics and mentees');
      } else {
        logger.error(`❌ Expected 200 with metrics for Admin GET /performance, got ${res.status}`);
        failures++;
      }
    }

    // Test 4: Super Admin CSV export should return text/csv
    {
      const res = await fetch(`${baseUrl}/performance/export?format=csv`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (res.status === 200 && contentType.includes('text/csv') && text.includes('Mentee Name')) {
        logger.info('✔ [200] Super Admin GET /performance/export returned valid CSV');
      } else {
        logger.error(`❌ Expected 200 text/csv export, got ${res.status} (${contentType})`);
        failures++;
      }
    }

    // Test 5: Mentor access to /performance
    {
      const res = await fetch(`${baseUrl}/performance`, {
        headers: { Authorization: `Bearer ${mentorToken}` },
      });
      const body = (await res.json()) as ApiResponse<{ metrics: unknown; mentees: unknown[] }>;
      if (res.status === 200 && body.success && body.data) {
        logger.info('✔ [200] Mentor GET /performance within mentor scope succeeded');
      } else {
        logger.error(`❌ Expected 200 for Mentor GET /performance, got ${res.status}`);
        failures++;
      }
    }

    // Test 6: Personal learning history endpoint GET /me/learning-history
    {
      const res = await fetch(`${baseUrl}/me/learning-history`, {
        headers: { Authorization: `Bearer ${menteeToken}` },
      });
      const body = (await res.json()) as ApiResponse<{ user: { id: string }; batches: unknown[] }>;
      if (res.status === 200 && body.success && body.data?.user.id === menteeUser.id) {
        logger.info('✔ [200] GET /me/learning-history correctly resolved for mentee');
      } else {
        logger.error(`❌ Expected 200 for GET /me/learning-history, got ${res.status}`);
        failures++;
      }
    }

    // Test 7: Spoofing parameter suppression on GET /me/learning-history (PER-10)
    {
      const res = await fetch(
        `${baseUrl}/me/learning-history?email=spoofed@victim.com&userId=00000000-0000-0000-0000-000000000000`,
        {
          headers: { Authorization: `Bearer ${menteeToken}` },
        },
      );
      const body = (await res.json()) as ApiResponse<{ user: { id: string } }>;
      if (res.status === 200 && body.data?.user.id === menteeUser.id) {
        logger.info('✔ [PER-10] GET /me/learning-history ignored spoofed query parameters');
      } else {
        logger.error('❌ Spoofed query parameters were not suppressed!');
        failures++;
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Fatal error running performance endpoint tests');
    failures++;
  } finally {
    for (const uid of createdUserIds) {
      try {
        await userRepo.delete(uid);
      } catch {
        // ignore cleanup error
      }
    }
    server.close();
    await closeDatabase();
  }

  if (failures > 0) {
    logger.error(`❌ Performance tests finished with ${failures} failure(s)`);
    process.exit(1);
  } else {
    logger.info('🎉 All Performance endpoint tests passed successfully!');
    process.exit(0);
  }
}

void runTests();
