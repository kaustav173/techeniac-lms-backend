import type { NextFunction, Request, Response } from 'express';

import { type AuthenticatedUser, verifyAccessToken } from '../../core/auth';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
// eslint-disable-next-line architecture/cross-module-index-imports -- isolate repository import to break barrel cycle with users.service
import { userRepository } from '../users/user.repository';

// Augment Express.Request interface to type user context attached by auth middleware
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const BEARER_PREFIX = 'Bearer ';

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
  const authHeader = req.headers.authorization;

  let token = cookies.accessToken;
  if (!token && authHeader?.startsWith(BEARER_PREFIX)) {
    token = authHeader.substring(BEARER_PREFIX.length);
  }

  if (!token) {
    next(new UnauthorizedError('Authentication token is required'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);

    // FR-1.6: Verify tokenVersion and active state against live user row on every request
    const user = await userRepository.findById(payload.sub);
    if (!user?.isActive) {
      next(new UnauthorizedError('Account is inactive or disabled'));
      return;
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      next(new UnauthorizedError('Session has expired or credentials have been updated'));
      return;
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      tokenVersion: user.tokenVersion,
    };
    next();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      next(error);
      return;
    }
    next(new UnauthorizedError('Invalid or expired authentication token'));
  }
}

export function requireRole(
  ...allowedRoles: string[]
): (req: Request, _res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError('Insufficient permissions for this resource'));
      return;
    }

    next();
  };
}
