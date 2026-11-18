import type { RequestHandler } from 'express';

import { env } from '../config';
import { ForbiddenError } from '../errors';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const trustedOrigins = new Set(
  [env.FRONTEND_URL, ...env.CORS_ORIGINS].map((url) => new URL(url).origin),
);

export const csrfMiddleware: RequestHandler = (req, _res, next) => {
  if (safeMethods.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('Origin');
  const referer = req.get('Referer');
  const fetchSite = req.get('Sec-Fetch-Site');
  const requestOrigin =
    origin ?? (referer && URL.canParse(referer) ? new URL(referer).origin : undefined);

  if (
    requestOrigin !== 'null' &&
    (fetchSite === 'same-origin' ||
      (requestOrigin !== undefined && trustedOrigins.has(requestOrigin)))
  ) {
    next();
    return;
  }

  if (origin === undefined && referer === undefined && fetchSite === undefined) {
    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const hasSessionCookie =
      cookies.accessToken !== undefined || cookies.refreshToken !== undefined;
    const isSimpleBody = req.is([
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain',
    ]);

    // Server clients can submit JSON. Cross-origin browsers must preflight this content type.
    if (req.is('application/json') || (!hasSessionCookie && !isSimpleBody)) {
      next();
      return;
    }
  }

  next(new ForbiddenError('Request origin could not be verified', 'CSRF_ORIGIN_REJECTED'));
};
