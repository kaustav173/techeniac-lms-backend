import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { mentorMenteeRepository } from '../../src/modules/batches';
import { dashboardRepository } from '../../src/modules/dashboard';
import { performanceRepository } from '../../src/modules/performance';
import { gradingRepository } from '../../src/modules/submissions';
import { userRepository } from '../../src/modules/users';

void describe('Frontend-Compatible API Endpoints Integration Tests', () => {
  let server: Server;
  let baseUrl: string;

  const adminId = '33333333-3333-4333-a333-333333333333';
  const mentorId = '11111111-1111-4111-a111-111111111111';
  const menteeId = '66666666-6666-4666-a666-666666666666';

  let tokenAdmin: string;
  let tokenMentor: string;
  let tokenMentee: string;

  before(async () => {
    tokenAdmin = signAccessToken({
      sub: adminId,
      email: 'admin@TechEniac.com',
      role: 'SUPER_ADMIN',
      tokenVersion: 1,
    });

    tokenMentor = signAccessToken({
      sub: mentorId,
      email: 'mentor@TechEniac.com',
      role: 'MENTOR',
      tokenVersion: 1,
    });

    tokenMentee = signAccessToken({
      sub: menteeId,
      email: 'mentee@TechEniac.com',
      role: 'MENTEE',
      tokenVersion: 1,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    userRepository.findById = (id: string) => {
      if (id === adminId) {
        return Promise.resolve({
          id: adminId,
          email: 'admin@TechEniac.com',
          role: 'SUPER_ADMIN',
          tokenVersion: 1,
          isActive: true,
        } as never);
      }
      if (id === mentorId) {
        return Promise.resolve({
          id: mentorId,
          email: 'mentor@TechEniac.com',
          role: 'MENTOR',
          tokenVersion: 1,
          isActive: true,
        } as never);
      }
      if (id === menteeId) {
        return Promise.resolve({
          id: menteeId,
          email: 'mentee@TechEniac.com',
          role: 'MENTEE',
          tokenVersion: 1,
          isActive: true,
        } as never);
      }
      return Promise.resolve(null);
    };

    dashboardRepository.getAdminMetrics = () =>
      Promise.resolve({
        users: { totalUsers: 10, menteesCount: 8, mentorsCount: 1, adminsCount: 1 },
        batches: {
          totalBatches: 2,
          liveBatches: 1,
          draftBatches: 1,
          completedBatches: 0,
          onHoldBatches: 0,
          archivedBatches: 0,
        },
        courses: { totalCourses: 3, publishedCourses: 3 },
        allocations: { activeAllocations: 5, completedAllocations: 2 },
        submissions: {
          pendingReviewCount: 2,
          gradedCount: 10,
          resubmitRequestedCount: 1,
        },
      });

    dashboardRepository.getMentorAssignedBatchesCount = () => Promise.resolve(1);
    dashboardRepository.getMentorActiveMappings = () => Promise.resolve([]);
    dashboardRepository.getMentorSubmissionsStats = () =>
      Promise.resolve({ pendingReviewCount: 0, gradedCount: 0 });
    dashboardRepository.getMentorLatestSubmissions = () => Promise.resolve([]);

    dashboardRepository.getMenteeAllocationsSummary = () =>
      Promise.resolve({
        activeCoursesCount: 1,
        completedCoursesCount: 1,
        overallProgressPercent: 50,
      });
    dashboardRepository.getMenteePendingAssignmentsCount = () => Promise.resolve(1);
    dashboardRepository.getMenteeRecentSubmissions = () => Promise.resolve([]);
    dashboardRepository.getMenteeUpcomingDeadlines = () => Promise.resolve([]);

    mentorMenteeRepository.findActiveMappingsForMentor = () => Promise.resolve([]);
    gradingRepository.findActiveMappingsForMentor = () => Promise.resolve([]);
    gradingRepository.getSubmissionQueue = () =>
      Promise.resolve({ items: [], total: 0, page: 1, limit: 10, totalPages: 1 });

    performanceRepository.getPerformanceOverview = () =>
      Promise.resolve({
        averageMarks: 85,
        gradeDistribution: {
          'A+': { count: 1, percentage: 100 },
          A: { count: 0, percentage: 0 },
          B: { count: 0, percentage: 0 },
          C: { count: 0, percentage: 0 },
          D: { count: 0, percentage: 0 },
          F: { count: 0, percentage: 0 },
        },
        onTimeRate: 100,
        completionPercentage: 100,
        overdueCount: 0,
        totalMentees: 1,
        totalSubmissions: 1,
      });
    performanceRepository.getMenteePerformanceList = () =>
      Promise.resolve({ mentees: [], total: 0 });

    performanceRepository.getLearningHistory = () =>
      Promise.resolve({
        user: { id: menteeId, name: 'Mentee Student', email: 'mentee@TechEniac.com' },
        batches: [],
        summary: {
          totalAllocations: 0,
          completedAllocations: 0,
          overallProgress: 0,
          averageMarks: null,
        },
      });
  });

  void it('limits a pending password change to session recovery routes', async (t) => {
    const admin = await userRepository.findById(adminId);
    assert.ok(admin);
    t.mock.method(userRepository, 'findById', () =>
      Promise.resolve({ ...admin, mustChangePassword: true }),
    );
    const headers = { Authorization: `Bearer ${tokenAdmin}` };

    const denied = await fetch(`${baseUrl}/admin/dashboard`, { headers });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your password to continue' },
    });

    const session = await fetch(`${baseUrl}/auth/me`, { headers });
    assert.equal(session.status, 200);
    const { data } = (await session.json()) as { data: { user: { mustChangePassword: boolean } } };
    assert.equal(data.user.mustChangePassword, true);
  });

  void it('preserves required and numeric minimum messages on API validation errors', async () => {
    const Authorization = `Bearer ${tokenAdmin}`;
    const missing = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { Authorization, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: ['name', 'email', 'role'].map((field) => ({ field, message: 'Required' })),
      },
    });

    const invalid = await fetch(`${baseUrl}/users?page=0&sortOrder=DESC`, {
      headers: { Authorization },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: [
          { field: 'page', message: 'Number must be greater than or equal to 1' },
          { field: 'sortOrder', message: 'Invalid option: expected one of "asc"|"desc"' },
        ],
      },
    });
  });

  void it('returns field-specific validation errors for performance and CSV export filters', async () => {
    const ids = Array<string>(21).fill(adminId);
    const listLimit = 'At most 20 batch IDs may be filtered at once';
    const cases = [
      {
        query: new URLSearchParams({ batchId: 'abc' }),
        field: 'batchId',
        message: 'batchId must be a valid UUID',
      },
      {
        query: new URLSearchParams({ batchId: `${adminId},abc` }),
        field: 'batchId',
        message: 'batchId must be a valid UUID',
      },
      {
        query: new URLSearchParams({ batchId: ids.join(',') }),
        field: 'batchId',
        message: listLimit,
      },
      {
        query: new URLSearchParams(ids.map((id) => ['batchId', id])),
        field: 'batchId',
        message: listLimit,
      },
      {
        query: new URLSearchParams({ statuses: 'COMPLETED,unknown' }),
        field: 'statuses',
        message: 'statuses must contain valid allocation statuses',
      },
      {
        query: new URLSearchParams({ startDate: 'x' }),
        field: 'startDate',
        message: 'Invalid datetime',
      },
    ];

    for (const path of ['/performance', '/performance/export']) {
      for (const { query, field, message } of cases) {
        const result = await fetch(`${baseUrl}${path}?${query}`, {
          headers: { Authorization: `Bearer ${tokenAdmin}` },
        });
        assert.equal(result.status, 400);
        assert.deepEqual(await result.json(), {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: [{ field, message }],
          },
        });
      }
    }
  });

  void describe('Admin Dashboard Endpoints & Redirects', () => {
    void it('serves admin dashboard at /admin/dashboard', async () => {
      const res = await fetch(`${baseUrl}/admin/dashboard`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as {
        success: boolean;
        data: { users: { totalUsers: number } };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.users.totalUsers, 10);
    });

    void it('redirects /admin and /dashboard according to role', async () => {
      const resAdmin = await fetch(`${baseUrl}/admin`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        redirect: 'manual',
      });
      assert.equal(resAdmin.status, 302);
      assert.equal(resAdmin.headers.get('location'), '/api/v1/admin/dashboard');

      const resDashboardAdmin = await fetch(`${baseUrl}/dashboard`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        redirect: 'manual',
      });
      assert.equal(resDashboardAdmin.status, 302);
      assert.equal(resDashboardAdmin.headers.get('location'), '/api/v1/admin/dashboard');

      const resDashboardMentor = await fetch(`${baseUrl}/dashboard`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
        redirect: 'manual',
      });
      assert.equal(resDashboardMentor.status, 302);
      assert.equal(resDashboardMentor.headers.get('location'), '/api/v1/mentor/dashboard');

      const resDashboardMentee = await fetch(`${baseUrl}/dashboard`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
        redirect: 'manual',
      });
      assert.equal(resDashboardMentee.status, 302);
      assert.equal(resDashboardMentee.headers.get('location'), '/api/v1/mentee/dashboard');
    });
  });

  void describe('Mentor Routes: Dashboard, Redirects, My-Mentees, Reviews, Mentees-Performance', () => {
    void it('serves mentor dashboard at /mentor/dashboard and redirects /mentor', async () => {
      const resRedirect = await fetch(`${baseUrl}/mentor`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
        redirect: 'manual',
      });
      assert.equal(resRedirect.status, 302);
      assert.equal(resRedirect.headers.get('location'), '/api/v1/mentor/dashboard');

      const res = await fetch(`${baseUrl}/mentor/dashboard`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as {
        success: boolean;
        data: { assignedBatchesCount: number };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.assignedBatchesCount, 1);
    });

    void it('serves my-mentees at /mentor/my-mentees and aliases /mentor/mentees', async () => {
      const res = await fetch(`${baseUrl}/mentor/my-mentees`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: { mentees: unknown[] } };
      assert.equal(json.success, true);
      assert.equal(Array.isArray(json.data.mentees), true);

      const resAlias = await fetch(`${baseUrl}/mentor/mentees`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resAlias.status, 200);
      const jsonAlias = (await resAlias.json()) as {
        success: boolean;
        data: { mentees: unknown[] };
      };
      assert.equal(jsonAlias.success, true);
      assert.equal(Array.isArray(jsonAlias.data.mentees), true);
    });

    void it('serves reviews queue at /mentor/reviews and /reviews/queue with strict role access', async () => {
      const resMentorReviews = await fetch(`${baseUrl}/mentor/reviews`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resMentorReviews.status, 200);

      const resReviewsQueue = await fetch(`${baseUrl}/reviews/queue`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resReviewsQueue.status, 200);

      // Mentee cannot access /reviews/queue (forbidden)
      const resMenteeReviewsQueue = await fetch(`${baseUrl}/reviews/queue`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });
      assert.equal(resMenteeReviewsQueue.status, 403);

      // Mentee submission creation route is not mounted under /reviews
      const resPostReviews = await fetch(`${baseUrl}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resPostReviews.status, 404);
    });

    void it('serves mentees-performance and returns 404 for removed /mentor/performance', async () => {
      const res = await fetch(`${baseUrl}/mentor/mentees-performance`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: { metrics: unknown } };
      assert.equal(json.success, true);
      assert.ok(json.data.metrics);

      const resOld = await fetch(`${baseUrl}/mentor/performance`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resOld.status, 404);
    });
  });

  void describe('Mentee Routes: Dashboard, Redirects, My-Performance', () => {
    void it('serves mentee dashboard at /mentee/dashboard and redirects /mentee', async () => {
      const resRedirect = await fetch(`${baseUrl}/mentee`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
        redirect: 'manual',
      });
      assert.equal(resRedirect.status, 302);
      assert.equal(resRedirect.headers.get('location'), '/api/v1/mentee/dashboard');

      const resDashboard = await fetch(`${baseUrl}/mentee/dashboard`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });
      assert.equal(resDashboard.status, 200);
      const json = (await resDashboard.json()) as {
        success: boolean;
        data: { activeCoursesCount: number };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.activeCoursesCount, 1);
    });

    void it('serves mentee performance at /mentee/my-performance and returns 404 for removed /mentee/learning-history', async () => {
      const res = await fetch(`${baseUrl}/mentee/my-performance`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as {
        success: boolean;
        data: { user: { name: string } };
      };
      assert.equal(json.success, true);
      assert.equal(json.data.user.name, 'Mentee Student');

      const resOld = await fetch(`${baseUrl}/mentee/learning-history`, {
        headers: { Authorization: `Bearer ${tokenMentee}` },
      });
      assert.equal(resOld.status, 404);
    });
  });
});
