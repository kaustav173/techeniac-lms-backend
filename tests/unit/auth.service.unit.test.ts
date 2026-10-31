import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hashPassword, signRefreshToken } from '../../src/core/auth';
import { AppDataSource } from '../../src/core/db';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../src/core/errors';
/* eslint-disable architecture/cross-module-index-imports -- direct imports avoid circular barrel initialization during isolated unit testing */
import { AuthResult, AuthService, AuthUserPayload } from '../../src/modules/auth/auth.service';
import { Token, TokenType } from '../../src/modules/auth/entities/token.entity';
import { TokenRepository } from '../../src/modules/auth/token.repository';
/* eslint-enable architecture/cross-module-index-imports */
import { User, UserRepository, UserRole } from '../../src/modules/users';

const EXPECTED_USER_PAYLOAD_KEYS = [
  'createdAt',
  'email',
  'id',
  'isActive',
  'mustChangePassword',
  'name',
  'role',
].sort();

function assertUserPayloadShape(
  payload: AuthUserPayload,
  expected: { isActive: boolean; createdAt: Date; mustChangePassword?: boolean },
): void {
  assert.deepStrictEqual(Object.keys(payload).sort(), EXPECTED_USER_PAYLOAD_KEYS);
  assert.strictEqual(typeof payload.isActive, 'boolean');
  assert.strictEqual(payload.isActive, expected.isActive);
  assert.strictEqual(payload.createdAt instanceof Date, true);
  assert.strictEqual(payload.createdAt.toISOString(), expected.createdAt.toISOString());
  if (expected.mustChangePassword !== undefined) {
    assert.strictEqual(payload.mustChangePassword, expected.mustChangePassword);
  }
}

void describe('AuthService Unit Tests - Payload Shape & Active Status (PR #32 F-003)', () => {
  let authService: AuthService;
  let mockUserRepo: Partial<UserRepository>;
  let mockTokenRepo: Partial<TokenRepository>;
  let originalTransaction: typeof AppDataSource.transaction;

  const validPassword = 'Password123!';
  let validPasswordHash: string;

  const mockCreatedAt = new Date('2026-01-15T08:30:00.000Z');

  const activeMockUser = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Active User',
    email: 'active@techeniac.com',
    passwordHash: '',
    role: UserRole.MENTEE,
    tokenVersion: 1,
    isActive: true,
    mustChangePassword: true,
    createdAt: mockCreatedAt,
    updatedAt: mockCreatedAt,
    deletedAt: null,
  } as unknown as User;

  const inactiveMockUser: User = {
    ...activeMockUser,
    id: '22222222-2222-4222-8222-222222222222',
    email: 'inactive@techeniac.com',
    isActive: false,
  };

  beforeEach(async () => {
    validPasswordHash = await hashPassword(validPassword);
    activeMockUser.name = 'Test Active User';
    activeMockUser.passwordHash = validPasswordHash;
    inactiveMockUser.passwordHash = validPasswordHash;

    originalTransaction = AppDataSource.transaction.bind(AppDataSource);
    AppDataSource.transaction = ((runInTx: (m: unknown) => Promise<unknown>) => {
      return runInTx({});
    }) as typeof AppDataSource.transaction;

    mockUserRepo = {
      findById: (id: string) => {
        if (id === activeMockUser.id) return Promise.resolve(activeMockUser);
        if (id === inactiveMockUser.id) return Promise.resolve(inactiveMockUser);
        return Promise.resolve(null);
      },
      findByEmailWithPassword: (email: string) => {
        if (email === activeMockUser.email) return Promise.resolve(activeMockUser);
        if (email === inactiveMockUser.email) return Promise.resolve(inactiveMockUser);
        return Promise.resolve(null);
      },
      findByIdWithPassword: (id: string) => {
        if (id === activeMockUser.id) return Promise.resolve(activeMockUser);
        return Promise.resolve(null);
      },
      updateLastLogin: () => Promise.resolve(),
      updatePassword: () => Promise.resolve(),
      incrementTokenVersion: () => Promise.resolve(),
      save: (user: User) => Promise.resolve(user),
    };

    mockTokenRepo = {
      createToken: () => Promise.resolve({ id: 'token-uuid' } as Token),
      findByJti: (jti: string) =>
        Promise.resolve({
          id: 'token-uuid',
          userId: activeMockUser.id,
          tokenType: TokenType.REFRESH,
          jti,
          familyId: 'family-uuid',
          tokenVersion: activeMockUser.tokenVersion,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        } as Token),
      revokeByJti: () => Promise.resolve(true),
      revokeFamily: () => Promise.resolve(),
      revokeAllForUser: () => Promise.resolve(),
    };

    authService = new AuthService(mockUserRepo as UserRepository, mockTokenRepo as TokenRepository);
  });

  afterEach(() => {
    AppDataSource.transaction = originalTransaction;
  });

  void describe('getCurrentUser', () => {
    void it('surfaces isActive and createdAt from mock user and preserves exact payload key set', async () => {
      const userPayload = await authService.getCurrentUser(activeMockUser.id);

      assertUserPayloadShape(userPayload, {
        isActive: true,
        createdAt: mockCreatedAt,
        mustChangePassword: true,
      });
      assert.strictEqual(userPayload.id, activeMockUser.id);
      assert.strictEqual(userPayload.email, activeMockUser.email);
    });

    void it('throws NotFoundError when user does not exist', async () => {
      await assert.rejects(
        () => authService.getCurrentUser('00000000-0000-0000-0000-000000000000'),
        (err: Error) => {
          assert.strictEqual(err instanceof NotFoundError, true);
          assert.strictEqual(err.message, 'User not found');
          return true;
        },
      );
    });
  });

  void describe('login', () => {
    void it('surfaces isActive and createdAt in auth payload on successful login and matches exact key set', async () => {
      const result: AuthResult = await authService.login({
        email: activeMockUser.email,
        password: validPassword,
      });

      assertUserPayloadShape(result.user, {
        isActive: true,
        createdAt: mockCreatedAt,
        mustChangePassword: true,
      });
      assert.ok(result.tokens.accessToken);
      assert.ok(result.tokens.refreshToken);
    });

    void it('throws ForbiddenError when user account has isActive: false', async () => {
      await assert.rejects(
        () =>
          authService.login({
            email: inactiveMockUser.email,
            password: validPassword,
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof ForbiddenError, true);
          assert.match(err.message, /account has been deactivated/i);
          return true;
        },
      );
    });

    void it('throws UnauthorizedError when email is not found', async () => {
      await assert.rejects(
        () =>
          authService.login({
            email: 'nonexistent@techeniac.com',
            password: validPassword,
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof UnauthorizedError, true);
          assert.strictEqual(err.message, 'Invalid email or password');
          return true;
        },
      );
    });

    void it('throws UnauthorizedError when password is invalid', async () => {
      await assert.rejects(
        () =>
          authService.login({
            email: activeMockUser.email,
            password: 'WrongPassword!',
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof UnauthorizedError, true);
          assert.strictEqual(err.message, 'Invalid email or password');
          return true;
        },
      );
    });
  });

  void describe('refresh', () => {
    void it('surfaces isActive and createdAt in auth payload on valid token refresh and matches exact key set', async () => {
      const validRefreshToken = signRefreshToken({
        sub: activeMockUser.id,
        jti: 'test-refresh-jti',
        familyId: 'family-uuid',
        tokenVersion: activeMockUser.tokenVersion,
      });

      const result: AuthResult = await authService.refresh(validRefreshToken);

      assertUserPayloadShape(result.user, {
        isActive: true,
        createdAt: mockCreatedAt,
      });
      assert.ok(result.tokens.accessToken);
      assert.ok(result.tokens.refreshToken);
    });

    void it('throws UnauthorizedError when refresh token string is invalid', async () => {
      await assert.rejects(
        () => authService.refresh('malformed.jwt.token'),
        (err: Error) => {
          assert.strictEqual(err instanceof UnauthorizedError, true);
          assert.strictEqual(err.message, 'Invalid or expired refresh token');
          return true;
        },
      );
    });

    void it('throws UnauthorizedError when refreshed user is deactivated (isActive: false)', async () => {
      const inactiveUserToken = signRefreshToken({
        sub: inactiveMockUser.id,
        jti: 'inactive-user-jti',
        familyId: 'inactive-family',
        tokenVersion: inactiveMockUser.tokenVersion,
      });

      mockTokenRepo.findByJti = (jti: string) =>
        Promise.resolve({
          id: 'token-uuid',
          userId: inactiveMockUser.id,
          tokenType: TokenType.REFRESH,
          jti,
          familyId: 'inactive-family',
          tokenVersion: inactiveMockUser.tokenVersion,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        } as Token);

      await assert.rejects(
        () => authService.refresh(inactiveUserToken),
        (err: Error) => {
          assert.strictEqual(err instanceof UnauthorizedError, true);
          assert.strictEqual(err.message, 'Session is no longer valid');
          return true;
        },
      );
    });
  });

  void describe('changePassword', () => {
    void it('surfaces isActive and createdAt from updated user, sets mustChangePassword to false, and matches exact key set', async () => {
      const freshUserReadAfterTx: User = {
        ...activeMockUser,
        mustChangePassword: false,
        tokenVersion: activeMockUser.tokenVersion + 1,
      };

      mockUserRepo.findById = (id: string) => {
        if (id === activeMockUser.id) return Promise.resolve(freshUserReadAfterTx);
        return Promise.resolve(null);
      };

      const result: AuthResult = await authService.changePassword(activeMockUser.id, {
        currentPassword: validPassword,
        newPassword: 'NewSecurePassword123!',
      });

      assertUserPayloadShape(result.user, {
        isActive: true,
        createdAt: mockCreatedAt,
        mustChangePassword: false,
      });
      assert.ok(result.tokens.accessToken);
      assert.ok(result.tokens.refreshToken);
    });

    void it('throws UnauthorizedError when current password is incorrect', async () => {
      await assert.rejects(
        () =>
          authService.changePassword(activeMockUser.id, {
            currentPassword: 'WrongPassword!',
            newPassword: 'NewSecurePassword123!',
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof UnauthorizedError, true);
          assert.strictEqual(err.message, 'Current password is incorrect');
          return true;
        },
      );
    });

    void it('throws NotFoundError when user does not exist', async () => {
      await assert.rejects(
        () =>
          authService.changePassword('00000000-0000-0000-0000-000000000000', {
            currentPassword: validPassword,
            newPassword: 'NewSecurePassword123!',
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof NotFoundError, true);
          assert.strictEqual(err.message, 'User not found');
          return true;
        },
      );
    });
  });

  void describe('updateProfile', () => {
    void it('updates user name, leaves email untouched, and preserves payload shape', async () => {
      const updated = await authService.updateProfile(activeMockUser.id, {
        name: 'New Profile Name',
      });

      assert.strictEqual(updated.name, 'New Profile Name');
      assert.strictEqual(updated.email, activeMockUser.email);
      assertUserPayloadShape(updated, {
        isActive: true,
        createdAt: mockCreatedAt,
      });
      assert.strictEqual(activeMockUser.updatedBy, activeMockUser.id);
    });

    void it('trims leading and trailing whitespace from name', async () => {
      const updated = await authService.updateProfile(activeMockUser.id, {
        name: '  Trimmed User Name  ',
      });

      assert.strictEqual(updated.name, 'Trimmed User Name');
    });

    void it('throws NotFoundError when user does not exist', async () => {
      await assert.rejects(
        () =>
          authService.updateProfile('00000000-0000-0000-0000-000000000000', {
            name: 'Nonexistent User',
          }),
        (err: Error) => {
          assert.strictEqual(err instanceof NotFoundError, true);
          assert.strictEqual(err.message, 'User not found');
          return true;
        },
      );
    });
  });
});
