import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { AuthenticatedUser } from '../../src/core/auth';
import { ForbiddenError } from '../../src/core/errors';
import { BatchMemberRole } from '../../src/modules/batches';
import {
  ExportService,
  type LearningHistoryResult,
  type MenteePerformanceRow,
  type PerformanceFilterQuery,
  performanceFilterSchema,
  type PerformanceOverviewMetrics,
  PerformancePolicy,
  PerformanceRepository,
  type PerformanceScopeFilter,
  PerformanceService,
} from '../../src/modules/performance';
import { UserRole } from '../../src/modules/users';

const createTestUser = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@TechEniac.com',
  role: UserRole.SUPER_ADMIN,
  mustChangePassword: false,
  tokenVersion: 1,
  ...overrides,
});

void describe('Module 11: Performance & My Performance Unit Tests (PER-01 to PER-13)', () => {
  let service: PerformanceService;
  let policy: PerformancePolicy;
  let exportSvc: ExportService;
  let mockRepo: Partial<PerformanceRepository>;
  let mockBatchRepo: {
    findActiveMemberInBatch: (
      ...args: unknown[]
    ) => Promise<{ memberRole: BatchMemberRole } | null>;
    findMemberInBatch: (...args: unknown[]) => Promise<{ memberRole: BatchMemberRole } | null>;
  };
  let mockMentorMenteeRepo: {
    findActiveMappingsForMentor: (...args: unknown[]) => Promise<Array<{ menteeId: string }>>;
    findAllMappingsByBatch: (
      ...args: unknown[]
    ) => Promise<Array<{ menteeId: string; mentorId: string }>>;
  };

  const admin = createTestUser({ id: 'admin-1', role: UserRole.SUPER_ADMIN });
  const mentor = createTestUser({ id: 'mentor-1', role: UserRole.MENTOR });
  const mentee = createTestUser({ id: 'mentee-1', role: UserRole.MENTEE });

  const sampleOverviewMetrics: PerformanceOverviewMetrics = {
    averageMarks: 85.5,
    onTimeRate: 90,
    completionPercentage: 75,
    overdueCount: 2,
    totalMentees: 20,
    totalSubmissions: 20,
  };

  const sampleMentees: MenteePerformanceRow[] = [
    {
      menteeId: 'mentee-1',
      menteeName: 'Alice',
      menteeEmail: 'alice@test.com',
      batchId: 'batch-1',
      batchName: 'Batch Alpha',
      assignedCoursesCount: 2,
      completedCoursesCount: 1,
      completionPercentage: 50,
      averageMarks: 70,
      totalSubmissions: 4,
      onTimeSubmissions: 3,
      onTimeRate: 75,
      overdueCount: 1,
    },
    {
      menteeId: 'mentee-2',
      menteeName: 'Bob',
      menteeEmail: 'bob@test.com',
      batchId: 'batch-1',
      batchName: 'Batch Alpha',
      assignedCoursesCount: 2,
      completedCoursesCount: 2,
      completionPercentage: 100,
      averageMarks: 95,
      totalSubmissions: 4,
      onTimeSubmissions: 4,
      onTimeRate: 100,
      overdueCount: 0,
    },
  ];

  beforeEach(() => {
    mockBatchRepo = {
      findActiveMemberInBatch: () => Promise.resolve({ memberRole: BatchMemberRole.MENTOR }),
      findMemberInBatch: () => Promise.resolve({ memberRole: BatchMemberRole.MENTOR }),
    };

    mockMentorMenteeRepo = {
      findActiveMappingsForMentor: () => Promise.resolve([{ menteeId: 'mentee-1' }]),
      findAllMappingsByBatch: () =>
        Promise.resolve([{ menteeId: 'mentee-1', mentorId: 'mentor-1' }]),
    };

    policy = new PerformancePolicy(
      mockBatchRepo as unknown as never,
      mockMentorMenteeRepo as unknown as never,
    );

    mockRepo = {
      getPerformanceOverview: () => Promise.resolve(sampleOverviewMetrics),
      getMenteePerformanceList: () =>
        Promise.resolve({
          mentees: sampleMentees,
          total: sampleMentees.length,
        }),
      getLearningHistory: (
        userId: string,
        batchIdFilter?: string,
      ): Promise<LearningHistoryResult> => {
        if (userId === 'new-mentor') {
          return Promise.resolve({
            user: { id: userId, name: 'New Mentor', email: 'new@test.com' },
            batches: [],
            summary: {
              totalAllocations: 0,
              completedAllocations: 0,
              overallProgress: 0,
              averageMarks: null,
            },
          });
        }
        return Promise.resolve({
          user: { id: userId, name: 'Past Mentee', email: 'user@test.com' },
          batches: [
            {
              batchId: batchIdFilter ?? 'batch-1',
              batchName: 'Batch 1',
              status: 'COMPLETED',
              startDate: new Date('2026-01-01'),
              endDate: new Date('2026-06-01'),
              courseAllocations: [
                {
                  allocationId: 'alloc-1',
                  courseId: 'course-1',
                  courseTitle: 'Fullstack Course',
                  progressPercent: 100,
                  status: 'COMPLETED',
                  startDate: new Date('2026-01-01'),
                  dueDate: new Date('2026-03-01'),
                  completedAt: new Date('2026-02-28'),
                  assignments: [
                    {
                      assignmentId: 'assign-1',
                      assignmentTitle: 'Project 1',
                      maxMarks: 100,
                      passMarks: 50,
                      version: 1,
                      submittedAt: new Date('2026-02-15'),
                      isLate: false,
                      status: 'GRADED',
                      marks: 90,
                      feedback: 'Excellent work!',
                    },
                  ],
                },
              ],
            },
          ],
          summary: {
            totalAllocations: 1,
            completedAllocations: 1,
            overallProgress: 100,
            averageMarks: 90,
          },
        });
      },
    };

    exportSvc = new ExportService();
    service = new PerformanceService(mockRepo as PerformanceRepository, policy, exportSvc);
  });

  void it('PER-01: Admin filters batch + mentor + dates and gets aggregates', async () => {
    const filter: PerformanceFilterQuery = {
      batchId: '00000000-0000-0000-0000-000000000001',
      mentorId: '00000000-0000-0000-0000-000000000002',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    const result = await service.getPerformance(admin, filter);
    assert.strictEqual(result.metrics.averageMarks, 85.5);
    assert.strictEqual(result.metrics.completionPercentage, 75);
    assert.strictEqual(result.pagination.total, 2);
  });

  void it('PER-02: Sorting mentees by average score and completion %', async () => {
    let capturedFilter: PerformanceFilterQuery | undefined;
    mockRepo.getMenteePerformanceList = (filter) => {
      capturedFilter = filter;
      const sorted = [...sampleMentees].sort((a, b) => {
        if (filter.sortBy === 'averageMarks') {
          return (b.averageMarks ?? 0) - (a.averageMarks ?? 0);
        }
        return a.completionPercentage - b.completionPercentage;
      });
      return Promise.resolve({ mentees: sorted, total: sorted.length });
    };

    const resAvg = await service.getPerformance(admin, {
      page: 1,
      limit: 10,
      sortBy: 'averageMarks',
      sortOrder: 'DESC',
    });
    assert.strictEqual(capturedFilter?.sortBy, 'averageMarks');
    assert.strictEqual(capturedFilter?.sortOrder, 'DESC');
    assert.strictEqual(resAvg.mentees[0].menteeName, 'Bob');
    assert.strictEqual(resAvg.mentees[1].menteeName, 'Alice');

    const resComp = await service.getPerformance(admin, {
      page: 1,
      limit: 10,
      sortBy: 'completionPercentage',
      sortOrder: 'ASC',
    });
    assert.strictEqual(capturedFilter?.sortBy, 'completionPercentage');
    assert.strictEqual(resComp.mentees[0].menteeName, 'Alice');
    assert.strictEqual(resComp.mentees[1].menteeName, 'Bob');
  });

  void it('PER-03: Mentor opens Mentees Performance - strictly scoped to mapped mentees in batch', async () => {
    let capturedScope: PerformanceScopeFilter | undefined;
    mockRepo.getMenteePerformanceList = (_filter, scope) => {
      capturedScope = scope;
      return Promise.resolve({
        mentees: sampleMentees,
        total: sampleMentees.length,
      });
    };

    const filter: PerformanceFilterQuery = {
      batchId: '00000000-0000-0000-0000-000000000001',
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    const result = await service.getPerformance(mentor, filter);
    assert.ok(result.metrics);
    assert.ok(result.mentees);
    assert.deepStrictEqual(capturedScope?.allowedMenteeIds, ['mentee-1']);
    assert.strictEqual(capturedScope?.mentorId, 'mentor-1');
  });

  void it('PER-03 (Security): Mentor cannot access batch where he is not a member', async () => {
    mockBatchRepo.findActiveMemberInBatch = () => Promise.resolve(null);
    mockBatchRepo.findMemberInBatch = () => Promise.resolve(null);

    const filter: PerformanceFilterQuery = {
      batchId: '00000000-0000-0000-0000-000000000099',
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    await assert.rejects(
      () => service.getPerformance(mentor, filter),
      (err: Error) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /not an active mentor/i);
        return true;
      },
    );
  });

  void it('Security: Mentee is forbidden from accessing /performance endpoint', async () => {
    const filter: PerformanceFilterQuery = {
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    await assert.rejects(
      () => service.getPerformance(mentee, filter),
      (err: Error) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      },
    );
  });

  void it('PER-04 & PER-10: Mentee calls /me/learning-history and always resolves own data', async () => {
    const result = await service.getLearningHistory(mentee, {
      batchId: undefined,
    });

    assert.strictEqual(result.user.id, mentee.id);
    assert.strictEqual(result.batches.length, 1);
    assert.strictEqual(result.summary.overallProgress, 100);
  });

  void it('PER-05: Export filtered CSV formats rows with valid headers and escaping', async () => {
    const filter = {
      page: 1,
      limit: 10,
      sortBy: 'name' as const,
      sortOrder: 'DESC' as const,
      format: 'csv' as const,
    };

    const { csvData, filename } = await service.exportPerformance(admin, filter);
    assert.ok(filename.endsWith('.csv'));
    assert.ok(csvData.includes('"Mentee Name","Mentee Email","Batch"'));
    assert.ok(csvData.includes('"Alice"'));
    assert.ok(csvData.includes('"Bob"'));
  });

  void it('PER-07: Promoted mentor opens My Performance - sees past mentee history', async () => {
    const promotedMentor = createTestUser({ id: 'promoted-mentor', role: UserRole.MENTOR });
    const result = await service.getLearningHistory(promotedMentor, {});

    assert.strictEqual(result.user.id, 'promoted-mentor');
    assert.strictEqual(result.batches.length, 1);
    assert.strictEqual(result.batches[0].courseAllocations[0].assignments[0].marks, 90);
  });

  void it('PER-08: Mentor who was never a mentee opens My Performance - returns empty state', async () => {
    const brandNewMentor = createTestUser({ id: 'new-mentor', role: UserRole.MENTOR });
    const result = await service.getLearningHistory(brandNewMentor, {});

    assert.strictEqual(result.batches.length, 0);
    assert.strictEqual(result.summary.totalAllocations, 0);
    assert.strictEqual(result.summary.averageMarks, null);
  });

  void it('PER-09: Filter My Performance by batch only returns that batch', async () => {
    const result = await service.getLearningHistory(mentee, {
      batchId: '00000000-0000-0000-0000-000000000042',
    });

    assert.strictEqual(result.batches[0].batchId, '00000000-0000-0000-0000-000000000042');
  });

  void it('PER-10 (Spoofing Prevention): Ignores query parameters trying to pass userId or email', async () => {
    const spoofedInput: Record<string, unknown> = {
      batchId: undefined,
      userId: 'spoofed-id',
      email: 'spoofed@other.com',
    };
    const result = await service.getLearningHistory(mentee, spoofedInput);

    // Strictly returns data for logged-in mentee.id, never for spoofed-id
    assert.strictEqual(result.user.id, mentee.id);
  });

  void it('PER-11: Mentor two pages never mix data', async () => {
    // 1. Mentees' performance queries mentee mappings
    const menteePerf = await service.getPerformance(mentor, {
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    });
    assert.strictEqual(menteePerf.mentees[0].menteeName, 'Alice');

    // 2. My performance queries mentor's own mentee history
    const myPerf = await service.getLearningHistory(mentor, {});
    assert.strictEqual(myPerf.user.id, mentor.id);
  });

  void it('PER-13: Completion % and overdue count calculations', async () => {
    mockRepo.getPerformanceOverview = () =>
      Promise.resolve({
        ...sampleOverviewMetrics,
        completionPercentage: 82.5,
        overdueCount: 5,
        onTimeRate: 94.2,
      });

    const result = await service.getPerformance(admin, {
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    });

    assert.strictEqual(result.metrics.completionPercentage, 82.5);
    assert.strictEqual(result.metrics.overdueCount, 5);
    assert.strictEqual(result.metrics.onTimeRate, 94.2);
  });

  void it('Multi-Batch Mentor Authorization: resolves and deduplicates mentees across multiple batches', async () => {
    let capturedScope: PerformanceScopeFilter | undefined;
    mockRepo.getMenteePerformanceList = (_filter, scope) => {
      capturedScope = scope;
      return Promise.resolve({ mentees: sampleMentees, total: sampleMentees.length });
    };

    mockBatchRepo.findActiveMemberInBatch = () =>
      Promise.resolve({ memberRole: BatchMemberRole.MENTOR });
    mockMentorMenteeRepo.findActiveMappingsForMentor = (_mentorId, batchId) => {
      if (batchId === 'batch-1') {
        return Promise.resolve([{ menteeId: 'mentee-1' }, { menteeId: 'mentee-2' }]);
      }
      return Promise.resolve([{ menteeId: 'mentee-2' }, { menteeId: 'mentee-3' }]);
    };

    const filter: PerformanceFilterQuery = {
      batchIds: ['batch-1', 'batch-2'],
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    await service.getPerformance(mentor, filter);
    assert.deepStrictEqual(capturedScope?.scopedBatchIds, ['batch-1', 'batch-2']);
    assert.deepStrictEqual(capturedScope?.allowedMenteeIds, ['mentee-1', 'mentee-2', 'mentee-3']);
  });

  void it('Multi-Batch Mentor Authorization: throws ForbiddenError if mentor is unauthorized for any batch', async () => {
    mockBatchRepo.findActiveMemberInBatch = (bId) => {
      if (bId === 'batch-unauthorized') return Promise.resolve(null);
      return Promise.resolve({ memberRole: BatchMemberRole.MENTOR });
    };
    mockBatchRepo.findMemberInBatch = (bId) => {
      if (bId === 'batch-unauthorized') return Promise.resolve(null);
      return Promise.resolve({ memberRole: BatchMemberRole.MENTOR });
    };

    const filter: PerformanceFilterQuery = {
      batchIds: ['batch-1', 'batch-unauthorized'],
      page: 1,
      limit: 10,
      sortBy: 'name',
      sortOrder: 'DESC',
    };

    await assert.rejects(
      async () => service.getPerformance(mentor, filter),
      (err: Error) =>
        err instanceof ForbiddenError &&
        err.message.includes('You are not an active mentor in the specified batch'),
    );
  });

  void it('Validation Schema: rejects invalid UUIDs, invalid statuses, and >20 items', () => {
    // 1. Rejects invalid single UUID in batchId
    const resInvalidBatch = performanceFilterSchema.safeParse({
      query: { batchId: 'not-a-valid-uuid' },
    });
    assert.strictEqual(resInvalidBatch.success, false);

    // 2. Rejects comma-separated containing invalid UUID
    const resInvalidCommaBatch = performanceFilterSchema.safeParse({
      query: { batchId: '550e8400-e29b-41d4-a716-446655440000,not-a-uuid' },
    });
    assert.strictEqual(resInvalidCommaBatch.success, false);

    // 3. Rejects invalid status enum
    const resInvalidStatus = performanceFilterSchema.safeParse({
      query: { status: 'TOTALLY_BOGUS' },
    });
    assert.strictEqual(resInvalidStatus.success, false);

    // 4. Rejects > 20 items in batchIds
    const tooMany = Array(21).fill('550e8400-e29b-41d4-a716-446655440000');
    const resTooMany = performanceFilterSchema.safeParse({
      query: { batchIds: tooMany },
    });
    assert.strictEqual(resTooMany.success, false);

    // 5. Accepts valid single and comma-separated UUIDs
    const resValid = performanceFilterSchema.safeParse({
      query: {
        batchId: '550e8400-e29b-41d4-a716-446655440000',
        batchIds: '550e8400-e29b-41d4-a716-446655440000,550e8400-e29b-41d4-a716-446655440001',
        status: 'ASSIGNED,IN_PROGRESS',
      },
    });
    assert.strictEqual(resValid.success, true);
  });
});
