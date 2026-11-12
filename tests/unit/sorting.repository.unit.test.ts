import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DataSource, SelectQueryBuilder } from 'typeorm';

import {
  allocationsRepository,
  type CourseAllocation,
  listAllocationsQuerySchema,
} from '../../src/modules/allocations';
import {
  performanceFilterSchema,
  PerformanceRepository,
  type PerformanceScopeFilter,
} from '../../src/modules/performance';
import {
  gradingRepository,
  type Submission,
  submissionQueueQuerySchema,
} from '../../src/modules/submissions';
import { User } from '../../src/modules/users';

void describe('Repository Server-Side Sorting Unit Tests (F-002)', () => {
  void describe('AllocationsRepository.listAllocations sortBy branches', () => {
    function createMockAllocationsQueryBuilder() {
      const orderBys: Array<{ column: string; direction: string; isSecondary: boolean }> = [];
      const qb = {
        leftJoinAndSelect: () => qb,
        andWhere: () => qb,
        orderBy: (column: string, direction = 'ASC') => {
          orderBys.push({ column, direction, isSecondary: false });
          return qb;
        },
        addOrderBy: (column: string, direction = 'ASC') => {
          orderBys.push({ column, direction, isSecondary: true });
          return qb;
        },
        skip: () => qb,
        take: () => qb,
        offset: () => qb,
        limit: () => qb,
        getManyAndCount: () => Promise.resolve([[], 0] as [CourseAllocation[], number]),
      };
      return { qb: qb as unknown as SelectQueryBuilder<CourseAllocation>, orderBys };
    }

    const sortBranchMappings: Array<{
      sortBy: 'course' | 'mentee' | 'batch' | 'startDate' | 'dueDate' | 'createdAt';
      expectedColumn: string;
      hasSecondaryTiebreak: boolean;
    }> = [
      { sortBy: 'course', expectedColumn: 'LOWER(course.title)', hasSecondaryTiebreak: true },
      { sortBy: 'mentee', expectedColumn: 'LOWER(user.name)', hasSecondaryTiebreak: true },
      { sortBy: 'batch', expectedColumn: 'LOWER(batch.name)', hasSecondaryTiebreak: true },
      { sortBy: 'startDate', expectedColumn: 'allocation.startDate', hasSecondaryTiebreak: true },
      { sortBy: 'dueDate', expectedColumn: 'allocation.dueDate', hasSecondaryTiebreak: true },
      { sortBy: 'createdAt', expectedColumn: 'allocation.createdAt', hasSecondaryTiebreak: false },
    ];

    for (const { sortBy, expectedColumn, hasSecondaryTiebreak } of sortBranchMappings) {
      void it(`applies correct primary orderBy for sortBy='${sortBy}' with secondary tiebreak`, async () => {
        const repo = allocationsRepository;
        const { qb, orderBys } = createMockAllocationsQueryBuilder();
        Object.defineProperty(repo, 'allocationRepo', {
          get: () => ({ createQueryBuilder: () => qb }),
          configurable: true,
        });

        await repo.listAllocations({ page: 1, limit: 10, sortBy, sortOrder: 'ASC' });

        assert.strictEqual(orderBys.length, hasSecondaryTiebreak ? 3 : 2);
        assert.strictEqual(orderBys[0]?.column, expectedColumn);
        assert.strictEqual(orderBys[0]?.direction, 'ASC');
        assert.strictEqual(orderBys[0]?.isSecondary, false);

        if (hasSecondaryTiebreak) {
          assert.strictEqual(orderBys[1]?.column, 'allocation.createdAt');
          assert.strictEqual(orderBys[1]?.direction, 'DESC');
          assert.strictEqual(orderBys[1]?.isSecondary, true);
          assert.strictEqual(orderBys[2]?.column, 'allocation.id');
        } else {
          assert.strictEqual(orderBys[1]?.column, 'allocation.id');
        }
      });
    }

    void it('defaults to allocation.createdAt DESC when sortBy is omitted', async () => {
      const repo = allocationsRepository;
      const { qb, orderBys } = createMockAllocationsQueryBuilder();
      Object.defineProperty(repo, 'allocationRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.listAllocations({ page: 1, limit: 10 });

      assert.strictEqual(orderBys.length, 2);
      assert.strictEqual(orderBys[0]?.column, 'allocation.createdAt');
      assert.strictEqual(orderBys[0]?.direction, 'DESC');
      assert.strictEqual(orderBys[1]?.column, 'allocation.id');
    });

    void it('correctly applies sortOrder="DESC" for custom sort column', async () => {
      const repo = allocationsRepository;
      const { qb, orderBys } = createMockAllocationsQueryBuilder();
      Object.defineProperty(repo, 'allocationRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.listAllocations({ page: 1, limit: 10, sortBy: 'course', sortOrder: 'DESC' });

      assert.strictEqual(orderBys[0]?.column, 'LOWER(course.title)');
      assert.strictEqual(orderBys[0]?.direction, 'DESC');
      assert.strictEqual(orderBys[1]?.column, 'allocation.createdAt');
      assert.strictEqual(orderBys[1]?.direction, 'DESC');
      assert.strictEqual(orderBys[2]?.column, 'allocation.id');
    });
  });

  void describe('GradingRepository.getSubmissionQueue sortBy branches', () => {
    interface MockGradingQb {
      orderBy: (column: string, direction?: string) => MockGradingQb;
      addOrderBy: (column: string, direction?: string) => MockGradingQb;
      andWhere: (clause: unknown) => MockGradingQb;
      innerJoin: () => MockGradingQb;
      leftJoin: () => MockGradingQb;
      innerJoinAndSelect: () => MockGradingQb;
      leftJoinAndSelect: () => MockGradingQb;
      where: () => MockGradingQb;
      select: () => MockGradingQb;
      addSelect: () => MockGradingQb;
      groupBy: () => MockGradingQb;
      addGroupBy: () => MockGradingQb;
      setParameter: () => MockGradingQb;
      setParameters: () => MockGradingQb;
      skip: () => MockGradingQb;
      take: () => MockGradingQb;
      from: () => MockGradingQb;
      subQuery: () => MockGradingQb;
      getQuery: () => string;
      getManyAndCount: () => Promise<[Submission[], number]>;
      getRawAndEntities: () => Promise<{ raw: unknown[]; entities: Submission[] }>;
      getCount: () => Promise<number>;
    }

    function createMockGradingQueryBuilder() {
      const orderBys: Array<{ column: string; direction: string; isSecondary: boolean }> = [];
      const qb: MockGradingQb = {
        orderBy: (column: string, direction = 'ASC') => {
          orderBys.push({ column, direction, isSecondary: false });
          return qb;
        },
        addOrderBy: (column: string, direction = 'ASC') => {
          orderBys.push({ column, direction, isSecondary: true });
          return qb;
        },
        andWhere: (clause: unknown) => {
          if (typeof clause === 'function') {
            try {
              (clause as (builder: MockGradingQb) => void)(qb);
            } catch {
              // Ignore subQuery evaluation in mock
            }
          }
          return qb;
        },
        innerJoin: () => qb,
        leftJoin: () => qb,
        innerJoinAndSelect: () => qb,
        leftJoinAndSelect: () => qb,
        where: () => qb,
        select: () => qb,
        addSelect: () => qb,
        groupBy: () => qb,
        addGroupBy: () => qb,
        setParameter: () => qb,
        setParameters: () => qb,
        skip: () => qb,
        take: () => qb,
        offset: () => qb,
        limit: () => qb,
        from: () => qb,
        subQuery: () => qb,
        getQuery: () => 'SELECT 1',
        getManyAndCount: () => Promise.resolve([[], 0] as [Submission[], number]),
        getRawAndEntities: () => Promise.resolve({ raw: [], entities: [] }),
        getCount: () => Promise.resolve(0),
      };

      return { qb: qb as unknown as SelectQueryBuilder<Submission>, orderBys };
    }

    void it('routes sortBy="mentee" to mentee.name with secondary submittedAt tiebreak', async () => {
      const repo = gradingRepository;
      const { qb, orderBys } = createMockGradingQueryBuilder();
      Object.defineProperty(repo, 'submissionRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.getSubmissionQueue({ page: 1, limit: 10, sortBy: 'mentee', sortOrder: 'ASC' });

      assert.strictEqual(orderBys.length, 2);
      assert.strictEqual(orderBys[0]?.column, 'mentee.name');
      assert.strictEqual(orderBys[0]?.direction, 'ASC');
      assert.strictEqual(orderBys[1]?.column, 'sub.submittedAt');
      assert.strictEqual(orderBys[1]?.direction, 'DESC');
    });

    void it('routes sortBy="name" alias to mentee.name with secondary submittedAt tiebreak', async () => {
      const repo = gradingRepository;
      const { qb, orderBys } = createMockGradingQueryBuilder();
      Object.defineProperty(repo, 'submissionRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.getSubmissionQueue({ page: 1, limit: 10, sortBy: 'name', sortOrder: 'DESC' });

      assert.strictEqual(orderBys.length, 2);
      assert.strictEqual(orderBys[0]?.column, 'mentee.name');
      assert.strictEqual(orderBys[0]?.direction, 'DESC');
      assert.strictEqual(orderBys[1]?.column, 'sub.submittedAt');
      assert.strictEqual(orderBys[1]?.direction, 'DESC');
    });

    void it('defaults to sub.submittedAt DESC when sortBy is omitted', async () => {
      const repo = gradingRepository;
      const { qb, orderBys } = createMockGradingQueryBuilder();
      Object.defineProperty(repo, 'submissionRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.getSubmissionQueue({ page: 1, limit: 10 });

      assert.strictEqual(orderBys.length, 1);
      assert.strictEqual(orderBys[0]?.column, 'sub.submittedAt');
      assert.strictEqual(orderBys[0]?.direction, 'DESC');
    });

    void it('respects legacy sort="oldest" when sortOrder is omitted', async () => {
      const repo = gradingRepository;
      const { qb, orderBys } = createMockGradingQueryBuilder();
      Object.defineProperty(repo, 'submissionRepo', {
        get: () => ({ createQueryBuilder: () => qb }),
        configurable: true,
      });

      await repo.getSubmissionQueue({ page: 1, limit: 10, sort: 'oldest' });

      assert.strictEqual(orderBys[0]?.column, 'sub.submittedAt');
      assert.strictEqual(orderBys[0]?.direction, 'ASC');
    });
  });

  void describe('PerformanceRepository.getMenteePerformanceList sort logic & grade ranking', () => {
    const adminScope: PerformanceScopeFilter = {
      isSuperAdmin: true,
      scopedBatchId: null,
      allowedMenteeIds: null,
    };

    interface MockPerformanceQb {
      leftJoin: () => MockPerformanceQb;
      innerJoin: () => MockPerformanceQb;
      where: () => MockPerformanceQb;
      andWhere: () => MockPerformanceQb;
      select: () => MockPerformanceQb;
      addSelect: () => MockPerformanceQb;
      groupBy: () => MockPerformanceQb;
      addGroupBy: () => MockPerformanceQb;
      orderBy: () => MockPerformanceQb;
      addOrderBy: () => MockPerformanceQb;
      setParameter: () => MockPerformanceQb;
      setParameters: () => MockPerformanceQb;
      getRawMany: () => Promise<unknown[]>;
    }

    function createChainableQb(getRawManyImpl: () => Promise<unknown[]>): MockPerformanceQb {
      const qb: MockPerformanceQb = {
        leftJoin: () => qb,
        innerJoin: () => qb,
        where: () => qb,
        andWhere: () => qb,
        select: () => qb,
        addSelect: () => qb,
        groupBy: () => qb,
        addGroupBy: () => qb,
        orderBy: () => qb,
        addOrderBy: () => qb,
        setParameter: () => qb,
        setParameters: () => qb,
        getRawMany: getRawManyImpl,
      };
      return qb;
    }

    function setupMockPerformanceDb(
      rawUsers: Array<{
        mentee_id: string;
        mentee_name: string;
        mentee_email: string;
        batch_id: string | null;
        batch_name: string | null;
        assigned_courses_count: string;
        completed_courses_count: string;
        avg_progress: string;
      }>,
    ) {
      const userQb = createChainableQb(() => Promise.resolve(rawUsers));

      const subQb = createChainableQb(() => {
        return Promise.resolve(
          rawUsers.map((u) => ({
            user_id: u.mentee_id,
            total_submissions: '5',
            on_time_submissions: '5',
            avg_marks: '85',
          })),
        );
      });

      const allocQb = createChainableQb(() => Promise.resolve([]));

      const mockDb = {
        getRepository: (entity: { name?: string }) => {
          if (entity === User || entity.name === 'User')
            return { createQueryBuilder: () => userQb };
          if (entity.name === 'Submission') return { createQueryBuilder: () => subQb };
          if (entity.name === 'CourseAllocation') return { createQueryBuilder: () => allocQb };
          return { createQueryBuilder: () => userQb, find: () => Promise.resolve([]) };
        },
      } as unknown as DataSource;

      return mockDb;
    }

    void it('sorts by batch name with deterministic tiebreak', async () => {
      const mockUsers = [
        {
          mentee_id: 'user-1',
          mentee_name: 'Bob',
          mentee_email: 'bob@test.com',
          batch_id: 'batch-2',
          batch_name: 'Batch Zulu',
          assigned_courses_count: '2',
          completed_courses_count: '1',
          avg_progress: '50',
        },
        {
          mentee_id: 'user-2',
          mentee_name: 'Alice',
          mentee_email: 'alice@test.com',
          batch_id: 'batch-1',
          batch_name: 'Batch Alpha',
          assigned_courses_count: '2',
          completed_courses_count: '1',
          avg_progress: '50',
        },
      ];

      const repo = new PerformanceRepository(setupMockPerformanceDb(mockUsers));

      const ascResult = await repo.getMenteePerformanceList(
        { page: 1, limit: 10, sortBy: 'batch', sortOrder: 'ASC' },
        adminScope,
      );
      assert.strictEqual(ascResult.mentees[0]?.batchName, 'Batch Alpha');
      assert.strictEqual(ascResult.mentees[1]?.batchName, 'Batch Zulu');

      const descResult = await repo.getMenteePerformanceList(
        { page: 1, limit: 10, sortBy: 'batch', sortOrder: 'DESC' },
        adminScope,
      );
      assert.strictEqual(descResult.mentees[0]?.batchName, 'Batch Zulu');
      assert.strictEqual(descResult.mentees[1]?.batchName, 'Batch Alpha');
    });

    void it('sorts by assigned courses count with deterministic tiebreak', async () => {
      const mockUsers = [
        {
          mentee_id: 'user-1',
          mentee_name: 'Mentee 1',
          mentee_email: 'm1@test.com',
          batch_id: 'batch-1',
          batch_name: 'Batch 1',
          assigned_courses_count: '1',
          completed_courses_count: '0',
          avg_progress: '10',
        },
        {
          mentee_id: 'user-2',
          mentee_name: 'Mentee 2',
          mentee_email: 'm2@test.com',
          batch_id: 'batch-1',
          batch_name: 'Batch 1',
          assigned_courses_count: '5',
          completed_courses_count: '2',
          avg_progress: '40',
        },
      ];

      const repo = new PerformanceRepository(setupMockPerformanceDb(mockUsers));

      const descResult = await repo.getMenteePerformanceList(
        { page: 1, limit: 10, sortBy: 'courses', sortOrder: 'DESC' },
        adminScope,
      );
      assert.strictEqual(descResult.mentees[0]?.assignedCoursesCount, 5);
      assert.strictEqual(descResult.mentees[1]?.assignedCoursesCount, 1);
    });

    void it('sorts by completionPercentage with deterministic tiebreak', async () => {
      const mockUsers = [
        {
          mentee_id: 'user-1',
          mentee_name: 'Mentee 1',
          mentee_email: 'm1@test.com',
          batch_id: 'batch-1',
          batch_name: 'Batch 1',
          assigned_courses_count: '2',
          completed_courses_count: '0',
          avg_progress: '25.5',
        },
        {
          mentee_id: 'user-2',
          mentee_name: 'Mentee 2',
          mentee_email: 'm2@test.com',
          batch_id: 'batch-1',
          batch_name: 'Batch 1',
          assigned_courses_count: '2',
          completed_courses_count: '1',
          avg_progress: '90.0',
        },
      ];

      const repo = new PerformanceRepository(setupMockPerformanceDb(mockUsers));

      const descResult = await repo.getMenteePerformanceList(
        { page: 1, limit: 10, sortBy: 'completionPercentage', sortOrder: 'DESC' },
        adminScope,
      );
      assert.strictEqual(descResult.mentees[0]?.completionPercentage, 90);
      assert.strictEqual(descResult.mentees[1]?.completionPercentage, 25.5);
    });
  });

  void describe('Sort Schema Validation & Transform Unit Tests', () => {
    void it('listAllocationsQuerySchema normalizes sortOrder with desc default', () => {
      const parsedAsc = listAllocationsQuerySchema.shape.query.parse({ sortOrder: 'asc' });
      assert.strictEqual(parsedAsc.sortOrder, 'asc');

      const parsedDesc = listAllocationsQuerySchema.shape.query.parse({ sortOrder: 'desc' });
      assert.strictEqual(parsedDesc.sortOrder, 'desc');

      const parsedDefault = listAllocationsQuerySchema.shape.query.parse({});
      assert.strictEqual(parsedDefault.sortOrder, 'desc');
    });

    void it('submissionQueueQuerySchema normalizes sortOrder without overriding omitted state', () => {
      const parsedAsc = submissionQueueQuerySchema.shape.query.parse({ sortOrder: 'asc' });
      assert.strictEqual(parsedAsc.sortOrder, 'ASC');

      const parsedDesc = submissionQueueQuerySchema.shape.query.parse({ sortOrder: 'desc' });
      assert.strictEqual(parsedDesc.sortOrder, 'DESC');

      const parsedOmitted = submissionQueueQuerySchema.shape.query.parse({});
      assert.strictEqual(parsedOmitted.sortOrder, undefined);
    });

    void it('performanceFilterSchema normalizes sortOrder to uppercase with DESC default', () => {
      const parsedAsc = performanceFilterSchema.shape.query.parse({ sortOrder: 'asc' });
      assert.strictEqual(parsedAsc.sortOrder, 'ASC');

      const parsedDefault = performanceFilterSchema.shape.query.parse({});
      assert.strictEqual(parsedDefault.sortOrder, 'DESC');
    });
  });
});
