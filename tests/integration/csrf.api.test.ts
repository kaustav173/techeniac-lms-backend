import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { app } from '../../src/app';
import { env } from '../../src/core/config';

void describe('API request origin checks', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  void it('rejects writes whose browser origin cannot be verified', async () => {
    for (const headers of [
      { Origin: 'https://untrusted.invalid' },
      { Origin: 'null' },
      { Referer: 'https://untrusted.invalid/page' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Cookie: 'refreshToken=fixture' },
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: new Headers(Object.entries(headers)),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: { code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin could not be verified' },
      });
    }
  });

  void it('accepts the configured frontend, same-origin requests, and server JSON clients', async () => {
    const origin = new URL(env.FRONTEND_URL).origin;
    for (const headers of [
      { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
      { Referer: `${origin}/login` },
      { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      { 'Content-Type': 'application/json' },
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: new Headers([...Object.entries(headers), ['Cookie', 'refreshToken=fixture']]),
        ...(headers['Content-Type'] ? { body: '{}' } : {}),
      });
      assert.equal(response.status, 200);
      await response.body?.cancel();
    }
  });

  void it('rejects an originless browser form submission', async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      body: new URLSearchParams({ fixture: 'value' }),
    });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  });

  void it('keeps safe methods and CORS preflight available', async () => {
    const headers = { Origin: 'https://untrusted.invalid' };
    const read = await fetch(`${baseUrl}/api/v1`, { headers });
    assert.equal(read.status, 200);
    await read.body?.cancel();

    const preflight = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'OPTIONS',
      headers,
    });
    assert.equal(preflight.status, 204);
  });
});
