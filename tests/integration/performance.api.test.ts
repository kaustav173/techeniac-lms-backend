/* eslint-disable architecture/raw-queries-only-in-repositories */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { AppDataSource, closeDatabase, initializeDatabase } from '../../src/core/db';
import { CourseAllocation, CourseAllocationStatus } from '../../src/modules/allocations';
import {
  Batch,
  BatchMember,
  BatchMemberRole,
  BatchStatus,
  MentorMentee,
} from '../../src/modules/batches';
import {
  Assignment,
  AssignmentScope,
  Course,
  SubmissionMode,
  Topic,
} from '../../src/modules/courses';
import { exportService, performanceRepository } from '../../src/modules/performance';
import { TopicProgress, TopicProgressStatus } from '../../src/modules/progress';
import { Submission, SubmissionStatus } from '../../src/modules/submissions';
import { User, UserRole } from '../../src/modules/users';

void describe('Performance API & Aggregation Integration Tests (Module 11)', () => {
  let server: Server;
  let baseUrl: string;

  let adminUser: User;
  let mentorUser: User;
  let mentee1: User;
  let mentee2: User;
  let testBatch: Batch;
  let testCourse: Course;
  let testTopic: Topic;
  let testAssignment: Assignment;
  let alloc1: CourseAllocation;
  let alloc2: CourseAllocation;
  let topicProg1: TopicProgress;
  let sub1: Submission;
  let sub2: Submission;
  let sub3: Submission;
  let bm1: BatchMember;
  let bm2: BatchMember;
  let bm3: BatchMember;
  let mm1: MentorMentee;

  let tokenAdmin: string;
  let tokenMentor: string;
  let tokenMentee1: string;

  before(async () => {
    await initializeDatabase();

    const userRepo = AppDataSource.getRepository(User);
    const batchRepo = AppDataSource.getRepository(Batch);
    const bmRepo = AppDataSource.getRepository(BatchMember);
    const mmRepo = AppDataSource.getRepository(MentorMentee);
    const courseRepo = AppDataSource.getRepository(Course);
    const topicRepo = AppDataSource.getRepository(Topic);
    const assignmentRepo = AppDataSource.getRepository(Assignment);
    const allocRepo = AppDataSource.getRepository(CourseAllocation);
    const tpRepo = AppDataSource.getRepository(TopicProgress);
    const subRepo = AppDataSource.getRepository(Submission);

    const suffix = `${Date.now().toString().slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;

    // 1. Seed Users via concise helper
    const createUser = (name: string, email: string, role: UserRole) =>
      userRepo.save(
        userRepo.create({
          name,
          email,
          role,
          passwordHash: 'dummy_hash',
          isActive: true,
          tokenVersion: 1,
        }),
      );

    adminUser = await createUser(
      `Admin ${suffix}`,
      `admin_${suffix}@TechEniac.com`,
      UserRole.SUPER_ADMIN,
    );
    mentorUser = await createUser(
      `Mentor ${suffix}`,
      `mentor_${suffix}@TechEniac.com`,
      UserRole.MENTOR,
    );
    mentee1 = await createUser(`Alice ${suffix}`, `alice_${suffix}@TechEniac.com`, UserRole.MENTEE);
    mentee2 = await createUser(`Bob ${suffix}`, `bob_${suffix}@TechEniac.com`, UserRole.MENTEE);

    // 2. Seed Batch
    testBatch = await batchRepo.save(
      batchRepo.create({
        name: `Perf Batch ${suffix}`,
        code: `P${suffix}`.slice(0, 20),
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        status: BatchStatus.LIVE,
        description: 'Test batch for performance SQL integration tests',
        createdBy: adminUser.id,
      }),
    );

    // 3. Seed Batch Members
    const createBm = (userId: string, role: BatchMemberRole) =>
      bmRepo.save(
        bmRepo.create({
          batchId: testBatch.id,
          userId,
          memberRole: role,
          isActive: true,
          createdBy: adminUser.id,
        }),
      );

    bm1 = await createBm(mentorUser.id, BatchMemberRole.MENTOR);
    bm2 = await createBm(mentee1.id, BatchMemberRole.MENTEE);
    bm3 = await createBm(mentee2.id, BatchMemberRole.MENTEE);

    // 4. Seed Mentor-Mentee mapping (Mentor mapped only to Mentee 1)
    mm1 = await mmRepo.save(
      mmRepo.create({
        batchId: testBatch.id,
        mentorId: mentorUser.id,
        menteeId: mentee1.id,
        isActive: true,
        startDate: new Date(),
        createdBy: adminUser.id,
      }),
    );

    // 5. Seed Course & Topic
    testCourse = await courseRepo.save(
      courseRepo.create({
        title: `Perf Course ${suffix}`,
        description: 'Course for performance tests',
        estimatedMinutes: 120,
        isActive: true,
        createdBy: adminUser.id,
      }),
    );

    testTopic = await topicRepo.save(
      topicRepo.create({
        courseId: testCourse.id,
        title: `Perf Topic ${suffix}`,
        displayOrder: 1,
        createdBy: adminUser.id,
      }),
    );

    // 6. Seed Assignment
    testAssignment = await assignmentRepo.save(
      assignmentRepo.create({
        courseId: testCourse.id,
        topicId: testTopic.id,
        scope: AssignmentScope.TOPIC,
        displayOrder: 1,
        title: `Perf Assignment ${suffix}`,
        instructions: 'Test instructions',
        estimatedMinutes: 60,
        maxMarks: 100,
        passMarks: 50,
        allowLate: true,
        pdfMode: SubmissionMode.OPTIONAL,
        zipMode: SubmissionMode.OPTIONAL,
        urlMode: SubmissionMode.REQUIRED,
        createdBy: adminUser.id,
      }),
    );

    // 7. Seed Course Allocations:
    // alloc1 (Mentee 1): progress 80%, due in future (not overdue)
    alloc1 = await allocRepo.save(
      allocRepo.create({
        userId: mentee1.id,
        courseId: testCourse.id,
        batchId: testBatch.id,
        startDate: new Date('2026-01-01'),
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 80,
        createdBy: adminUser.id,
      }),
    );

    // alloc2 (Mentee 2): progress 40%, due in past (OVERDUE allocation)
    alloc2 = await allocRepo.save(
      allocRepo.create({
        userId: mentee2.id,
        courseId: testCourse.id,
        batchId: testBatch.id,
        startDate: new Date('2026-01-01'),
        dueDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 40,
        createdBy: adminUser.id,
      }),
    );

    // 8. Seed Topic Progress for Mentee 1: deadline in past, status IN_PROGRESS (OVERDUE topic)
    topicProg1 = await tpRepo.save(
      tpRepo.create({
        courseAllocationId: alloc1.id,
        topicId: testTopic.id,
        status: TopicProgressStatus.IN_PROGRESS,
        deadline: new Date(Date.now() - 24 * 60 * 60 * 1000),
        createdBy: adminUser.id,
      }),
    );

    // 9. Seed Submissions:
    // sub1: Mentee 1, GRADED, marks 90, grade A+, on-time (isLate: false)
    sub1 = await subRepo.save(
      subRepo.create({
        courseAllocationId: alloc1.id,
        assignmentId: testAssignment.id,
        batchId: testBatch.id,
        version: 1,
        submissionData: { linkUrl: 'https://example.com/sub1' },
        submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        isLate: false,
        status: SubmissionStatus.GRADED,
        marks: 90,
        gradeLabel: 'A+',
        gradedBy: adminUser.id,
        gradedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        createdBy: mentee1.id,
      }),
    );

    // sub2: Mentee 2, GRADED, marks 60, grade C, late (isLate: true)
    sub2 = await subRepo.save(
      subRepo.create({
        courseAllocationId: alloc2.id,
        assignmentId: testAssignment.id,
        batchId: testBatch.id,
        version: 1,
        submissionData: { linkUrl: 'https://example.com/sub2' },
        submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        isLate: true,
        status: SubmissionStatus.GRADED,
        marks: 60,
        gradeLabel: 'C',
        gradedBy: adminUser.id,
        gradedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        createdBy: mentee2.id,
      }),
    );

    // sub3: Mentee 2, SUBMITTED (pending grading), marks null, on-time (isLate: false)
    sub3 = await subRepo.save(
      subRepo.create({
        courseAllocationId: alloc2.id,
        assignmentId: testAssignment.id,
        batchId: testBatch.id,
        version: 2,
        submissionData: { linkUrl: 'https://example.com/sub3' },
        submittedAt: new Date(),
        isLate: false,
        status: SubmissionStatus.SUBMITTED,
        marks: null,
        gradeLabel: null,
        createdBy: mentee2.id,
      }),
    );

    // 10. Generate Auth Tokens
    tokenAdmin = signAccessToken({
      sub: adminUser.id,
      email: adminUser.email,
      role: 'SUPER_ADMIN',
      tokenVersion: adminUser.tokenVersion,
    });

    tokenMentor = signAccessToken({
      sub: mentorUser.id,
      email: mentorUser.email,
      role: 'MENTOR',
      tokenVersion: mentorUser.tokenVersion,
    });

    tokenMentee1 = signAccessToken({
      sub: mentee1.id,
      email: mentee1.email,
      role: 'MENTEE',
      tokenVersion: mentee1.tokenVersion,
    });

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 4000;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  after(async () => {
    try {
      const cleanups = [
        [AppDataSource.getRepository(Submission), [sub1?.id, sub2?.id, sub3?.id]],
        [AppDataSource.getRepository(TopicProgress), [topicProg1?.id]],
        [AppDataSource.getRepository(CourseAllocation), [alloc1?.id, alloc2?.id]],
        [AppDataSource.getRepository(Assignment), [testAssignment?.id]],
        [AppDataSource.getRepository(Topic), [testTopic?.id]],
        [AppDataSource.getRepository(Course), [testCourse?.id]],
        [AppDataSource.getRepository(MentorMentee), [mm1?.id]],
        [AppDataSource.getRepository(BatchMember), [bm1?.id, bm2?.id, bm3?.id]],
        [AppDataSource.getRepository(Batch), [testBatch?.id]],
        [
          AppDataSource.getRepository(User),
          [mentee1?.id, mentee2?.id, mentorUser?.id, adminUser?.id],
        ],
      ] as const;

      for (const [repo, ids] of cleanups) {
        for (const id of ids) {
          if (id) await repo.delete(id).catch(() => {});
        }
      }
    } catch {
      // Ignore cleanup error
    }

    server.close();
    await closeDatabase();
  });

  void it('exercises real aggregation SQL for GET /performance with zero mocks (averageMarks, completion %, on-time rate, overdue count)', async () => {
    const res = await fetch(`${baseUrl}/performance?batchId=${testBatch.id}&page=1&limit=10`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        metrics: {
          averageMarks: number;
          completionPercentage: number;
          onTimeRate: number;
          overdueCount: number;
          totalMentees: number;
          totalSubmissions: number;
          gradeDistribution: Record<string, { count: number; percentage: number }>;
        };
        mentees: Array<{
          menteeId: string;
          menteeName: string;
          averageMarks: number | null;
          completionPercentage: number;
          overdueCount: number;
          latestGrade: string | null;
        }>;
      };
      meta: { page: number; limit: number; total: number; totalPages: number };
    };

    assert.equal(json.success, true);
    // Real SQL: AVG(marks) for graded subs (90 + 60) / 2 = 75
    assert.equal(json.data.metrics.averageMarks, 75);
    // Real SQL: AVG(progress_percent) (80 + 40) / 2 = 60
    assert.equal(json.data.metrics.completionPercentage, 60);
    assert.equal(json.data.metrics.totalSubmissions, 3);
    // Real SQL: 2 on-time out of 3 total = 66.67%
    assert.equal(json.data.metrics.onTimeRate, 66.67);
    // Real SQL: 1 overdue allocation + 1 overdue topic progress = 2
    assert.equal(json.data.metrics.overdueCount, 2);
    assert.equal(json.data.metrics.totalMentees, 2);
    assert.equal(json.data.metrics.gradeDistribution['A+']?.count, 1);
    assert.equal(json.data.metrics.gradeDistribution['A+']?.percentage, 50);
    assert.equal(json.data.metrics.gradeDistribution['C']?.count, 1);
    assert.equal(json.data.metrics.gradeDistribution['C']?.percentage, 50);
    assert.equal(json.data.mentees.length, 2);
    assert.equal(json.meta.total, 2);
  });

  void it('exercises real SQL sorting on mentee performance list (PER-02)', async () => {
    // Sort by averageMarks DESC -> Alice (90) before Bob (60)
    const resDesc = await fetch(
      `${baseUrl}/performance?batchId=${testBatch.id}&sortBy=averageMarks&sortOrder=DESC`,
      { headers: { Authorization: `Bearer ${tokenAdmin}` } },
    );
    assert.equal(resDesc.status, 200);
    const jsonDesc = (await resDesc.json()) as {
      data: { mentees: Array<{ menteeId: string; averageMarks: number }> };
    };
    assert.equal(jsonDesc.data.mentees[0].menteeId, mentee1.id);
    assert.equal(jsonDesc.data.mentees[0].averageMarks, 90);
    assert.equal(jsonDesc.data.mentees[1].menteeId, mentee2.id);
    assert.equal(jsonDesc.data.mentees[1].averageMarks, 60);

    // Sort by averageMarks ASC -> Bob (60) before Alice (90)
    const resAsc = await fetch(
      `${baseUrl}/performance?batchId=${testBatch.id}&sortBy=averageMarks&sortOrder=ASC`,
      { headers: { Authorization: `Bearer ${tokenAdmin}` } },
    );
    assert.equal(resAsc.status, 200);
    const jsonAsc = (await resAsc.json()) as {
      data: { mentees: Array<{ menteeId: string; averageMarks: number }> };
    };
    assert.equal(jsonAsc.data.mentees[0].menteeId, mentee2.id);
    assert.equal(jsonAsc.data.mentees[0].averageMarks, 60);
    assert.equal(jsonAsc.data.mentees[1].menteeId, mentee1.id);
    assert.equal(jsonAsc.data.mentees[1].averageMarks, 90);
  });

  void it('exercises real SQL mentor scoping (mentor only sees mapped mentees) (PER-03)', async () => {
    const res = await fetch(`${baseUrl}/performance?batchId=${testBatch.id}`, {
      headers: { Authorization: `Bearer ${tokenMentor}` },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      data: {
        metrics: { totalMentees: number; averageMarks: number; completionPercentage: number };
        mentees: Array<{ menteeId: string }>;
      };
    };

    assert.equal(json.data.metrics.totalMentees, 1);
    assert.equal(json.data.metrics.averageMarks, 90);
    assert.equal(json.data.metrics.completionPercentage, 80);
    assert.equal(json.data.mentees.length, 1);
    assert.equal(json.data.mentees[0].menteeId, mentee1.id);
  });

  void it('exercises real SQL zero-mentee early return for unmapped mentor', async () => {
    const overview = await performanceRepository.getPerformanceOverview(
      { page: 1, limit: 10, sortBy: 'name', sortOrder: 'DESC' },
      { isSuperAdmin: false, allowedMenteeIds: [] },
    );

    assert.equal(overview.averageMarks, null);
    assert.equal(overview.totalMentees, 0);
    assert.equal(overview.totalSubmissions, 0);
    assert.equal(overview.overdueCount, 0);
    assert.equal(overview.completionPercentage, 0);
  });

  void it('exercises real SQL for personal learning history GET /me/learning-history (PER-04, PER-10)', async () => {
    const res = await fetch(`${baseUrl}/me/learning-history`, {
      headers: { Authorization: `Bearer ${tokenMentee1}` },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        user: { id: string };
        batches: Array<{
          batchId: string;
          courseAllocations: Array<{
            allocationId: string;
            progressPercent: number;
            assignments: Array<{ marks: number | null; gradeLabel: string | null }>;
          }>;
        }>;
        summary: {
          totalAllocations: number;
          overallProgress: number;
          averageMarks: number | null;
        };
      };
    };

    assert.equal(json.success, true);
    assert.equal(json.data.user.id, mentee1.id);
    assert.equal(json.data.summary.totalAllocations, 1);
    assert.equal(json.data.summary.overallProgress, 80);
    assert.equal(json.data.summary.averageMarks, 90);
    assert.equal(json.data.batches.length, 1);
    assert.equal(json.data.batches[0].batchId, testBatch.id);
    assert.equal(json.data.batches[0].courseAllocations[0].assignments.length, 1);
    assert.equal(json.data.batches[0].courseAllocations[0].assignments[0].marks, 90);
    assert.equal(json.data.batches[0].courseAllocations[0].assignments[0].gradeLabel, 'A+');
  });

  void it('returns CSV export with sanitized formula prefixes for = @ + - (PER-05)', () => {
    const csv = exportService.generatePerformanceCsv([
      {
        menteeId: mentee1.id,
        menteeName: '=HYPERLINK("http://malicious.site")',
        menteeEmail: '+1234567890@test.com',
        batchId: null,
        batchName: null,
        assignedCoursesCount: 1,
        completedCoursesCount: 0,
        completionPercentage: 0,
        averageMarks: null,
        totalSubmissions: 0,
        onTimeSubmissions: 0,
        onTimeRate: 0,
        overdueCount: 0,
        latestGrade: null,
      },
    ]);

    assert.match(csv, /"'=HYPERLINK/);
    assert.match(csv, /"'\+1234567890/);
  });

  void it('blocks MENTEE from accessing /performance with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/performance`, {
      headers: { Authorization: `Bearer ${tokenMentee1}` },
    });
    assert.equal(res.status, 403);
  });

  void it('exercises multi-page pagination boundary (page=2, limit=1)', async () => {
    const res = await fetch(
      `${baseUrl}/performance?batchId=${testBatch.id}&page=2&limit=1&sortBy=name&sortOrder=ASC`,
      { headers: { Authorization: `Bearer ${tokenAdmin}` } },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      data: { mentees: Array<{ menteeId: string; menteeName: string }> };
      meta: { page: number; limit: number; total: number; totalPages: number };
    };
    assert.equal(json.meta.page, 2);
    assert.equal(json.meta.limit, 1);
    assert.equal(json.meta.total, 2);
    assert.equal(json.meta.totalPages, 2);
    assert.equal(json.data.mentees.length, 1);
  });

  void it('handles page requested beyond available mentees without 500 error', async () => {
    const res = await fetch(`${baseUrl}/performance?batchId=${testBatch.id}&page=2&limit=10`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      data: { mentees: Array<{ menteeId: string }> };
      meta: { page: number; limit: number; total: number; totalPages: number };
    };
    assert.equal(json.meta.page, 2);
    assert.equal(json.meta.limit, 10);
    assert.equal(json.meta.total, 2);
    assert.equal(json.data.mentees.length, 0);
  });

  void it('exercises gradeRange filter bypassing pre-pagination (fallback path)', async () => {
    const res = await fetch(`${baseUrl}/performance?batchId=${testBatch.id}&gradeRange=A%2B`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      data: {
        mentees: Array<{ menteeId: string; latestGrade: string | null }>;
      };
      meta: { total: number };
    };
    assert.equal(json.data.mentees.length, 1);
    assert.equal(json.data.mentees[0].menteeId, mentee1.id);
    assert.equal(json.data.mentees[0].latestGrade, 'A+');
    assert.equal(json.meta.total, 1);
  });
});
