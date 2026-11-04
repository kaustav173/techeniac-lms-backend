import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';
import geoip from 'geoip-country';

export interface RequestContext {
  ipAddress?: string;
  country?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

export function isPrivateOrLocalIp(ip: string): boolean {
  const clean = (ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip).trim().toLowerCase();

  // Loopback / unspecified / local hostnames
  if (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === '::' ||
    clean === 'localhost' ||
    clean === '0.0.0.0'
  ) {
    return true;
  }

  // IPv4 Private (RFC 1918) & Link-Local (RFC 3927)
  if (
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    clean.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean)
  ) {
    return true;
  }

  // IPv6 Unique Local Address (fc00::/7 -> fc00... to fdff...)
  if (/^f[cd][0-9a-f]{2}:/i.test(clean) || clean.startsWith('fc00:') || clean.startsWith('fd00:')) {
    return true;
  }

  // IPv6 Link-Local (fe80::/10 -> fe80... to febf...)
  if (/^fe[89ab][0-9a-f]:/i.test(clean) || clean.startsWith('fe80:')) {
    return true;
  }

  return false;
}

export function resolveCountryName(countryCodeOrName: string): string {
  const code = countryCodeOrName.trim().toUpperCase();
  if (code.length === 2) {
    try {
      const region = REGION_NAMES.of(code);
      if (region) {
        return `${region} (${code})`;
      }
    } catch {
      // Intl fallback
    }
  }
  return countryCodeOrName.trim();
}

export function resolveClientIp(req: Request): string {
  // Trust only req.ip as resolved by Express with app.set('trust proxy', env.TRUST_PROXY_HOPS).
  // Attacker-controlled headers (e.g. x-real-ip, cf-connecting-ip) are ignored to prevent IP spoofing
  // and DB varchar(45) overflow attacks.
  const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  const clean = rawIp.startsWith('::ffff:') ? rawIp.replace('::ffff:', '') : rawIp;
  // Bound to 45 characters to strictly prevent database VARCHAR(45) column overflows
  return clean.slice(0, 45);
}

export function resolveCountry(ipAddress: string, req?: Request): string {
  if (isPrivateOrLocalIp(ipAddress)) {
    return 'Local Network';
  }

  // Real IP-to-country lookup
  const geo = geoip.lookup(ipAddress);
  if (geo?.country) {
    return resolveCountryName(geo.country);
  }

  // Edge reverse-proxy fallback headers if present in future edge environments
  if (req?.headers) {
    const countryHeader =
      req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['cloudfront-viewer-country'] ||
      req.headers['x-country-code'] ||
      req.headers['x-country'] ||
      req.headers['geoip-country-code'];

    if (typeof countryHeader === 'string' && countryHeader.trim().length > 0) {
      return resolveCountryName(countryHeader);
    }
  }

  return 'Public Network';
}

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const ipAddress = resolveClientIp(req);
  const country = resolveCountry(ipAddress, req);

  const context: RequestContext = {
    ipAddress,
    country,
  };

  requestContextStorage.run(context, () => {
    next();
  });
}
