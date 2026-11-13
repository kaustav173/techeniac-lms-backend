import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { StatusCodes } from 'http-status-codes';

import { env } from '../config';

const rateLimitHandler = (_req: Request, res: Response) => {
  res.status(StatusCodes.TOO_MANY_REQUESTS).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
    },
  });
};

/**
 * Note on rate limiter topology & multi-instance deployment:
 * 1. Client IP resolution depends on `app.set('trust proxy', env.TRUST_PROXY_HOPS)` matching
 *    the deployment reverse-proxy hop depth. If TRUST_PROXY_HOPS is misconfigured, either
 *    client IPs will collapse into proxy IPs or allow header spoofing.
 * 2. In-memory storage is per-instance (MemoryStore). When scaling horizontally across
 *    multiple replicas, a distributed store (e.g. rate-limit-redis backed by shared Redis)
 *    must be plugged in before load-balancing traffic.
 */

/**
 * Login: 10 failed attempts / 15 min per IP + normalized email (PRD Section 5.6).
 * Successful logins are not counted (skipSuccessfulRequests: true).
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req: Request) => {
    const body = req.body as Record<string, unknown> | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rawIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const ip = ipKeyGenerator(rawIp);
    return email ? `${ip}:${email}` : ip;
  },
});

/**
 * Forgot / reset password: 5 requests / 15 min per IP (PRD Section 5.6).
 */
export const passwordResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Reset-token pre-check: 30 requests / 15 min per IP.
 * Fired automatically by the reset page, so it must not consume the
 * forgot/reset-password budget (PRD Section 5.6).
 */
export const verifyResetTokenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Refresh token: 30 requests / 15 min per IP (PRD Section 5.6).
 */
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * User invite creation & resend: 20 requests / 15 min per IP in production.
 * Configurable via RATE_LIMIT_INVITE or relaxed in non-production environments to allow batch seeding/testing.
 * Prevents SMTP quota exhaustion and email-bombing while allowing batch admin invites.
 */
export const inviteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.RATE_LIMIT_INVITE ?? (env.NODE_ENV === 'production' ? 20 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
