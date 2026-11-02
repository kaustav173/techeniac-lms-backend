import crypto from 'node:crypto';

import { AuditType, logAudit } from '../../core/audit';
import { hashPassword } from '../../core/auth/password';
import { isUniqueViolation } from '../../core/db';
import { emailService } from '../../core/email';
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../core/errors';
import { eventBus } from '../../core/lifecycle';
import { logger } from '../../core/logging';
import { batchService } from '../batches';
import { type User, UserRole } from './entities/user.entity';
import type { UserRoleHistory } from './entities/user-role-history.entity';
import { UserRepository, userRepository } from './user.repository';
import type {
  ChangeRoleInput,
  CreateUserInput,
  UpdateUserInput,
  UserQueryParams,
} from './users.schemas';

export type RoleChangeBlockReason =
  'SAME_ROLE' | 'ACTIVE_MENTEES' | 'INVALID_ROLE_TRANSITION' | 'SUPER_ADMIN_ROLE_IMMUTABLE';

export const ALLOWED_ROLE_TRANSITIONS: Readonly<Record<UserRole, readonly UserRole[]>> =
  Object.freeze({
    [UserRole.MENTEE]: Object.freeze([UserRole.MENTOR]),
    [UserRole.MENTOR]: Object.freeze([UserRole.SUPER_ADMIN]),
    [UserRole.SUPER_ADMIN]: Object.freeze([]),
  });

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  tokenVersion: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    tokenVersion: user.tokenVersion,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    deletedAt: user.deletedAt,
  };
}

function pickRandomChar(source: string): string {
  const index = crypto.randomInt(0, source.length);
  const char = source[index];
  if (char === undefined) {
    throw new Error('Index out of bounds while picking random character');
  }
  return char;
}

function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;

  const chars = [
    pickRandomChar(upper),
    pickRandomChar(lower),
    pickRandomChar(digits),
    pickRandomChar(special),
  ];

  for (let i = 4; i < 14; i++) {
    chars.push(pickRandomChar(all));
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const charAtI = chars[i];
    const charAtJ = chars[j];
    if (charAtI !== undefined && charAtJ !== undefined) {
      chars[i] = charAtJ;
      chars[j] = charAtI;
    }
  }

  return chars.join('');
}

export class UsersService {
  constructor(private readonly repo: UserRepository = userRepository) {}

  public async listUsers(params: UserQueryParams): Promise<{
    users: User[];
    total: number;
    page: number;
    limit: number;
    counts: { total: number; active: number; inactive: number };
  }> {
    const [users, total] = await this.repo.findAll(params);
    const counts = await this.repo.getCounts();
    return { users, total, page: params.page, limit: params.limit, counts };
  }

  public async getUserById(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new NotFoundError(`User with id '${id}' not found`);
    }
    return user;
  }

  public async createUser(input: CreateUserInput, actorId?: string): Promise<User> {
    const existing = await this.repo.findByEmail(input.email);
    if (existing) {
      throw new ConflictError('A user with this email already exists', 'DUPLICATE_EMAIL');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    let user: User;
    try {
      user = await this.repo.transaction(async (manager) => {
        const createdUser = await this.repo.create(
          {
            name: input.name,
            email: input.email,
            role: input.role,
            passwordHash,
            mustChangePassword: true,
          },
          manager,
        );

        await this.repo.saveRoleHistory(
          {
            userId: createdUser.id,
            role: createdUser.role,
            reason: 'Initial role assignment upon user creation',
            changedBy: actorId ?? null,
          },
          manager,
        );

        return createdUser;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A user with this email already exists', 'DUPLICATE_EMAIL');
      }
      throw err;
    }

    await logAudit({
      actorId: actorId ?? null,
      type: AuditType.USER,
      entity: 'User',
      entityId: user.id,
      action: 'USER_CREATED',
      newValue: { name: user.name, email: user.email, role: user.role },
    });

    try {
      await emailService.sendInviteEmail({
        to: user.email,
        name: user.name,
        temporaryPassword,
        role: user.role,
      });
    } catch (err) {
      logger.error({ err, userId: user.id }, 'Failed to dispatch user invitation email');
      throw new BadGatewayError(
        'User was created, but invitation email delivery failed. Please use resend invite.',
        'INVITE_EMAIL_DELIVERY_FAILED',
        { userId: user.id },
      );
    }

    return user;
  }

  public async updateUser(id: string, input: UpdateUserInput): Promise<User> {
    const user = await this.getUserById(id);

    if (input.email && input.email !== user.email) {
      const existing = await this.repo.findByEmail(input.email);
      if (existing) {
        throw new ConflictError('A user with this email already exists', 'DUPLICATE_EMAIL');
      }
      user.email = input.email;
    }

    if (input.name) {
      user.name = input.name;
    }

    try {
      return await this.repo.save(user);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A user with this email already exists', 'DUPLICATE_EMAIL');
      }
      throw err;
    }
  }

  public async changeRole(
    id: string,
    input: ChangeRoleInput,
    actorId?: string,
  ): Promise<{ user: User; history: UserRoleHistory }> {
    const user = await this.getUserById(id);

    if (user.role === input.newRole) {
      throw new BadRequestError('User already has the requested role', 'SAME_ROLE_NO_OP');
    }

    if (!actorId) {
      throw new ForbiddenError('Actor could not be determined', 'ACTOR_REQUIRED');
    }

    if (actorId === id) {
      throw new ForbiddenError('Super Admin cannot change own role', 'CANNOT_CHANGE_OWN_ROLE');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestError('Super Admin role cannot be changed', 'SUPER_ADMIN_ROLE_IMMUTABLE');
    }

    const allowedTargets = ALLOWED_ROLE_TRANSITIONS[user.role] ?? [];
    if (!allowedTargets.includes(input.newRole)) {
      throw new BadRequestError(
        `Invalid role transition: ${user.role} can only be transitioned to ${allowedTargets.join(', ') || 'no other roles'}`,
        'INVALID_ROLE_TRANSITION',
      );
    }

    if (user.role === UserRole.MENTOR && input.newRole === UserRole.SUPER_ADMIN) {
      const activeMappings = await batchService.getActiveMappingsForMentor(user.id);
      if (activeMappings.length > 0) {
        throw new BadRequestError(
          `Cannot change role. Mentor has ${activeMappings.length} active mentee(s) that must be reassigned first.`,
          'ACTIVE_MENTEES_EXIST',
        );
      }
    }

    const previousRole = user.role;
    user.role = input.newRole;

    try {
      const result = await this.repo.transaction(async (manager) => {
        const savedUser = await this.repo.save(user, manager);

        await this.repo.incrementTokenVersion(user.id, manager);
        savedUser.tokenVersion += 1;

        await this.repo.closeActiveRoleHistory(user.id, undefined, manager);

        const history = await this.repo.saveRoleHistory(
          {
            userId: user.id,
            role: input.newRole,
            reason: input.reason,
            changedBy: actorId,
          },
          manager,
        );

        // PRD Section 4: Role Change Impact Matrix closures
        if (previousRole === UserRole.MENTEE || previousRole === UserRole.MENTOR) {
          await batchService.handleUserRoleChange(user.id, manager, actorId);
        }

        return { user: savedUser, history };
      });

      eventBus.emitEvent('user.roleChanged', {
        userId: id,
        oldRole: previousRole,
        newRole: input.newRole,
        actorId,
      });

      await logAudit({
        actorId,
        type: AuditType.USER,
        entity: 'User',
        entityId: id,
        action: 'ROLE_CHANGE',
        oldValue: { role: previousRole },
        newValue: {
          name: result.user.name,
          email: result.user.email,
          role: input.newRole,
          reason: input.reason,
        },
      });

      return result;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          'Concurrent role modification detected. Please refresh and retry.',
          'CONCURRENT_ROLE_MODIFICATION',
        );
      }
      throw err;
    }
  }

  public async toggleUserStatus(id: string, isActive: boolean, actorId?: string): Promise<User> {
    const user = await this.getUserById(id);

    if (!actorId) {
      throw new ForbiddenError('Actor could not be determined', 'ACTOR_REQUIRED');
    }

    if (actorId === id && !isActive) {
      throw new ForbiddenError(
        'Super Admin cannot deactivate own account',
        'CANNOT_DEACTIVATE_SELF',
      );
    }

    if (user.isActive === isActive) {
      return user;
    }

    const previousIsActive = user.isActive;

    const savedUser = await this.repo.transaction(async (manager) => {
      if (!isActive && user.role === UserRole.SUPER_ADMIN) {
        const activeAdmins = await this.repo.lockAndCountActiveSuperAdmins(manager);
        if (activeAdmins <= 1) {
          throw new BadRequestError(
            'Cannot deactivate the last active Super Admin',
            'LAST_SUPER_ADMIN',
          );
        }
      }

      user.isActive = isActive;
      const updatedUser = await this.repo.save(user, manager);

      if (!isActive) {
        await this.repo.incrementTokenVersion(user.id, manager);
        updatedUser.tokenVersion += 1;
      }

      return updatedUser;
    });

    await logAudit({
      actorId,
      type: AuditType.USER,
      entity: 'User',
      entityId: id,
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      oldValue: { isActive: previousIsActive },
      newValue: { name: savedUser.name, email: savedUser.email, isActive },
    });

    return savedUser;
  }

  public async getRoleImpact(
    id: string,
    newRole: UserRole,
  ): Promise<{
    userId: string;
    name: string;
    email: string;
    currentRole: UserRole;
    newRole: UserRole;
    isSameRole: boolean;
    willRevokeSessions: boolean;
    isBlocked: boolean;
    blockReason: RoleChangeBlockReason | null;
    activeMenteesCount: number;
    activeMentees: Array<{
      id: string;
      name: string;
      email: string;
      batchId: string;
      batchName: string;
    }>;
    impactPoints: string[];
    impactSummary: string;
  }> {
    const user = await this.getUserById(id);
    const isSameRole = user.role === newRole;

    let isBlocked = false;
    let blockReason: RoleChangeBlockReason | null = null;
    let activeMentees: Array<{
      id: string;
      name: string;
      email: string;
      batchId: string;
      batchName: string;
    }> = [];

    if (isSameRole) {
      isBlocked = true;
      blockReason = 'SAME_ROLE';
    } else if (user.role === UserRole.SUPER_ADMIN) {
      isBlocked = true;
      blockReason = 'SUPER_ADMIN_ROLE_IMMUTABLE';
    } else {
      const allowedTargets = ALLOWED_ROLE_TRANSITIONS[user.role] ?? [];
      if (!allowedTargets.includes(newRole)) {
        isBlocked = true;
        blockReason = 'INVALID_ROLE_TRANSITION';
      } else if (user.role === UserRole.MENTOR && newRole === UserRole.SUPER_ADMIN) {
        const mappings = await batchService.getActiveMappingsForMentor(user.id);
        if (mappings.length > 0) {
          isBlocked = true;
          blockReason = 'ACTIVE_MENTEES';
          activeMentees = mappings.map((m) => ({
            id: m.mentee ? m.mentee.id : m.menteeId,
            name: m.mentee ? m.mentee.name : 'Unknown Mentee',
            email: m.mentee ? m.mentee.email : '',
            batchId: m.batchId,
            batchName: m.batch ? m.batch.name : 'Active Batch',
          }));
        }
      }
    }

    let impactSummary = '';
    if (isSameRole) {
      impactSummary = `User already has the role ${newRole}. No changes will be applied.`;
    } else if (isBlocked && blockReason === 'SUPER_ADMIN_ROLE_IMMUTABLE') {
      impactSummary = 'Super Admin role cannot be changed.';
    } else if (isBlocked && blockReason === 'INVALID_ROLE_TRANSITION') {
      const allowed = ALLOWED_ROLE_TRANSITIONS[user.role] ?? [];
      impactSummary = `${user.role} can only be transitioned to ${allowed.join(', ') || 'no other roles'}.`;
    } else if (isBlocked && blockReason === 'ACTIVE_MENTEES') {
      impactSummary = `Mentor has ${activeMentees.length} active mentee(s). All mentees must be reassigned before changing role.`;
    } else {
      impactSummary = `Changing role from ${user.role} to ${newRole} will invalidate all active sessions and reassign permissions immediately.`;
    }

    const impactPoints: string[] = [];
    if (isSameRole) {
      impactPoints.push(`User already holds the role ${newRole}. No modifications will be made.`);
    } else if (isBlocked) {
      impactPoints.push(impactSummary);
    } else {
      if (user.role === UserRole.MENTEE) {
        impactPoints.push('Learner batch pairings and active course submission access will end');
        impactPoints.push('Active batch membership will be closed with reason: ROLE_CHANGE');
        impactPoints.push(
          'Prior grades, learning history, and submitted assignments remain preserved',
        );
      } else if (user.role === UserRole.MENTOR) {
        impactPoints.push('Batch mentor memberships and mappings in those batches will end');
        impactPoints.push(
          'Created courses remain preserved in the library under creator attribution',
        );
      }
      impactPoints.push(
        'All active user sessions will be immediately terminated (tokenVersion incremented)',
      );
    }

    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      currentRole: user.role,
      newRole,
      isSameRole,
      willRevokeSessions: !isSameRole && !isBlocked,
      isBlocked,
      blockReason,
      activeMenteesCount: activeMentees.length,
      activeMentees,
      impactPoints,
      impactSummary,
    };
  }

  public async resendInvite(id: string): Promise<{ message: string }> {
    const user = await this.getUserById(id);

    if (!user.isActive) {
      throw new BadRequestError('Cannot resend invite to a deactivated user', 'USER_INACTIVE');
    }

    if (!user.mustChangePassword) {
      throw new BadRequestError(
        'User has already set up their password',
        'USER_ALREADY_SET_PASSWORD',
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    user.passwordHash = await hashPassword(temporaryPassword);
    user.mustChangePassword = true;
    await this.repo.transaction(async (manager) => {
      await this.repo.save(user, manager);
      await this.repo.incrementTokenVersion(user.id, manager);
    });

    try {
      await emailService.sendInviteEmail({
        to: user.email,
        name: user.name,
        temporaryPassword,
        role: user.role,
      });
    } catch (err) {
      logger.error({ err, userId: user.id }, 'Failed to dispatch resend invite email');
      throw new BadGatewayError(
        'Failed to deliver invitation email via SMTP. Please check email configuration and retry.',
        'INVITE_EMAIL_DELIVERY_FAILED',
      );
    }

    return { message: `Invite successfully resent to ${user.email}` };
  }
}

export const usersService = new UsersService();
