import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { AuditLog, auditRepository, AuditType } from '../../src/modules/audit';
import { type User, userRepository, UserRole } from '../../src/modules/users';
import { createMockAuditLog } from '../fixtures/audit.fixture';

interface AuditResponseBody {
  success: boolean;
  data: AuditLog[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

void describe('Audit Log API Integration Tests (Module 14: AUD-01 to AUD-05)', () => {
  let server: Server;
  let baseUrl: string;

  const adminId = '11111111-2222-4333-8444-555555555555';
  const mentorId = '22222222-3333-4444-8555-666666666666';
  const menteeId = '33333333-4444-4555-8666-777777777777';

  let tokenAdmin: string;
  let tokenMentor: string;
  let tokenMentee: string;

  const origFindById = userRepository.findById.bind(userRepository);
  const origFindWithFilters = auditRepository.findWithFilters.bind(auditRepository);

  before(async () => {
    userRepository.findById = (id: string): Promise<User | null> => {
      if (id === adminId) {
        return Promise.resolve({
          id: adminId,
          email: 'admin@TechEniac.com',
          name: 'Super Admin',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === mentorId) {
        return Promise.resolve({
          id: mentorId,
          email: 'mentor@TechEniac.com',
          name: 'Mentor User',
          role: UserRole.MENTOR,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === menteeId) {
        return Promise.resolve({
          id: menteeId,
          email: 'mentee@TechEniac.com',
          name: 'Mentee User',
          role: UserRole.MENTEE,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      return Promise.resolve(null);
    };

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

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 4000;
    baseUrl = `http://127.0.0.1:${port}/api/v1/logs`;
  });

  beforeEach(() => {
    auditRepository.findWithFilters = () => Promise.resolve({ items: [], total: 0 });
  });

  after(() => {
    userRepository.findById = origFindById;
    auditRepository.findWithFilters = origFindWithFilters;
    server.close();
  });

  void it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 401);
  });

  void it('AUD-05: blocks non-admin MENTEE with 403 Forbidden', async () => {
    const res = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${tokenMentee}` },
    });
    assert.equal(res.status, 403);
  });

  void it('AUD-05: blocks non-admin MENTOR with 403 Forbidden', async () => {
    const res = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${tokenMentor}` },
    });
    assert.equal(res.status, 403);
  });

  void it('AUD-01: Super Admin can query audit logs with type=USER and action=ROLE_CHANGE', async () => {
    auditRepository.findWithFilters = (params) => {
      assert.equal(params.type, AuditType.USER);
      assert.equal(params.action, 'ROLE_CHANGE');
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-1',
            actorId: adminId,
            type: AuditType.USER,
            entity: 'User',
            entityId: menteeId,
            action: 'ROLE_CHANGE',
            oldValue: { role: 'MENTEE' },
            newValue: { role: 'MENTOR', reason: 'Promotion' },
          }),
        ],
        total: 1,
      });
    };

    const res = await fetch(`${baseUrl}?type=USER&action=ROLE_CHANGE`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.action, 'ROLE_CHANGE');
    assert.equal(body.meta.total, 1);
  });

  void it('AUD-02: Super Admin can filter by type=COURSE to view course live edits', async () => {
    auditRepository.findWithFilters = (params) => {
      assert.equal(params.type, AuditType.COURSE);
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-course-1',
            actorId: adminId,
            type: AuditType.COURSE,
            entity: 'Course',
            entityId: 'course-1',
            action: 'LIVE_EDIT',
            oldValue: { title: 'Old Title' },
            newValue: { title: 'New Title' },
          }),
        ],
        total: 1,
      });
    };

    const res = await fetch(`${baseUrl}?type=COURSE`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data[0]?.type, AuditType.COURSE);
    assert.equal(body.data[0]?.action, 'LIVE_EDIT');
  });

  void it('AUD-03: Super Admin can filter by type=BATCH to view batch status changes', async () => {
    auditRepository.findWithFilters = (params) => {
      assert.equal(params.type, AuditType.BATCH);
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-batch-1',
            actorId: adminId,
            type: AuditType.BATCH,
            entity: 'Batch',
            entityId: 'batch-1',
            action: 'STATUS_CHANGE',
            oldValue: { status: 'DRAFT' },
            newValue: { status: 'LIVE' },
          }),
        ],
        total: 1,
      });
    };

    const res = await fetch(`${baseUrl}?type=BATCH`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data[0]?.type, AuditType.BATCH);
    assert.equal(body.data[0]?.action, 'STATUS_CHANGE');
  });

  void it('AUD-04: Super Admin can filter by type=AUTH for logins and failed logins', async () => {
    auditRepository.findWithFilters = (params) => {
      assert.equal(params.type, AuditType.AUTH);
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-auth-1',
            actorId: null,
            type: AuditType.AUTH,
            entity: 'User',
            action: 'FAILED_LOGIN',
            oldValue: { email: 'bad@external.com' },
          }),
        ],
        total: 1,
      });
    };

    const res = await fetch(`${baseUrl}?type=AUTH`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data[0]?.type, AuditType.AUTH);
    assert.equal(body.data[0]?.actorId, null);
  });

  void it('returns 400 Bad Request if invalid type enum is supplied', async () => {
    const res = await fetch(`${baseUrl}?type=INVALID_TYPE`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 400);
  });

  void it('returns 400 Bad Request if invalid actorId UUID format is supplied', async () => {
    const res = await fetch(`${baseUrl}?actorId=not-a-valid-uuid`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 400);
  });

  void it('returns 400 Bad Request if limit exceeds 100', async () => {
    const res = await fetch(`${baseUrl}?limit=500`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 400);
  });

  void it('supports pagination with custom page and limit', async () => {
    auditRepository.findWithFilters = (params) => {
      assert.equal(params.page, 3);
      assert.equal(params.limit, 15);
      return Promise.resolve({
        items: [],
        total: 42,
      });
    };

    const res = await fetch(`${baseUrl}?page=3&limit=15`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.meta.page, 3);
    assert.equal(body.meta.limit, 15);
    assert.equal(body.meta.total, 42);
    assert.equal(body.meta.totalPages, 3);
  });

  void it('returns 400 Bad Request if startDate is after endDate', async () => {
    const res = await fetch(`${baseUrl}?startDate=2026-03-10&endDate=2026-03-01`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 400);
  });

  void it('accepts valid date range filtering', async () => {
    let capturedStartDate: string | undefined;
    let capturedEndDate: string | undefined;

    auditRepository.findWithFilters = (params) => {
      capturedStartDate = params.startDate;
      capturedEndDate = params.endDate;
      return Promise.resolve({
        items: [],
        total: 0,
      });
    };

    const res = await fetch(`${baseUrl}?startDate=2026-03-01&endDate=2026-03-10`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    assert.equal(capturedStartDate, '2026-03-01');
    assert.equal(capturedEndDate, '2026-03-10');
  });

  void it('supports multi-type filtering with types=AUTH,USER', async () => {
    let capturedTypes: AuditType[] | undefined;

    auditRepository.findWithFilters = (params) => {
      capturedTypes = params.types;
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-types-1',
            type: AuditType.AUTH,
            action: 'LOGIN',
            entity: 'User',
          }),
          createMockAuditLog({
            id: 'audit-types-2',
            type: AuditType.USER,
            action: 'USER_CREATED',
            entity: 'User',
          }),
        ],
        total: 2,
      });
    };

    const res = await fetch(`${baseUrl}?types=AUTH,USER`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data.length, 2);
    assert.deepEqual(capturedTypes, [AuditType.AUTH, AuditType.USER]);
  });

  void it('supports free-text search across actor, entity, action, and payloads', async () => {
    let capturedSearch: string | undefined;

    auditRepository.findWithFilters = (params) => {
      capturedSearch = params.search;
      return Promise.resolve({
        items: [
          createMockAuditLog({
            id: 'audit-search-1',
            type: AuditType.USER,
            action: 'ROLE_CHANGE',
            entity: 'User',
            newValue: { name: 'Mentee One' },
          }),
        ],
        total: 1,
      });
    };

    const res = await fetch(`${baseUrl}?search=Mentee`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as AuditResponseBody;
    assert.equal(body.success, true);
    assert.equal(body.data.length, 1);
    assert.equal(capturedSearch, 'Mentee');
  });

  void it('supports custom sortOrder=asc', async () => {
    let capturedSortOrder: string | undefined;

    auditRepository.findWithFilters = (params) => {
      capturedSortOrder = params.sortOrder;
      return Promise.resolve({
        items: [],
        total: 0,
      });
    };

    const res = await fetch(`${baseUrl}?sortOrder=asc`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });

    assert.equal(res.status, 200);
    assert.equal(capturedSortOrder, 'asc');
  });
});
