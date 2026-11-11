import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityManager, SelectQueryBuilder } from 'typeorm';

import { type User, userQuerySchema, UserRepository, UserRole } from '../../src/modules/users';

void describe('Users Query & withoutActiveBatch Filter Unit Tests', () => {
  void describe('userQuerySchema Parsing', () => {
    void it('parses withoutActiveBatch="true" as boolean true', () => {
      const parsed = userQuerySchema.parse({ withoutActiveBatch: 'true' });
      assert.strictEqual(parsed.withoutActiveBatch, true);
    });

    void it('parses withoutActiveBatch="false" as boolean false', () => {
      const parsed = userQuerySchema.parse({ withoutActiveBatch: 'false' });
      assert.strictEqual(parsed.withoutActiveBatch, false);
    });

    void it('parses withoutActiveBatch=true as boolean true', () => {
      const parsed = userQuerySchema.parse({ withoutActiveBatch: true });
      assert.strictEqual(parsed.withoutActiveBatch, true);
    });

    void it('leaves withoutActiveBatch undefined when omitted', () => {
      const parsed = userQuerySchema.parse({});
      assert.strictEqual(parsed.withoutActiveBatch, undefined);
    });

    void it('rejects non-boolean strings with validation error', () => {
      const result = userQuerySchema.safeParse({ withoutActiveBatch: 'invalid' });
      assert.strictEqual(result.success, false);
    });

    void it('parses single valid UUID mentorId', () => {
      const parsed = userQuerySchema.parse({ mentorId: '11111111-1111-1111-1111-111111111111' });
      assert.deepStrictEqual(parsed.mentorId, ['11111111-1111-1111-1111-111111111111']);
    });

    void it('parses comma-separated UUIDs mentorId and normalizes whitespace', () => {
      const parsed = userQuerySchema.parse({
        mentorId: '11111111-1111-1111-1111-111111111111,  22222222-2222-2222-2222-222222222222  ',
      });
      assert.deepStrictEqual(parsed.mentorId, [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ]);
    });

    void it('parses array of UUID strings mentorId into array', () => {
      const parsed = userQuerySchema.parse({
        mentorId: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        ] as unknown as string,
      });
      assert.deepStrictEqual(parsed.mentorId, [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ]);
    });

    void it('converts empty string mentorId to undefined', () => {
      const parsed = userQuerySchema.parse({ mentorId: '   ' });
      assert.strictEqual(parsed.mentorId, undefined);
    });

    void it('converts empty array mentorId to undefined', () => {
      const parsed = userQuerySchema.parse({ mentorId: [] as unknown as string });
      assert.strictEqual(parsed.mentorId, undefined);
    });

    void it('leaves mentorId undefined when omitted', () => {
      const parsed = userQuerySchema.parse({});
      assert.strictEqual(parsed.mentorId, undefined);
    });

    void it('rejects invalid UUID in mentorId', () => {
      const result = userQuerySchema.safeParse({ mentorId: 'not-a-uuid' });
      assert.strictEqual(result.success, false);
    });

    void it('rejects comma-separated list containing any invalid UUID', () => {
      const result = userQuerySchema.safeParse({
        mentorId: '11111111-1111-1111-1111-111111111111,invalid-uuid',
      });
      assert.strictEqual(result.success, false);
    });

    void it('rejects more than 20 mentor IDs with validation error', () => {
      const ids = Array.from(
        { length: 21 },
        (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      );
      const result = userQuerySchema.safeParse({ mentorId: ids });
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.match(result.error.errors[0]?.message ?? '', /At most 20 mentor IDs/);
      }
    });

    void it('parses single, comma-separated, and array role/status filters with normalization', () => {
      const csvParsed = userQuerySchema.parse({
        role: 'super_admin, mentor',
        status: 'ACTIVE, pending',
        sortBy: 'status',
        sortOrder: 'asc',
      });
      assert.deepStrictEqual(csvParsed.role, [UserRole.SUPER_ADMIN, UserRole.MENTOR]);
      assert.deepStrictEqual(csvParsed.status, ['active', 'pending']);
      assert.strictEqual(csvParsed.sortBy, 'status');
      assert.strictEqual(csvParsed.sortOrder, 'asc');

      const arrParsed = userQuerySchema.parse({
        role: ['MENTEE', 'mentor'] as unknown as string,
        status: ['INACTIVE', 'Pending'] as unknown as string,
      });
      assert.deepStrictEqual(arrParsed.role, [UserRole.MENTEE, UserRole.MENTOR]);
      assert.deepStrictEqual(arrParsed.status, ['inactive', 'pending']);
    });

    void it('normalizes empty strings and empty arrays for role and status to undefined', () => {
      const emptyStr = userQuerySchema.parse({ role: '   ', status: '' });
      assert.strictEqual(emptyStr.role, undefined);
      assert.strictEqual(emptyStr.status, undefined);

      const emptyArr = userQuerySchema.parse({
        role: [] as unknown as string,
        status: ['  '] as unknown as string,
      });
      assert.strictEqual(emptyArr.role, undefined);
      assert.strictEqual(emptyArr.status, undefined);
    });
  });

  void describe('UserRepository.findAll Query Construction', () => {
    function createMockQueryBuilder() {
      const andWhereClauses: string[] = [];
      const capturedParams: Record<string, unknown>[] = [];
      const orderBys: Array<{ column: string; order?: string }> = [];
      const qb = {
        where: () => qb,
        andWhere: (clause: string, params?: unknown) => {
          andWhereClauses.push(clause);
          if (params) capturedParams.push(params as Record<string, unknown>);
          return qb;
        },
        orderBy: (column: string, order?: string) => {
          orderBys.push({ column, order });
          return qb;
        },
        addOrderBy: (column: string, order?: string) => {
          orderBys.push({ column, order });
          return qb;
        },
        skip: () => qb,
        take: () => qb,
        getManyAndCount: () => Promise.resolve([[], 0] as [User[], number]),
      };
      return {
        qb: qb as unknown as SelectQueryBuilder<User>,
        andWhereClauses,
        capturedParams,
        orderBys,
      };
    }

    void it('appends NOT EXISTS when withoutActiveBatch is true', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10, withoutActiveBatch: true }, mockManager);

      const hasNotExists = andWhereClauses.some(
        (c) =>
          c.includes('NOT EXISTS') &&
          c.includes('batch_members bm') &&
          c.includes("bm.member_role = 'MENTEE'"),
      );
      assert.strictEqual(hasNotExists, true);
      assert.strictEqual(
        andWhereClauses.some((c) => c.includes("b.status IN ('DRAFT', 'LIVE', 'ON_HOLD')")),
        true,
      );
    });

    void it('appends active mentee batch check when role is MENTOR and withoutActiveBatch is true', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll(
        { page: 1, limit: 10, role: UserRole.MENTOR, withoutActiveBatch: true },
        mockManager,
      );

      const hasRoleClause = andWhereClauses.some((c) => c.includes('user.role = :role'));
      assert.strictEqual(hasRoleClause, true);

      const hasMenteeScopedSubquery = andWhereClauses.some(
        (c) =>
          c.includes('NOT EXISTS') &&
          c.includes('batch_members bm') &&
          c.includes("bm.member_role = 'MENTEE'"),
      );
      assert.strictEqual(hasMenteeScopedSubquery, true);
    });

    void it('appends EXISTS when withoutActiveBatch is false', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10, withoutActiveBatch: false }, mockManager);

      const hasExists = andWhereClauses.some(
        (c) => c.includes('EXISTS') && !c.includes('NOT EXISTS') && c.includes('batch_members bm'),
      );
      assert.strictEqual(hasExists, true);
    });

    void it('does not append active batch subquery when withoutActiveBatch is omitted', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10 }, mockManager);

      const hasBatchCheck = andWhereClauses.some((c) => c.includes('batch_members bm'));
      assert.strictEqual(hasBatchCheck, false);
    });

    void it('appends EXISTS with IN (:...mentorIds) when 1 mentor is passed', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses, capturedParams } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll(
        { page: 1, limit: 10, mentorId: ['11111111-1111-1111-1111-111111111111'] },
        mockManager,
      );

      const hasMentorClause = andWhereClauses.some(
        (c) =>
          c.includes('EXISTS') &&
          c.includes('mentor_mentees mm') &&
          c.includes('mm.mentor_id IN (:...mentorIds)'),
      );
      assert.strictEqual(hasMentorClause, true);
      assert.deepStrictEqual(
        capturedParams.find((p) => 'mentorIds' in p),
        { mentorIds: ['11111111-1111-1111-1111-111111111111'] },
      );
    });

    void it('appends EXISTS with IN (:...mentorIds) providing OR semantics when multiple mentors are passed', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses, capturedParams } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll(
        {
          page: 1,
          limit: 10,
          mentorId: '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222',
        },
        mockManager,
      );

      const hasMultiMentorClause = andWhereClauses.some(
        (c) =>
          c.includes('EXISTS') &&
          c.includes('mentor_mentees mm') &&
          c.includes('mm.mentor_id IN (:...mentorIds)'),
      );
      assert.strictEqual(hasMultiMentorClause, true);
      assert.deepStrictEqual(
        capturedParams.find((p) => 'mentorIds' in p),
        {
          mentorIds: [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
          ],
        },
      );
    });

    void it('does not append mentor EXISTS clause when mentorId is omitted', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10 }, mockManager);

      const hasMentorClause = andWhereClauses.some((c) => c.includes('mentor_mentees mm'));
      assert.strictEqual(hasMentorClause, false);
    });

    void it('scopes status=pending to active users and supports multi-role IN clause', async () => {
      const repo = new UserRepository();
      const { qb, andWhereClauses, capturedParams } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll(
        {
          page: 1,
          limit: 10,
          role: [UserRole.SUPER_ADMIN, UserRole.MENTOR],
          status: ['pending', 'inactive'],
          search: '100%_test\\user',
        },
        mockManager,
      );

      assert.strictEqual(
        andWhereClauses.some((c) => c.includes('user.role IN (:...roles)')),
        true,
      );
      assert.strictEqual(
        andWhereClauses.some(
          (c) =>
            c.includes(
              '(user.is_active = true AND (user.must_change_password = true OR user.last_login_at IS NULL))',
            ) && c.includes('(user.is_active = false)'),
        ),
        true,
      );
      assert.deepStrictEqual(
        capturedParams.find((p) => 'search' in p),
        { search: '%100\\%\\_test\\\\user%' },
      );
    });

    void it('orders status sort by is_active, derived pending state, and deterministic tie-breakers', async () => {
      const repo = new UserRepository();
      const { qb, orderBys } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10, sortBy: 'status', sortOrder: 'desc' }, mockManager);

      assert.deepStrictEqual(orderBys, [
        { column: 'user.is_active', order: 'DESC' },
        {
          column: '(user.must_change_password = true OR user.last_login_at IS NULL)',
          order: 'ASC',
        },
        { column: 'user.created_at', order: 'DESC' },
        { column: 'user.id', order: 'ASC' },
      ]);
    });

    void it('orders name sort case-insensitively with created_at and id tie-breakers', async () => {
      const repo = new UserRepository();
      const { qb, orderBys } = createMockQueryBuilder();
      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => qb,
        }),
      } as unknown as EntityManager;

      await repo.findAll({ page: 1, limit: 10, sortBy: 'name', sortOrder: 'asc' }, mockManager);

      assert.deepStrictEqual(orderBys, [
        { column: 'LOWER(user.name)', order: 'ASC' },
        { column: 'user.created_at', order: 'DESC' },
        { column: 'user.id', order: 'ASC' },
      ]);
    });

    void it('computes total, active, pending, and inactive counts in getCounts using matching status predicates', async () => {
      const repo = new UserRepository();
      const selectCalls: Array<{ expr: string; alias?: string }> = [];
      const whereClauses: string[] = [];

      const countQb = {
        select: (expr: string, alias?: string) => {
          selectCalls.push({ expr, alias });
          return countQb;
        },
        addSelect: (expr: string, alias?: string) => {
          selectCalls.push({ expr, alias });
          return countQb;
        },
        where: (clause: string) => {
          whereClauses.push(clause);
          return countQb;
        },
        getRawOne: () => Promise.resolve({ total: '12', active: '7', pending: '3', inactive: '2' }),
      };

      const mockManager = {
        getRepository: () => ({
          createQueryBuilder: () => countQb,
        }),
      } as unknown as EntityManager;

      const counts = await repo.getCounts(mockManager);

      assert.deepStrictEqual(counts, { total: 12, active: 7, pending: 3, inactive: 2 });
      assert.strictEqual(
        whereClauses.some((c) => c.includes('user.deleted_at IS NULL')),
        true,
      );
      const pendingSelect = selectCalls.find((s) => s.alias === 'pending')?.expr ?? '';
      assert.strictEqual(
        pendingSelect.includes('user.is_active = true') &&
          pendingSelect.includes('user.must_change_password = true'),
        true,
      );
    });

    void it('defaults sortBy to createdAt and sortOrder to desc in userQuerySchema', () => {
      const parsed = userQuerySchema.parse({});
      assert.strictEqual(parsed.sortBy, 'createdAt');
      assert.strictEqual(parsed.sortOrder, 'desc');
    });
  });
});
