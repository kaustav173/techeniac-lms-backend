import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  ipAddress?: string;
  country?: string;
  userAgent?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

function isPrivateOrLocalIp(ip: string): boolean {
  const clean = ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip;
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost' || clean === '0.0.0.0') {
    return true;
  }
  if (
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)
  ) {
    return true;
  }
  return false;
}

function resolveCountryName(countryCodeOrName: string): string {
  const code = countryCodeOrName.trim().toUpperCase();
  if (code.length === 2) {
    try {
      const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
      const region = regionNames.of(code);
      if (region) {
        return `${region} (${code})`;
      }
    } catch {
      // Intl fallback
    }
  }
  return countryCodeOrName.trim();
}

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // Check cloud and reverse-proxy headers in priority order
  const cfIp =
    typeof req.headers['cf-connecting-ip'] === 'string'
      ? req.headers['cf-connecting-ip'].trim()
      : '';
  const trueClientIp =
    typeof req.headers['true-client-ip'] === 'string' ? req.headers['true-client-ip'].trim() : '';
  const realIp =
    typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : '';

  const forwarded = req.headers['x-forwarded-for'];
  let forwardedIp = '';
  if (typeof forwarded === 'string') {
    forwardedIp = forwarded.split(',')[0]?.trim() || '';
  } else if (Array.isArray(forwarded)) {
    forwardedIp = forwarded[0]?.trim() || '';
  }

  const rawIp =
    cfIp ||
    trueClientIp ||
    realIp ||
    forwardedIp ||
    req.ip ||
    req.socket.remoteAddress ||
    '127.0.0.1';

  // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:192.168.1.1 -> 192.168.1.1)
  const ipAddress = rawIp.startsWith('::ffff:') ? rawIp.replace('::ffff:', '') : rawIp;

  // Cloud geolocation headers (Cloudflare, AWS CloudFront, Vercel, standard geo reverse-proxy)
  const countryHeader =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['cloudfront-viewer-country'] ||
    req.headers['x-country-code'] ||
    req.headers['x-country'] ||
    req.headers['geoip-country-code'];

  let country = 'Unknown Location';
  if (typeof countryHeader === 'string' && countryHeader.trim().length > 0) {
    country = resolveCountryName(countryHeader);
  } else if (isPrivateOrLocalIp(ipAddress)) {
    country = 'Local Network';
  } else {
    country = 'Public Network';
  }

  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

  const context: RequestContext = {
    ipAddress,
    country,
    userAgent,
  };

  requestContextStorage.run(context, () => {
    next();
  });
}
