import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { app } from '../../src/app';
import { signAccessToken } from '../../src/core/auth';
import { env } from '../../src/core/config';
import { type AuthResult, authService } from '../../src/modules/auth';
import { type User, userRepository, UserRole } from '../../src/modules/users';

const session: AuthResult = {
  user: {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Session Fixture',
    email: 'session-fixture@example.com',
    role: UserRole.SUPER_ADMIN,
    mustChangePassword: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  tokens: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' },
};
const credentials = { email: session.user.email, password: 'LocalFixture123!' };

void describe('Auth response modes', () => {
  let server: Server;
  let authUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    authUrl = `http://127.0.0.1:${address.port}/api/v1/auth`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${authUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const readSession = async (response: Response): Promise<Partial<AuthResult>> => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const json = (await response.json()) as { data: Partial<AuthResult> };
    assert.equal(json.data.user?.id, session.user.id);
    return json.data;
  };

  const assertCookieSession = async (response: Response): Promise<void> => {
    assert.equal(Object.hasOwn(await readSession(response), 'tokens'), false);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const [name, value] of Object.entries(session.tokens)) {
      assert.ok(cookies.some((cookie) => cookie.startsWith(`${name}=${value};`)));
    }
    assert.ok(cookies.every((cookie) => cookie.includes('HttpOnly')));
  };

  void it('returns HttpOnly cookies and a token-free body on browser login and refresh', async (t) => {
    t.mock.method(authService, 'login', () => Promise.resolve(session));
    const refresh = t.mock.method(authService, 'refresh', () => Promise.resolve(session));
    const browserHeaders = { Origin: new URL(env.FRONTEND_URL).origin };

    await assertCookieSession(await post('login', credentials, browserHeaders));
    await assertCookieSession(
      await post(
        'refresh',
        {},
        { ...browserHeaders, Cookie: 'refreshToken=browser-session-fixture' },
      ),
    );
    assert.deepEqual(refresh.mock.calls[0]?.arguments, ['browser-session-fixture']);
  });

  void it('renews browser cookies after a password change without returning tokens', async (t) => {
    t.mock.method(userRepository, 'findById', () =>
      Promise.resolve({ ...session.user, tokenVersion: 1 } as User),
    );
    t.mock.method(authService, 'changePassword', () => Promise.resolve(session));
    const accessToken = signAccessToken({
      sub: session.user.id,
      email: session.user.email,
      role: session.user.role,
      tokenVersion: 1,
    });
    await assertCookieSession(
      await post(
        'change-password',
        { currentPassword: credentials.password, newPassword: 'NewFixture123!' },
        { Origin: new URL(env.FRONTEND_URL).origin, Cookie: `accessToken=${accessToken}` },
      ),
    );
  });

  void it('returns JSON tokens only for explicit non-browser bearer login and refresh', async (t) => {
    t.mock.method(authService, 'login', () => Promise.resolve(session));
    const refresh = t.mock.method(authService, 'refresh', () => Promise.resolve(session));
    const mode = { 'X-Auth-Mode': 'bearer' };

    const login = await post('login', credentials, mode);
    assert.deepEqual((await readSession(login)).tokens, session.tokens);
    assert.deepEqual(login.headers.getSetCookie(), []);

    const rotated = await post('refresh', { refreshToken: 'bearer-session-fixture' }, mode);
    assert.deepEqual((await readSession(rotated)).tokens, session.tokens);
    assert.deepEqual(rotated.headers.getSetCookie(), []);
    assert.deepEqual(refresh.mock.calls[0]?.arguments, ['bearer-session-fixture']);
  });

  void it('refuses bearer mode for browser or cookie-bearing requests before issuing a session', async (t) => {
    const login = t.mock.method(authService, 'login', () => Promise.resolve(session));
    const browserRequests: Array<Record<string, string>> = [
      { Origin: new URL(env.FRONTEND_URL).origin },
      { Cookie: 'refreshToken=browser-session-fixture' },
      { 'Sec-Fetch-Site': 'same-origin' },
    ];
    for (const headers of browserRequests) {
      const response = await post('login', credentials, {
        ...headers,
        'X-Auth-Mode': 'bearer',
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), {
        error: {
          code: 'AUTH_MODE_FORBIDDEN',
          message: 'Bearer mode requires a non-browser client without cookies',
        },
      });
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
    assert.equal(login.mock.callCount(), 0);
  });

  void it('marks auth responses as no-store even when request parsing fails', async () => {
    const response = await fetch(`${authUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    await response.body?.cancel();
  });
});
