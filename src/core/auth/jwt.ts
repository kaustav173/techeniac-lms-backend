import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config';

export const JWT_ISSUER = 'techeniac-lms';
export const AUDIENCE_ACCESS = 'techeniac-lms:access';
export const AUDIENCE_REFRESH = 'techeniac-lms:refresh';
export const AUDIENCE_PASSWORD_RESET = 'techeniac-lms:password_reset';

export const accessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  tokenVersion: z.number().int().min(0),
  type: z.literal('access'),
});

export const refreshTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  familyId: z.string().min(1),
  tokenVersion: z.number().int().min(0),
  type: z.literal('refresh'),
});

export const passwordResetTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  type: z.literal('password_reset'),
});

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;
export type RefreshTokenPayload = z.infer<typeof refreshTokenPayloadSchema>;
export type PasswordResetTokenPayload = z.infer<typeof passwordResetTokenPayloadSchema>;

export type AccessTokenInput = Omit<AccessTokenPayload, 'type'>;
export type RefreshTokenInput = Omit<RefreshTokenPayload, 'type'>;
export type PasswordResetTokenInput = Omit<PasswordResetTokenPayload, 'type'>;

export function signAccessToken(payload: AccessTokenInput): string {
  const fullPayload: AccessTokenPayload = { ...payload, type: 'access' };
  const options: SignOptions = {
    algorithm: env.JWT_ALGORITHM,
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: AUDIENCE_ACCESS,
  };
  return jwt.sign(fullPayload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: [env.JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: AUDIENCE_ACCESS,
  });
  return accessTokenPayloadSchema.parse(decoded);
}

export function signRefreshToken(payload: RefreshTokenInput): string {
  const fullPayload: RefreshTokenPayload = { ...payload, type: 'refresh' };
  const options: SignOptions = {
    algorithm: env.JWT_ALGORITHM,
    expiresIn: env.REFRESH_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: AUDIENCE_REFRESH,
  };
  return jwt.sign(fullPayload, env.JWT_REFRESH_SECRET, options);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
    algorithms: [env.JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: AUDIENCE_REFRESH,
  });
  return refreshTokenPayloadSchema.parse(decoded);
}

export function signPasswordResetToken(payload: PasswordResetTokenInput): string {
  const fullPayload: PasswordResetTokenPayload = { ...payload, type: 'password_reset' };
  const options: SignOptions = {
    algorithm: env.JWT_ALGORITHM,
    expiresIn: '30m',
    issuer: JWT_ISSUER,
    audience: AUDIENCE_PASSWORD_RESET,
  };
  return jwt.sign(fullPayload, env.JWT_ACCESS_SECRET, options);
}

export function verifyPasswordResetToken(token: string): PasswordResetTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: [env.JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: AUDIENCE_PASSWORD_RESET,
  });
  return passwordResetTokenPayloadSchema.parse(decoded);
}
