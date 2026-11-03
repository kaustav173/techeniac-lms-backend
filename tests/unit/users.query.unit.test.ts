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
  });

  void describe('UserRepository.findAll Query Construction', () => {
    function createMockQueryBuilder() {
      const andWhereClauses: string[] = [];
      const capturedParams: Record<string, unknown>[] = [];
      const qb = {
        where: () => qb,
        andWhere: (clause: string, params?: unknown) => {
          andWhereClauses.push(clause);
          if (params) capturedParams.push(params as Record<string, unknown>);
          return qb;
        },
        orderBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getManyAndCount: () => Promise.resolve([[], 0] as [User[], number]),
      };
      return { qb: qb as unknown as SelectQueryBuilder<User>, andWhereClauses, capturedParams };
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
  });
});
