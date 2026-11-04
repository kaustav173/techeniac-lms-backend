import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NextFunction, Request, Response } from 'express';

import {
  getRequestContext,
  isPrivateOrLocalIp,
  requestContextMiddleware,
  resolveClientIp,
  resolveCountry,
  resolveCountryName,
} from '../../src/core/http/request-context.middleware';

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: undefined,
    socket: {
      remoteAddress: undefined,
    },
    ...overrides,
  } as unknown as Request;
}

void describe('Request Context Middleware & Utilities Unit Tests', () => {
  void describe('isPrivateOrLocalIp', () => {
    void it('identifies loopback and local hostnames', () => {
      assert.equal(isPrivateOrLocalIp('127.0.0.1'), true);
      assert.equal(isPrivateOrLocalIp('localhost'), true);
      assert.equal(isPrivateOrLocalIp('0.0.0.0'), true);
      assert.equal(isPrivateOrLocalIp('::1'), true);
      assert.equal(isPrivateOrLocalIp('::'), true);
    });

    void it('identifies IPv4 private and link-local ranges', () => {
      assert.equal(isPrivateOrLocalIp('10.0.0.1'), true);
      assert.equal(isPrivateOrLocalIp('10.255.255.254'), true);
      assert.equal(isPrivateOrLocalIp('192.168.0.1'), true);
      assert.equal(isPrivateOrLocalIp('192.168.1.100'), true);
      assert.equal(isPrivateOrLocalIp('172.16.0.1'), true);
      assert.equal(isPrivateOrLocalIp('172.24.1.1'), true);
      assert.equal(isPrivateOrLocalIp('172.31.255.254'), true);
      assert.equal(isPrivateOrLocalIp('169.254.1.1'), true);
    });

    void it('does not flag public 172.x addresses as private', () => {
      assert.equal(isPrivateOrLocalIp('172.15.255.255'), false);
      assert.equal(isPrivateOrLocalIp('172.32.0.1'), false);
    });

    void it('identifies IPv6 unique local (fc00::/7) and link-local (fe80::/10)', () => {
      assert.equal(isPrivateOrLocalIp('fc00::1'), true);
      assert.equal(isPrivateOrLocalIp('fd12:3456:789a:1::1'), true);
      assert.equal(isPrivateOrLocalIp('fe80::1'), true);
      assert.equal(isPrivateOrLocalIp('fe80::1ff:fe00:3a60'), true);
    });

    void it('identifies IPv6-mapped IPv4 local addresses', () => {
      assert.equal(isPrivateOrLocalIp('::ffff:127.0.0.1'), true);
      assert.equal(isPrivateOrLocalIp('::ffff:10.1.2.3'), true);
      assert.equal(isPrivateOrLocalIp('::ffff:192.168.1.1'), true);
    });

    void it('identifies public IPv4 and IPv6 addresses as non-private', () => {
      assert.equal(isPrivateOrLocalIp('8.8.8.8'), false);
      assert.equal(isPrivateOrLocalIp('1.1.1.1'), false);
      assert.equal(isPrivateOrLocalIp('103.27.8.1'), false);
      assert.equal(isPrivateOrLocalIp('2606:4700:4700::1111'), false);
    });
  });

  void describe('resolveCountryName', () => {
    void it('resolves standard 2-letter uppercase ISO country codes with country name and code', () => {
      assert.equal(resolveCountryName('US'), 'United States (US)');
      assert.equal(resolveCountryName('IN'), 'India (IN)');
      assert.equal(resolveCountryName('GB'), 'United Kingdom (GB)');
    });

    void it('normalizes lowercase ISO codes', () => {
      assert.equal(resolveCountryName('us'), 'United States (US)');
      assert.equal(resolveCountryName('in'), 'India (IN)');
    });

    void it('falls back gracefully to input string for non-2-letter codes or unknown entries', () => {
      assert.equal(resolveCountryName('Local Network'), 'Local Network');
      assert.equal(resolveCountryName('Unknown Location'), 'Unknown Location');
      assert.equal(resolveCountryName('XYZ'), 'XYZ');
    });
  });

  void describe('resolveClientIp', () => {
    void it('uses req.ip as resolved by Express trust proxy', () => {
      const req = createMockRequest({ ip: '203.0.113.195' });
      assert.equal(resolveClientIp(req), '203.0.113.195');
    });

    void it('strips ::ffff: prefix from IPv6-mapped IPv4', () => {
      const req = createMockRequest({ ip: '::ffff:203.0.113.195' });
      assert.equal(resolveClientIp(req), '203.0.113.195');
    });

    void it('ignores attacker-controlled headers and strictly trusts req.ip', () => {
      const req = createMockRequest({
        ip: '203.0.113.50',
        headers: {
          'x-real-ip': '1.2.3.4',
          'cf-connecting-ip': '5.6.7.8',
          'true-client-ip': '9.10.11.12',
          'x-forwarded-for': '13.14.15.16',
        },
      });
      assert.equal(resolveClientIp(req), '203.0.113.50');
    });

    void it('falls back to socket.remoteAddress when req.ip is empty or undefined', () => {
      const req = createMockRequest({
        ip: undefined,
        socket: { remoteAddress: '198.51.100.22' } as Request['socket'],
      });
      assert.equal(resolveClientIp(req), '198.51.100.22');
    });

    void it('falls back to 127.0.0.1 when both req.ip and remoteAddress are missing', () => {
      const req = createMockRequest({ ip: undefined });
      assert.equal(resolveClientIp(req), '127.0.0.1');
    });

    void it('bounds IP string length to 45 characters preventing DB varchar(45) overflow', () => {
      const longIp = 'a'.repeat(80);
      const req = createMockRequest({ ip: longIp });
      const resolved = resolveClientIp(req);
      assert.equal(resolved.length, 45);
      assert.equal(resolved, 'a'.repeat(45));
    });
  });

  void describe('resolveCountry', () => {
    void it('returns Local Network for private or loopback IPs', () => {
      assert.equal(resolveCountry('127.0.0.1'), 'Local Network');
      assert.equal(resolveCountry('192.168.1.1'), 'Local Network');
      assert.equal(resolveCountry('10.0.0.1'), 'Local Network');
      assert.equal(resolveCountry('::1'), 'Local Network');
    });

    void it('resolves country name using offline GeoIP database for public IPs', () => {
      // 8.8.8.8 -> US
      const usResult = resolveCountry('8.8.8.8');
      assert.equal(usResult, 'United States (US)');

      // 103.27.8.1 -> IN
      const inResult = resolveCountry('103.27.8.1');
      assert.equal(inResult, 'India (IN)');
    });

    void it('falls back to valid edge country headers when IP is not present in GeoIP lookup', () => {
      const req = createMockRequest({
        headers: {
          'cf-ipcountry': 'JP',
        },
      });
      // Non-routable or missing GeoIP entry public test IP
      const result = resolveCountry('0.1.2.3', req);
      assert.equal(result, 'Japan (JP)');
    });

    void it('falls back to Public Network when GeoIP and headers are not available for public IP', () => {
      const req = createMockRequest({ headers: {} });
      const result = resolveCountry('0.1.2.3', req);
      assert.equal(result, 'Public Network');
    });
  });

  void describe('requestContextMiddleware', () => {
    void it('runs next() and populates getRequestContext with ipAddress and country', (t, done) => {
      const req = createMockRequest({
        ip: '8.8.8.8',
      });
      const res = {} as Response;
      const next: NextFunction = () => {
        const ctx = getRequestContext();
        assert.ok(ctx);
        assert.equal(ctx.ipAddress, '8.8.8.8');
        assert.equal(ctx.country, 'United States (US)');
        done();
      };

      requestContextMiddleware(req, res, next);
    });

    void it('leaves getRequestContext undefined outside middleware invocation', () => {
      assert.equal(getRequestContext(), undefined);
    });
  });
});
