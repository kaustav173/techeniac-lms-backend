import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { BadRequestError } from '../../src/core/errors';
import { batchService, type MentorMentee } from '../../src/modules/batches';
import {
  ALLOWED_ROLE_TRANSITIONS,
  User,
  userRepository,
  UserRole,
  usersService,
} from '../../src/modules/users';

void describe('User Role Transition Rules Unit Tests', () => {
  const menteeUser = {
    id: '11111111-1111-4111-a111-111111111111',
    name: 'Mentee User',
    email: 'mentee@TechEniac.com',
    role: UserRole.MENTEE,
    isActive: true,
  } as unknown as User;

  const mentorUser = {
    id: '22222222-2222-4222-a222-222222222222',
    name: 'Mentor User',
    email: 'mentor@TechEniac.com',
    role: UserRole.MENTOR,
    isActive: true,
  } as unknown as User;

  const superAdminUser = {
    id: '33333333-3333-4333-a333-333333333333',
    name: 'Super Admin User',
    email: 'admin@TechEniac.com',
    role: UserRole.SUPER_ADMIN,
    isActive: true,
  } as unknown as User;

  beforeEach(() => {
    userRepository.findById = (id: string): Promise<User | null> => {
      if (id === menteeUser.id) return Promise.resolve(menteeUser);
      if (id === mentorUser.id) return Promise.resolve(mentorUser);
      if (id === superAdminUser.id) return Promise.resolve(superAdminUser);
      return Promise.resolve(null);
    };
    batchService.getActiveMappingsForMentor = (): Promise<MentorMentee[]> => Promise.resolve([]);
  });

  void describe('Transition Matrix Verification', () => {
    void it('enforces Mentee can only transition to Mentor', () => {
      assert.deepEqual(ALLOWED_ROLE_TRANSITIONS[UserRole.MENTEE], [UserRole.MENTOR]);
    });

    void it('enforces Mentor can only transition to Super Admin', () => {
      assert.deepEqual(ALLOWED_ROLE_TRANSITIONS[UserRole.MENTOR], [UserRole.SUPER_ADMIN]);
    });

    void it('enforces Super Admin role cannot transition to any role', () => {
      assert.deepEqual(ALLOWED_ROLE_TRANSITIONS[UserRole.SUPER_ADMIN], []);
    });
  });

  void describe('getRoleImpact live checks', () => {
    void it('allows Mentee to transition to Mentor', async () => {
      const impact = await usersService.getRoleImpact(menteeUser.id, UserRole.MENTOR);
      assert.equal(impact.isBlocked, false);
      assert.equal(impact.blockReason, null);
      assert.equal(impact.newRole, UserRole.MENTOR);
      assert.equal(impact.willRevokeSessions, true);
      assert.ok(impact.impactPoints.length > 0);
    });

    void it('blocks Mentee from transitioning directly to Super Admin', async () => {
      const impact = await usersService.getRoleImpact(menteeUser.id, UserRole.SUPER_ADMIN);
      assert.equal(impact.isBlocked, true);
      assert.equal(impact.blockReason, 'INVALID_ROLE_TRANSITION');
      assert.equal(impact.willRevokeSessions, false);
      assert.deepEqual(impact.impactPoints, [impact.impactSummary]);
      assert.match(impact.impactSummary, /MENTEE can only be transitioned to MENTOR/);
    });

    void it('blocks Mentor from transitioning back to Mentee', async () => {
      const impact = await usersService.getRoleImpact(mentorUser.id, UserRole.MENTEE);
      assert.equal(impact.isBlocked, true);
      assert.equal(impact.blockReason, 'INVALID_ROLE_TRANSITION');
      assert.equal(impact.willRevokeSessions, false);
      assert.deepEqual(impact.impactPoints, [impact.impactSummary]);
      assert.match(impact.impactSummary, /MENTOR can only be transitioned to SUPER_ADMIN/);
    });

    void it('allows Mentor to transition to Super Admin when having zero active mentees', async () => {
      batchService.getActiveMappingsForMentor = (): Promise<MentorMentee[]> => Promise.resolve([]);
      const impact = await usersService.getRoleImpact(mentorUser.id, UserRole.SUPER_ADMIN);
      assert.equal(impact.isBlocked, false);
      assert.equal(impact.blockReason, null);
      assert.equal(impact.willRevokeSessions, true);
      assert.ok(impact.impactPoints.length > 0);
    });

    void it('blocks Mentor from transitioning to Super Admin when having active mentees', async () => {
      batchService.getActiveMappingsForMentor = (): Promise<MentorMentee[]> =>
        Promise.resolve([
          {
            id: 'mapping-1',
            batchId: 'batch-1',
            mentorId: mentorUser.id,
            menteeId: menteeUser.id,
            mentee: { id: menteeUser.id, name: menteeUser.name, email: menteeUser.email },
            batch: { id: 'batch-1', name: 'Batch Alpha' },
          } as unknown as MentorMentee,
        ]);
      const impact = await usersService.getRoleImpact(mentorUser.id, UserRole.SUPER_ADMIN);
      assert.equal(impact.isBlocked, true);
      assert.equal(impact.blockReason, 'ACTIVE_MENTEES');
      assert.equal(impact.willRevokeSessions, false);
      assert.deepEqual(impact.impactPoints, [impact.impactSummary]);
    });

    void it('blocks Super Admin role from being changed to Mentor or Mentee', async () => {
      const impactMentor = await usersService.getRoleImpact(superAdminUser.id, UserRole.MENTOR);
      assert.equal(impactMentor.isBlocked, true);
      assert.equal(impactMentor.blockReason, 'SUPER_ADMIN_ROLE_IMMUTABLE');
      assert.equal(impactMentor.impactSummary, 'Super Admin role cannot be changed.');
      assert.equal(impactMentor.willRevokeSessions, false);
      assert.deepEqual(impactMentor.impactPoints, [impactMentor.impactSummary]);

      const impactMentee = await usersService.getRoleImpact(superAdminUser.id, UserRole.MENTEE);
      assert.equal(impactMentee.isBlocked, true);
      assert.equal(impactMentee.blockReason, 'SUPER_ADMIN_ROLE_IMMUTABLE');
      assert.equal(impactMentee.willRevokeSessions, false);
      assert.deepEqual(impactMentee.impactPoints, [impactMentee.impactSummary]);
    });
  });

  void describe('changeRole enforcement', () => {
    void it('throws BadRequestError when attempting to change Mentee directly to Super Admin', async () => {
      await assert.rejects(
        async () => {
          await usersService.changeRole(
            menteeUser.id,
            { newRole: UserRole.SUPER_ADMIN, reason: 'Promoting directly to admin' },
            'actor-superadmin-id',
          );
        },
        (err: unknown) => {
          assert(err instanceof BadRequestError);
          assert.equal(err.code, 'INVALID_ROLE_TRANSITION');
          return true;
        },
      );
    });

    void it('throws BadRequestError when attempting to demote Mentor to Mentee', async () => {
      await assert.rejects(
        async () => {
          await usersService.changeRole(
            mentorUser.id,
            { newRole: UserRole.MENTEE, reason: 'Demoting back to mentee' },
            'actor-superadmin-id',
          );
        },
        (err: unknown) => {
          assert(err instanceof BadRequestError);
          assert.equal(err.code, 'INVALID_ROLE_TRANSITION');
          return true;
        },
      );
    });

    void it('throws BadRequestError when attempting to change Super Admin role', async () => {
      await assert.rejects(
        async () => {
          await usersService.changeRole(
            superAdminUser.id,
            { newRole: UserRole.MENTOR, reason: 'Changing admin role' },
            'other-superadmin-id',
          );
        },
        (err: unknown) => {
          assert(err instanceof BadRequestError);
          assert.equal(err.code, 'SUPER_ADMIN_ROLE_IMMUTABLE');
          return true;
        },
      );
    });
  });
});
