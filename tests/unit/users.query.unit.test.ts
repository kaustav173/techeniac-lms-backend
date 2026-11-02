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
  });

  void describe('UserRepository.findAll Query Construction', () => {
    function createMockQueryBuilder() {
      const andWhereClauses: string[] = [];
      const qb = {
        where: () => qb,
        andWhere: (clause: string) => {
          andWhereClauses.push(clause);
          return qb;
        },
        orderBy: () => qb,
        skip: () => qb,
        take: () => qb,
        getManyAndCount: () => Promise.resolve([[], 0] as [User[], number]),
      };
      return { qb: qb as unknown as SelectQueryBuilder<User>, andWhereClauses };
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
  });
});
