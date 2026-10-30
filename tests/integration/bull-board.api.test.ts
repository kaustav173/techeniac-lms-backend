import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { type User, userRepository, UserRole } from '../../src/modules/users';

void describe('Bull Board API Integration Tests (/admin/queues)', () => {
  let server: Server;
  let baseUrl: string;

  const adminId = '11111111-2222-4333-8444-555555555555';
  const mentorId = '22222222-3333-4444-8555-666666666666';
  const menteeId = '33333333-4444-4555-8666-777777777777';

  let tokenAdmin: string;
  let tokenMentor: string;
  let tokenMentee: string;

  const origFindById = userRepository.findById.bind(userRepository);

  before(async () => {
    userRepository.findById = (id: string): Promise<User | null> => {
      if (id === adminId) {
        return Promise.resolve({
          id: adminId,
          email: 'admin@techeniac.com',
          name: 'Super Admin',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === mentorId) {
        return Promise.resolve({
          id: mentorId,
          email: 'mentor@techeniac.com',
          name: 'Mentor User',
          role: UserRole.MENTOR,
          isActive: true,
          tokenVersion: 1,
        } as User);
      }
      if (id === menteeId) {
        return Promise.resolve({
          id: menteeId,
          email: 'mentee@techeniac.com',
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
      email: 'admin@techeniac.com',
      role: UserRole.SUPER_ADMIN,
      tokenVersion: 1,
    });

    tokenMentor = signAccessToken({
      sub: mentorId,
      email: 'mentor@techeniac.com',
      role: UserRole.MENTOR,
      tokenVersion: 1,
    });

    tokenMentee = signAccessToken({
      sub: menteeId,
      email: 'mentee@techeniac.com',
      role: UserRole.MENTEE,
      tokenVersion: 1,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    userRepository.findById = origFindById;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  void it('returns 401 Unauthorized when accessing /admin/queues without credentials', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  void it('returns 403 Forbidden when accessing /admin/queues with MENTEE token', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, {
      headers: { Authorization: `Bearer ${tokenMentee}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  void it('returns 403 Forbidden when accessing /admin/queues with MENTOR token', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, {
      headers: { Authorization: `Bearer ${tokenMentor}` },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  void it('returns 200 OK with HTML content when accessing /admin/queues with SUPER_ADMIN Bearer token', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `Expected HTML content-type, got: ${contentType}`);
    const html = await res.text();
    assert.ok(html.length > 50, 'Expected non-empty HTML response');
  });

  void it('returns 200 OK when accessing /admin/queues with SUPER_ADMIN accessToken cookie', async () => {
    const res = await fetch(`${baseUrl}/admin/queues`, {
      headers: { Cookie: `accessToken=${tokenAdmin}` },
    });
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `Expected HTML content-type, got: ${contentType}`);
  });
});
