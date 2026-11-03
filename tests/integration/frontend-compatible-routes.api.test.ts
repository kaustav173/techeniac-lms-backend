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

    void it('redirects /admin and /dashboard to /api/v1/admin/dashboard when / is given', async () => {
      const resAdmin = await fetch(`${baseUrl}/admin`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        redirect: 'manual',
      });
      assert.equal(resAdmin.status, 302);
      assert.equal(resAdmin.headers.get('location'), '/api/v1/admin/dashboard');

      const resDashboard = await fetch(`${baseUrl}/dashboard`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        redirect: 'manual',
      });
      assert.equal(resDashboard.status, 302);
      assert.equal(resDashboard.headers.get('location'), '/api/v1/admin/dashboard');
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

    void it('serves my-mentees at /mentor/my-mentees and returns 404 for removed /mentor/mentees', async () => {
      const res = await fetch(`${baseUrl}/mentor/my-mentees`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { success: boolean; data: { mentees: unknown[] } };
      assert.equal(json.success, true);
      assert.equal(Array.isArray(json.data.mentees), true);

      const resOld = await fetch(`${baseUrl}/mentor/mentees`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resOld.status, 404);
    });

    void it('serves reviews queue at /mentor/reviews and /reviews/queue', async () => {
      const resMentorReviews = await fetch(`${baseUrl}/mentor/reviews`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resMentorReviews.status, 200);

      const resReviewsQueue = await fetch(`${baseUrl}/reviews/queue`, {
        headers: { Authorization: `Bearer ${tokenMentor}` },
      });
      assert.equal(resReviewsQueue.status, 200);
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
