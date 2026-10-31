import { randomUUID } from 'node:crypto';

import {
  hashPassword,
  PasswordResetTokenPayload,
  REFRESH_TOKEN_TTL_MS,
  RefreshTokenPayload,
  signAccessToken,
  signPasswordResetToken,
  signRefreshToken,
  verifyPassword,
  verifyPasswordResetToken,
  verifyRefreshToken,
} from '../../core/auth';
import { AppDataSource } from '../../core/db';
import { emailService } from '../../core/email';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../core/errors';
import { logger } from '../../core/logging';
import { User, UserRepository, userRepository, UserRole } from '../users';
import { Token, TokenRevokeReason, TokenType } from './entities/token.entity';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './schemas/auth.schemas';
import { TokenRepository, tokenRepository } from './token.repository';

export interface AuthUserPayload {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
  isActive: boolean;
  createdAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: AuthUserPayload;
  tokens: AuthTokens;
}

export interface VerifyResetTokenResult {
  valid: boolean;
}

export interface IAuthService {
  login(input: LoginInput): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthResult>;
  logout(refreshToken?: string): Promise<void>;
  getCurrentUser(userId: string): Promise<AuthUserPayload>;
  forgotPassword(input: ForgotPasswordInput): Promise<void>;
  resetPassword(input: ResetPasswordInput): Promise<void>;
  verifyResetToken(token: string): Promise<VerifyResetTokenResult>;
  changePassword(userId: string, input: ChangePasswordInput): Promise<AuthResult>;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<AuthUserPayload>;
}

export class AuthService implements IAuthService {
  constructor(
    private readonly userRepo: UserRepository = userRepository,
    private readonly tokenRepo: TokenRepository = tokenRepository,
  ) {}

  private toAuthUserPayload(user: User): AuthUserPayload {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }

  public async getCurrentUser(userId: string): Promise<AuthUserPayload> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return this.toAuthUserPayload(user);
  }

  public async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.userRepo.findByEmailWithPassword(input.email);
    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.isActive) {
      throw new ForbiddenError(
        'Your account has been deactivated. Please contact an administrator.',
      );
    }

    const isValidPassword = await verifyPassword(user.passwordHash, input.password);
    if (!isValidPassword) {
      throw new UnauthorizedError('Invalid email or password');
    }

    await this.userRepo.updateLastLogin(user.id);

    const jti = randomUUID();
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await this.tokenRepo.createToken({
      userId: user.id,
      tokenType: TokenType.REFRESH,
      jti,
      familyId,
      tokenVersion: user.tokenVersion,
      expiresAt,
    });

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    const refreshToken = signRefreshToken({
      sub: user.id,
      jti,
      familyId,
      tokenVersion: user.tokenVersion,
    });

    return {
      user: this.toAuthUserPayload(user),
      tokens: {
        accessToken,
        refreshToken,
      },
    };
  }

  public async refresh(rawRefreshToken: string): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token is required');
    }

    let payload: RefreshTokenPayload;
    try {
      payload = verifyRefreshToken(rawRefreshToken);
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    return await AppDataSource.transaction(async (manager) => {
      // Row-level locking to prevent race condition when concurrent /refresh requests arrive
      const tokenRow = await this.tokenRepo.findByJti(payload.jti, { lock: true, manager });
      if (tokenRow?.tokenType !== TokenType.REFRESH) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      // Reuse detection: if the token was already revoked, terminate the entire family
      if (tokenRow.revokedAt !== null) {
        if (tokenRow.familyId) {
          await this.tokenRepo.revokeFamily(
            tokenRow.familyId,
            TokenRevokeReason.REUSE_DETECTED,
            manager,
          );
        }
        throw new UnauthorizedError(
          'Token reuse detected. All sessions in this family have been terminated.',
        );
      }

      if (tokenRow.expiresAt < new Date()) {
        throw new UnauthorizedError('Refresh token has expired');
      }

      const user = await this.userRepo.findById(tokenRow.userId, manager);
      if (!user?.isActive) {
        await this.tokenRepo.revokeByJti(
          tokenRow.jti,
          TokenRevokeReason.DEACTIVATED,
          undefined,
          manager,
        );
        throw new UnauthorizedError('Session is no longer valid');
      }

      if (user.tokenVersion !== tokenRow.tokenVersion) {
        await this.tokenRepo.revokeByJti(
          tokenRow.jti,
          TokenRevokeReason.PASSWORD_CHANGED,
          undefined,
          manager,
        );
        throw new UnauthorizedError('Session is no longer valid');
      }

      // Token rotation: issue new token with same family_id first, then link replaced_by_id
      const newJti = randomUUID();
      const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      const newToken = await this.tokenRepo.createToken(
        {
          userId: user.id,
          tokenType: TokenType.REFRESH,
          jti: newJti,
          familyId: tokenRow.familyId,
          tokenVersion: user.tokenVersion,
          expiresAt: newExpiresAt,
        },
        manager,
      );

      const revoked = await this.tokenRepo.revokeByJti(
        tokenRow.jti,
        TokenRevokeReason.ROTATED,
        newToken.id,
        manager,
      );
      if (!revoked) {
        if (tokenRow.familyId) {
          await this.tokenRepo.revokeFamily(
            tokenRow.familyId,
            TokenRevokeReason.REUSE_DETECTED,
            manager,
          );
        }
        throw new UnauthorizedError(
          'Token reuse detected. All sessions in this family have been terminated.',
        );
      }

      const accessToken = signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion,
      });

      const refreshToken = signRefreshToken({
        sub: user.id,
        jti: newJti,
        familyId: tokenRow.familyId ?? newJti,
        tokenVersion: user.tokenVersion,
      });

      return {
        user: this.toAuthUserPayload(user),
        tokens: {
          accessToken,
          refreshToken,
        },
      };
    });
  }

  public async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    try {
      const payload = verifyRefreshToken(rawRefreshToken);
      await this.tokenRepo.revokeByJti(payload.jti, TokenRevokeReason.LOGOUT);
    } catch {
      // Ignore invalid token formatting on logout
    }
  }

  public async forgotPassword(input: ForgotPasswordInput): Promise<void> {
    const user = await this.userRepo.findByEmail(input.email);
    if (!user?.isActive) {
      return;
    }

    // Revoke previous unused reset tokens only (preserve active refresh sessions)
    await this.tokenRepo.revokeAllForUser(
      user.id,
      TokenRevokeReason.PASSWORD_RESET,
      TokenType.PASSWORD_RESET,
    );

    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await this.tokenRepo.createToken({
      userId: user.id,
      tokenType: TokenType.PASSWORD_RESET,
      jti,
      expiresAt,
    });

    const resetToken = signPasswordResetToken({ sub: user.id, jti });
    await emailService.sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetToken,
    });
  }

  private async findUsableResetToken(
    token: string,
    context: 'verify' | 'reset',
  ): Promise<{ tokenRow: Token; user: User } | null> {
    let payload: PasswordResetTokenPayload;
    try {
      payload = verifyPasswordResetToken(token);
    } catch {
      logger.warn(
        { context, reason: 'signature_invalid_or_expired' },
        'Password reset token rejected',
      );
      return null;
    }

    const tokenRow = await this.tokenRepo.findByJti(payload.jti);
    if (tokenRow?.tokenType !== TokenType.PASSWORD_RESET) {
      logger.warn(
        { context, reason: 'token_not_found_or_wrong_type' },
        'Password reset token rejected',
      );
      return null;
    }

    if (tokenRow.revokedAt !== null) {
      logger.warn({ context, reason: 'token_revoked' }, 'Password reset token rejected');
      return null;
    }

    if (tokenRow.passwordResetUsedAt !== null) {
      logger.warn({ context, reason: 'token_already_consumed' }, 'Password reset token rejected');
      return null;
    }

    if (tokenRow.expiresAt < new Date()) {
      logger.warn({ context, reason: 'token_expired' }, 'Password reset token rejected');
      return null;
    }

    const user = await this.userRepo.findById(tokenRow.userId);
    if (!user?.isActive) {
      logger.warn(
        { context, reason: 'user_inactive_or_not_found' },
        'Password reset token rejected',
      );
      return null;
    }

    return { tokenRow, user };
  }

  public async resetPassword(input: ResetPasswordInput): Promise<void> {
    const usable = await this.findUsableResetToken(input.token, 'reset');
    if (!usable) {
      throw new UnauthorizedError('Invalid or expired password reset token');
    }
    const { tokenRow, user } = usable;

    const passwordHash = await hashPassword(input.newPassword);

    await AppDataSource.transaction(async (manager) => {
      const marked = await this.tokenRepo.markPasswordResetUsed(tokenRow.jti, manager);
      if (!marked) {
        throw new BadRequestError('Invalid or expired password reset token');
      }

      await this.userRepo.updatePassword(user.id, passwordHash, manager);

      // Invalidate all existing refresh tokens across all sessions atomically
      await this.userRepo.incrementTokenVersion(user.id, manager);
      await this.tokenRepo.revokeAllForUser(
        user.id,
        TokenRevokeReason.PASSWORD_RESET,
        undefined,
        manager,
      );
    });
  }

  public async verifyResetToken(token: string): Promise<VerifyResetTokenResult> {
    const usable = await this.findUsableResetToken(token, 'verify');
    return { valid: usable !== null };
  }

  public async changePassword(userId: string, input: ChangePasswordInput): Promise<AuthResult> {
    const user = await this.userRepo.findByIdWithPassword(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const isValidPassword = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!isValidPassword) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const passwordHash = await hashPassword(input.newPassword);

    return await AppDataSource.transaction(async (manager) => {
      await this.userRepo.updatePassword(user.id, passwordHash, manager);
      await this.userRepo.incrementTokenVersion(user.id, manager);
      await this.tokenRepo.revokeAllForUser(
        user.id,
        TokenRevokeReason.PASSWORD_CHANGED,
        undefined,
        manager,
      );

      const updatedUser = await this.userRepo.findById(user.id, manager);
      const nextTokenVersion = updatedUser ? updatedUser.tokenVersion : user.tokenVersion + 1;
      const jti = randomUUID();
      const familyId = randomUUID();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      await this.tokenRepo.createToken(
        {
          userId: user.id,
          tokenType: TokenType.REFRESH,
          jti,
          familyId,
          tokenVersion: nextTokenVersion,
          expiresAt,
        },
        manager,
      );

      const accessToken = signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        tokenVersion: nextTokenVersion,
      });

      const refreshToken = signRefreshToken({
        sub: user.id,
        jti,
        familyId,
        tokenVersion: nextTokenVersion,
      });

      return {
        user: {
          ...this.toAuthUserPayload(updatedUser ?? user),
          mustChangePassword: false,
        },
        tokens: {
          accessToken,
          refreshToken,
        },
      };
    });
  }

  public async updateProfile(userId: string, input: UpdateProfileInput): Promise<AuthUserPayload> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    user.name = input.name.trim();
    user.updatedBy = userId;
    const updatedUser = await this.userRepo.save(user);
    return this.toAuthUserPayload(updatedUser);
  }
}

export const authService = new AuthService();
