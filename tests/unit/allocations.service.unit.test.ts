import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { QueryFailedError } from 'typeorm';

import type { AuthenticatedUser } from '../../src/core/auth';
import { emailService } from '../../src/core/email';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/core/errors';
import {
  allocationsRepository,
  allocationsService,
  AssignmentDueOverride,
  CourseAllocation,
  CourseAllocationStatus,
  listAllocationsQuerySchema,
} from '../../src/modules/allocations';
import { type Batch, BatchMember, BatchMemberRole, BatchStatus } from '../../src/modules/batches';
import type { Course } from '../../src/modules/courses';
import type { User, UserRole } from '../../src/modules/users';

const createTestUser = (overrides: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@TechEniac.com',
  role: 'SUPER_ADMIN',
  mustChangePassword: false,
  tokenVersion: 1,
  ...overrides,
});

void describe('AllocationsService Unit Tests (PRD M7: ALC-01 to ALC-24)', () => {
  const adminUser = createTestUser({ id: 'admin-1', role: 'SUPER_ADMIN' });
  const mentorUser = createTestUser({ id: 'mentor-1', role: 'MENTOR' });

  const activeCourse = {
    id: 'course-1',
    title: 'TypeScript Essentials',
    isActive: true,
    estimatedMinutes: 120, // 2 hours
  } as Course;

  const inactiveCourse = {
    id: 'course-inactive',
    title: 'Legacy Cobol',
    isActive: false,
    estimatedMinutes: 60,
  } as Course;

  const liveBatch = {
    id: 'batch-1',
    name: 'Batch Alfa',
    code: 'ALFA-2026',
    status: BatchStatus.LIVE,
  } as unknown as Batch;

  const draftBatch = {
    id: 'batch-draft',
    name: 'Batch Beta Draft',
    code: 'BETA-2026',
    status: BatchStatus.DRAFT,
  } as unknown as Batch;

  const archivedBatch = {
    id: 'batch-archived',
    name: 'Batch Gamma Archived',
    code: 'GAMMA-2025',
    status: BatchStatus.ARCHIVED,
  } as unknown as Batch;

  beforeEach(() => {
    emailService.sendCourseAllocatedEmail = () => Promise.resolve();
    emailService.sendCourseDeadlineChangedEmail = () => Promise.resolve();

    allocationsRepository.findCourseById = (id: string) => {
      if (id === activeCourse.id) return Promise.resolve(activeCourse);
      if (id === inactiveCourse.id) return Promise.resolve(inactiveCourse);
      return Promise.resolve(null);
    };

    allocationsRepository.findBatchById = (id: string) => {
      if (id === liveBatch.id) return Promise.resolve(liveBatch);
      if (id === draftBatch.id) return Promise.resolve(draftBatch);
      if (id === archivedBatch.id) return Promise.resolve(archivedBatch);
      return Promise.resolve(null);
    };

    allocationsRepository.findUsersByIds = (ids: string[]) => {
      const mockUsers = ids.map((id) => ({
        id,
        name: `User ${id}`,
        email: `${id}@TechEniac.com`,
        role: (id.startsWith('mentor') ? 'MENTOR' : 'MENTEE') as UserRole,
        isActive: true,
      })) as unknown as User[];
      return Promise.resolve(mockUsers);
    };

    allocationsRepository.findBatchMember = (
      batchId: string,
      userId: string,
      role: BatchMemberRole,
    ) => {
      if (userId === 'mentor-1' && batchId === 'batch-1' && role === BatchMemberRole.MENTOR) {
        return Promise.resolve({
          id: 'bm-1',
          batchId,
          userId,
          memberRole: role,
          isActive: true,
        } as unknown as BatchMember);
      }
      if (userId === 'mentee-1' && batchId === 'batch-1' && role === BatchMemberRole.MENTEE) {
        return Promise.resolve({
          id: 'bm-2',
          batchId,
          userId,
          memberRole: role,
          isActive: true,
        } as unknown as BatchMember);
      }
      return Promise.resolve(null);
    };

    allocationsRepository.findActiveBatchMenteeMembers = (batchId: string) => {
      if (batchId === 'batch-1') {
        return Promise.resolve([
          { userId: 'mentee-1' },
          { userId: 'mentee-2' },
          { userId: 'mentee-3' },
        ] as unknown as BatchMember[]);
      }
      return Promise.resolve([]);
    };

    allocationsRepository.findActiveBatchMenteesByUserIds = (
      batchId: string,
      userIds: string[],
    ) => {
      const members = userIds
        .filter((id) => batchId === 'batch-1' && id !== 'mentee-alien-to-batch')
        .map(
          (id) =>
            ({
              id: `bm-${id}`,
              batchId,
              userId: id,
              memberRole: BatchMemberRole.MENTEE,
              isActive: true,
            }) as unknown as BatchMember,
        );
      return Promise.resolve(members);
    };

    allocationsRepository.findActiveMentorBatchIds = (mentorId: string) => {
      if (mentorId === 'mentor-1') return Promise.resolve(['batch-1']);
      return Promise.resolve([]);
    };

    allocationsRepository.findOpenAllocationsForMentees = () => Promise.resolve([]);

    allocationsRepository.saveAllocations = (allocs: CourseAllocation[]) => {
      const saved = allocs.map((a, idx) => {
        a.id = `alloc-${idx + 1}`;
        return a;
      });
      return Promise.resolve(saved);
    };
  });

  void describe('Course Status & Date Validation (ALC-01, 10, 11, 12, 22, 23)', () => {
    void it('rejects allocating an inactive course (FR-270)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: inactiveCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /Cannot allocate an inactive course/);
          return true;
        },
      );
    });

    void it('rejects when course has no estimated minutes and no due date is provided (ALC-11)', async () => {
      const courseWithoutEstimate = {
        ...activeCourse,
        id: 'course-no-est',
        estimatedMinutes: null,
      };
      allocationsRepository.findCourseById = () => Promise.resolve(courseWithoutEstimate);

      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: 'course-no-est',
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /no estimated minutes and no due date/);
          return true;
        },
      );
    });

    void it('rejects when due date is earlier than start date (ALC-12)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-05T00:00:00.000Z',
              dueDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /Due date earlier than start date/);
          return true;
        },
      );
    });

    void it('calculates default due date from start date + course estimated minutes (ALC-10)', async () => {
      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'INDIVIDUAL_MENTEES',
          menteeIds: ['mentee-1'],
          startDate: '2026-11-01T10:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 1);
      const expectedDue = new Date(
        new Date('2026-11-01T10:00:00.000Z').getTime() + 120 * 60 * 1000,
      );
      assert.equal(result.created[0].dueDate.toISOString(), expectedDue.toISOString());
    });

    void it('dispatches course allocation email with correct recipient and course metadata (ALC-15)', async () => {
      let emailDispatchedTo = '';
      let emailCourseTitle = '';

      emailService.sendCourseAllocatedEmail = (options) => {
        emailDispatchedTo = options.to;
        emailCourseTitle = options.courseTitle;
        return Promise.resolve();
      };

      await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'INDIVIDUAL_MENTEES',
          menteeIds: ['mentee-1'],
          startDate: '2026-11-01T10:00:00.000Z',
        },
        adminUser,
      );

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(emailDispatchedTo, 'mentee-1@TechEniac.com');
      assert.equal(emailCourseTitle, activeCourse.title);
    });

    void it('rejects assigning to Archived batches (ALC-22)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'BATCH',
              batchId: archivedBatch.id,
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Only DRAFT and LIVE batches can receive allocations/);
          return true;
        },
      );
    });

    void it('allows assigning to Draft batches (ALC-23)', async () => {
      allocationsRepository.findActiveBatchMenteeMembers = () =>
        Promise.resolve([{ userId: 'mentee-1' }] as unknown as BatchMember[]);

      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'BATCH',
          batchId: draftBatch.id,
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 1);
      assert.equal(result.created[0].batchId, draftBatch.id);
    });
  });

  void describe('Role & Mentor Scope Validation (ALC-04, 05, 06, 07, 08, 09)', () => {
    void it('allows Super Admin to assign to individual mentees outside any batch with batchId null (ALC-04)', async () => {
      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'INDIVIDUAL_MENTEES',
          menteeIds: ['mentee-1'],
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 1);
      assert.equal(result.created[0].batchId, null);
    });

    void it('rejects Mentor from assigning to individual mentees outside a batch (ALC-04, FR-7.1c)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            mentorUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Mentors can only allocate courses to batches/);
          return true;
        },
      );
    });

    void it('allows Mentor to assign to a batch where they are an active mentor (ALC-05)', async () => {
      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'BATCH',
          batchId: liveBatch.id,
          startDate: '2026-11-01T00:00:00.000Z',
        },
        mentorUser,
      );

      assert.equal(result.created.length, 3);
      assert.equal(result.created[0].batchId, liveBatch.id);
    });

    void it('rejects Mentor trying to assign to a batch where they are not a member with 403 (ALC-06)', async () => {
      const otherMentor = createTestUser({ id: 'mentor-stranger', role: 'MENTOR' });

      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'BATCH',
              batchId: liveBatch.id,
              startDate: '2026-11-01T00:00:00.000Z',
            },
            otherMentor,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(
            err.message,
            /Mentor cannot assign courses to a batch where they are not an active member/,
          );
          return true;
        },
      );
    });

    void it('rejects Mentor trying to select a mentee outside their batch (ALC-07)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'SELECTED_MENTEES',
              batchId: liveBatch.id,
              menteeIds: ['mentee-alien-to-batch'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            mentorUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Selected mentee.*not active mentee member/);
          return true;
        },
      );
    });

    void it('rejects Super Admin trying to select a mentee outside the specified batch in SELECTED_MENTEES', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'SELECTED_MENTEES',
              batchId: liveBatch.id,
              menteeIds: ['mentee-alien-to-batch'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Selected mentee.*not active mentee member/);
          return true;
        },
      );
    });

    void it('rejects when requested mentee ID is not found in database', async () => {
      allocationsRepository.findUsersByIds = () => Promise.resolve([]);
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['00000000-0000-0000-0000-000000000000'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof NotFoundError);
          assert.match(err.message, /Mentee\(s\) not found/);
          return true;
        },
      );
    });

    void it('rejects assigning course to a user whose role is MENTOR or SUPER_ADMIN (ALC-09)', async () => {
      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentor-target'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Courses can be assigned to mentees only/);
          return true;
        },
      );
    });
  });

  void describe('Duplicate Prevention & Bulk Skip Rules (ALC-13, 21)', () => {
    void it('rejects individual mentee assignment if mentee already has an open allocation (ALC-13)', async () => {
      allocationsRepository.findOpenAllocationsForMentees = () =>
        Promise.resolve([
          { userId: 'mentee-1', courseId: activeCourse.id } as unknown as CourseAllocation,
        ]);

      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /already has an open allocation of the same course/);
          return true;
        },
      );
    });

    void it('skips duplicate open allocations in bulk batch assignments without failing (ALC-21)', async () => {
      allocationsRepository.findOpenAllocationsForMentees = () =>
        Promise.resolve([
          { userId: 'mentee-2', courseId: activeCourse.id } as unknown as CourseAllocation,
        ]);

      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'BATCH',
          batchId: liveBatch.id,
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 2);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].menteeId, 'mentee-2');
    });

    void it('returns empty created array and all skipped entries when all batch mentees already have open allocations', async () => {
      allocationsRepository.findOpenAllocationsForMentees = () =>
        Promise.resolve([
          { userId: 'mentee-1', courseId: activeCourse.id } as unknown as CourseAllocation,
          { userId: 'mentee-2', courseId: activeCourse.id } as unknown as CourseAllocation,
          { userId: 'mentee-3', courseId: activeCourse.id } as unknown as CourseAllocation,
        ]);

      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'BATCH',
          batchId: liveBatch.id,
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 0);
      assert.equal(result.skipped.length, 3);
    });

    void it('allows re-allocating a course if previous allocation was COMPLETED or REVOKED (ALC-14)', async () => {
      // Completed / revoked allocations are NOT open allocations, so findOpenAllocationsForMentees returns empty
      allocationsRepository.findActiveMentorBatchIds = (mentorId: string) => {
        if (mentorId === 'mentor-1') return Promise.resolve(['batch-1']);
        return Promise.resolve([]);
      };

      allocationsRepository.findOpenAllocationsForMentees = () => Promise.resolve([]);

      let createdCount = 0;
      allocationsRepository.saveAllocations = (allocs) => {
        createdCount = allocs.length;
        return Promise.resolve(allocs);
      };

      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'INDIVIDUAL_MENTEES',
          menteeIds: ['mentee-1'],
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(createdCount, 1);
      assert.equal(result.created.length, 1);
      assert.equal(result.skipped.length, 0);
    });

    void it('tracks duplicate mentee IDs in the request body under skipped with reason', async () => {
      allocationsRepository.findActiveMentorBatchIds = (mentorId: string) => {
        if (mentorId === 'mentor-1') return Promise.resolve(['batch-1']);
        return Promise.resolve([]);
      };

      allocationsRepository.findOpenAllocationsForMentees = () => Promise.resolve([]);

      const result = await allocationsService.createAllocations(
        {
          courseId: activeCourse.id,
          targetType: 'SELECTED_MENTEES',
          batchId: liveBatch.id,
          menteeIds: ['mentee-1', 'mentee-1'],
          startDate: '2026-11-01T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.created.length, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].menteeId, 'mentee-1');
      assert.equal(result.skipped[0].reason, 'Duplicate ID in request');
    });

    void it('maps concurrent unique constraint violation to ConflictError (ALC-13 TOCTOU race)', async () => {
      allocationsRepository.findOpenAllocationsForMentees = () => Promise.resolve([]);
      allocationsRepository.saveAllocations = () => {
        const error = new QueryFailedError(
          'INSERT INTO course_allocations ...',
          [],
          new Error('duplicate key value violates unique constraint'),
        );
        (error as QueryFailedError & { driverError?: { code?: string } }).driverError = {
          code: '23505',
        };
        return Promise.reject(error);
      };

      await assert.rejects(
        async () => {
          await allocationsService.createAllocations(
            {
              courseId: activeCourse.id,
              targetType: 'INDIVIDUAL_MENTEES',
              menteeIds: ['mentee-1'],
              startDate: '2026-11-01T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /Mentee already has an open allocation of this course/);
          return true;
        },
      );
    });
  });

  void describe('Allocation Updates & Revocation (ALC-17, 18, 20)', () => {
    void it('allows Mentor to edit due date of an allocation in their batch (ALC-17)', async () => {
      const mockAlloc = {
        id: 'alloc-1',
        batchId: liveBatch.id,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.saveAllocation = (a) => Promise.resolve(a);

      const updated = await allocationsService.updateAllocationDates(
        'alloc-1',
        { dueDate: '2026-11-15T00:00:00.000Z' },
        mentorUser,
      );

      assert.equal(
        updated.dueDate.toISOString(),
        new Date('2026-11-15T00:00:00.000Z').toISOString(),
      );
    });

    void it('dispatches course deadline changed email with correct metadata when due date changes', async () => {
      let emailDispatchedTo = '';
      let emailNewDueDate = '';

      emailService.sendCourseDeadlineChangedEmail = (options) => {
        emailDispatchedTo = options.to;
        emailNewDueDate = options.newDueDate;
        return Promise.resolve();
      };

      const mockAlloc = {
        id: 'alloc-email-test',
        batchId: liveBatch.id,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
        user: { name: 'Mentee 1', email: 'mentee-1@TechEniac.com' },
        course: { title: 'TypeScript Essentials' },
      } as unknown as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.saveAllocation = (a) => Promise.resolve(a);

      await allocationsService.updateAllocationDates(
        'alloc-email-test',
        { dueDate: '2026-11-20T00:00:00.000Z' },
        adminUser,
      );

      assert.equal(emailDispatchedTo, 'mentee-1@TechEniac.com');
      assert.equal(emailNewDueDate, '2026-11-20');
    });

    void it('denies Mentor editing an allocation in a batch not belonging to them (ALC-18)', async () => {
      const mockAlloc = {
        id: 'alloc-other',
        batchId: 'foreign-batch-uuid',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.updateAllocationDates(
            'alloc-other',
            { dueDate: '2026-11-15T00:00:00.000Z' },
            mentorUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(
            err.message,
            /Mentor cannot manage allocations for a batch where they are not an active member/,
          );
          return true;
        },
      );
    });

    void it('soft revokes allocation setting status to REVOKED while retaining progress (ALC-20)', async () => {
      const mockAlloc = {
        id: 'alloc-revoke',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.IN_PROGRESS,
        progressPercent: 40,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.saveAllocation = (a) => Promise.resolve(a);

      const revoked = await allocationsService.revokeAllocation('alloc-revoke', adminUser);

      assert.equal(revoked.status, CourseAllocationStatus.REVOKED);
      assert.equal(revoked.progressPercent, 40);
    });

    void it('rejects updating dates for an allocation in COMPLETED status with ConflictError', async () => {
      const mockAlloc = {
        id: 'alloc-completed',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.COMPLETED,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.updateAllocationDates(
            'alloc-completed',
            { dueDate: '2026-11-20T00:00:00.000Z' },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /Cannot modify allocation in terminal status/);
          return true;
        },
      );
    });

    void it('rejects revoking an allocation that is already REVOKED or COMPLETED with ConflictError', async () => {
      const mockAlloc = {
        id: 'alloc-already-revoked',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.REVOKED,
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.revokeAllocation('alloc-already-revoked', adminUser);
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /Cannot modify allocation in terminal status/);
          return true;
        },
      );
    });

    void it('bulkUpdateAllocationDates updates valid allocations and records missing and terminal ones in skipped', async () => {
      const validAlloc = {
        id: 'alloc-valid',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.ASSIGNED,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      const completedAlloc = {
        id: 'alloc-term',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.COMPLETED,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationsByIds = () =>
        Promise.resolve([validAlloc, completedAlloc]);

      allocationsRepository.saveAllocations = (allocs) => Promise.resolve(allocs);

      const result = await allocationsService.bulkUpdateAllocationDates(
        {
          allocationIds: ['alloc-valid', 'alloc-term', 'alloc-missing'],
          dueDate: '2026-11-25T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.allocations.length, 1);
      assert.equal(result.allocations[0].id, 'alloc-valid');
      assert.equal(result.skipped.length, 2);

      const missingSkipped = result.skipped.find((s) => s.allocationId === 'alloc-missing');
      assert.ok(missingSkipped);
      assert.equal(missingSkipped.reason, 'Allocation not found');

      const termSkipped = result.skipped.find((s) => s.allocationId === 'alloc-term');
      assert.ok(termSkipped);
      assert.equal(termSkipped.reason, 'Allocation is closed or completed');
    });
  });

  void describe('Lifecycle Handlers & Batch Triggers (USR-05, BAT-10, BAT-12)', () => {
    void it('closes open allocations as CLOSED_ROLE_CHANGE on mentee role change and threads actorId (USR-05)', async () => {
      let closedUserId = '';
      let passedActorId: string | null | undefined;

      allocationsRepository.closeAllocationsForRoleChange = (
        userId: string,
        actorId?: string | null,
      ) => {
        closedUserId = userId;
        passedActorId = actorId;
        return Promise.resolve(1);
      };

      await allocationsService.handleUserRoleChanged({
        userId: 'mentee-promoted',
        newRole: 'MENTOR',
        actorId: 'admin-actor-1',
      });

      assert.equal(closedUserId, 'mentee-promoted');
      assert.equal(passedActorId, 'admin-actor-1');
    });

    void it('closes old batch allocations as CLOSED_BATCH_CHANGE with actorId and reallocates in new batch (BAT-10)', async () => {
      let closedBatchId = '';
      let closedMenteeId = '';
      let passedActorId: string | null | undefined;

      allocationsRepository.closeAllocationsForBatchTransfer = (batchId, menteeId, actorId) => {
        closedBatchId = batchId;
        closedMenteeId = menteeId;
        passedActorId = actorId;
        return Promise.resolve(1);
      };

      const futureDate = new Date(Date.now() + 86400000 * 10);
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-existing',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: futureDate,
            course: activeCourse,
          } as CourseAllocation,
        ]);
      };

      let createdAllocationsCount = 0;
      allocationsRepository.saveAllocations = (allocs) => {
        createdAllocationsCount = allocs.length;
        return Promise.resolve(allocs);
      };

      await allocationsService.handleBatchMemberTransferred({
        batchId: 'source-batch-id',
        menteeId: 'mentee-transferred',
        newBatchId: liveBatch.id,
        actorId: 'admin-1',
      });

      assert.equal(closedBatchId, 'source-batch-id');
      assert.equal(closedMenteeId, 'mentee-transferred');
      assert.equal(passedActorId, 'admin-1');
      assert.equal(createdAllocationsCount, 1);
    });

    void it('skips reallocation when latest due date of batch course has already passed (BAT-10)', async () => {
      const pastDate = new Date(Date.now() - 86400000); // 1 day ago
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-expired',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: pastDate,
          } as CourseAllocation,
        ]);
      };

      let saveCalled = false;
      allocationsRepository.saveAllocations = (allocs) => {
        saveCalled = true;
        return Promise.resolve(allocs);
      };

      await allocationsService.handleBatchMemberTransferred({
        batchId: 'source-batch-id',
        menteeId: 'mentee-transferred',
        newBatchId: liveBatch.id,
        actorId: 'admin-1',
      });

      assert.equal(saveCalled, false);
    });

    void it('allocates open courses of a Live batch to joining mentee if due date is in future (BAT-12)', async () => {
      const futureDate = new Date(Date.now() + 86400000 * 5);
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-live-1',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: futureDate,
            course: activeCourse,
          } as CourseAllocation,
        ]);
      };

      let createdAllocationsCount = 0;
      allocationsRepository.saveAllocations = (allocs) => {
        createdAllocationsCount = allocs.length;
        return Promise.resolve(allocs);
      };

      await allocationsService.handleBatchMemberJoined({
        batchId: liveBatch.id,
        userId: 'new-mentee-1',
        role: 'MENTEE',
        actorId: 'admin-1',
      });

      assert.equal(createdAllocationsCount, 1);
    });

    void it('skips reallocation when latest due date of batch course has already passed (BAT-12)', async () => {
      const pastDate = new Date(Date.now() - 86400000); // 1 day ago
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-expired',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: pastDate,
          } as CourseAllocation,
        ]);
      };

      let saveCalled = false;
      allocationsRepository.saveAllocations = (allocs) => {
        saveCalled = true;
        return Promise.resolve(allocs);
      };

      await allocationsService.handleBatchMemberJoined({
        batchId: liveBatch.id,
        userId: 'new-mentee-past',
        role: 'MENTEE',
      });

      assert.equal(saveCalled, false);
    });

    void it('does not allocate courses when batch is not LIVE (BAT-12)', async () => {
      let saveCalled = false;
      allocationsRepository.saveAllocations = (allocs) => {
        saveCalled = true;
        return Promise.resolve(allocs);
      };

      await allocationsService.handleBatchMemberJoined({
        batchId: draftBatch.id,
        userId: 'new-mentee-2',
        role: 'MENTEE',
      });

      assert.equal(saveCalled, false);
    });

    void it('handles duplicate ConflictError on batch member join gracefully without throwing', async () => {
      const futureDate = new Date(Date.now() + 86400000 * 5);
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-live-1',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: futureDate,
          } as CourseAllocation,
        ]);
      };

      // Mentee already has open allocation in new batch
      allocationsRepository.findOpenAllocationsForMentees = () =>
        Promise.resolve([{ id: 'existing-alloc', userId: 'dup-mentee' } as CourseAllocation]);

      let saveCalled = false;
      allocationsRepository.saveAllocations = (allocs) => {
        saveCalled = true;
        return Promise.resolve(allocs);
      };

      // Should complete gracefully with logging, not throwing error
      await allocationsService.handleBatchMemberJoined({
        batchId: liveBatch.id,
        userId: 'dup-mentee',
        role: 'MENTEE',
      });

      assert.equal(saveCalled, false);
    });

    void it('handles unexpected error on batch member transfer gracefully without throwing', async () => {
      allocationsRepository.closeAllocationsForBatchTransfer = () => Promise.resolve(0);
      const futureDate = new Date(Date.now() + 86400000 * 5);
      allocationsRepository.findOpenBatchAllocations = () => {
        return Promise.resolve([
          {
            id: 'alloc-live-1',
            courseId: activeCourse.id,
            batchId: liveBatch.id,
            dueDate: futureDate,
          } as CourseAllocation,
        ]);
      };

      allocationsRepository.saveAllocations = () =>
        Promise.reject(new Error('Unexpected DB crash'));

      // Should complete gracefully with error logging, not crashing process
      await allocationsService.handleBatchMemberTransferred({
        batchId: 'source-batch-id',
        menteeId: 'mentee-transferred',
        newBatchId: liveBatch.id,
      });
    });
  });

  void describe('Assignment Due Overrides (FR-7.6)', () => {
    void it('allows setting an assignment due-date override', async () => {
      const mockAlloc = {
        id: 'alloc-1',
        batchId: liveBatch.id,
        courseId: activeCourse.id,
        userId: 'mentee-1',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-20T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.findAssignmentOverride = () => Promise.resolve(null);
      allocationsRepository.saveAssignmentOverride = (override) => Promise.resolve(override);

      const override = await allocationsService.setAssignmentDueOverride(
        'alloc-1',
        {
          assignmentId: 'assign-uuid-1',
          dueDate: '2026-11-25T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(override.assignmentId, 'assign-uuid-1');
      assert.equal(
        override.dueDate.toISOString(),
        new Date('2026-11-25T00:00:00.000Z').toISOString(),
      );
    });

    void it('rejects setting an assignment due override on a COMPLETED allocation with ConflictError', async () => {
      const mockAlloc = {
        id: 'alloc-completed',
        batchId: liveBatch.id,
        courseId: activeCourse.id,
        userId: 'mentee-1',
        status: CourseAllocationStatus.COMPLETED,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-20T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.setAssignmentDueOverride(
            'alloc-completed',
            {
              assignmentId: 'assign-uuid-1',
              dueDate: '2026-11-25T00:00:00.000Z',
            },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ConflictError);
          assert.match(err.message, /Cannot modify allocation in terminal status/);
          return true;
        },
      );
    });

    void it('bulkSetAssignmentDueOverrides sets overrides and tracks missing/terminal allocations in skipped', async () => {
      const validAlloc = {
        id: 'alloc-valid',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.ASSIGNED,
      } as CourseAllocation;

      const revokedAlloc = {
        id: 'alloc-revoked',
        batchId: liveBatch.id,
        status: CourseAllocationStatus.REVOKED,
      } as CourseAllocation;

      allocationsRepository.findAllocationsByIds = () =>
        Promise.resolve([validAlloc, revokedAlloc]);

      allocationsRepository.findAssignmentOverride = () => Promise.resolve(null);
      allocationsRepository.saveAssignmentOverride = (o) => Promise.resolve(o);

      const result = await allocationsService.bulkSetAssignmentDueOverrides(
        {
          allocationIds: ['alloc-valid', 'alloc-revoked', 'alloc-ghost'],
          assignmentId: 'assign-uuid-2',
          dueDate: '2026-11-28T00:00:00.000Z',
        },
        adminUser,
      );

      assert.equal(result.overrides.length, 1);
      assert.equal(result.skipped.length, 2);

      const ghostSkipped = result.skipped.find((s) => s.allocationId === 'alloc-ghost');
      assert.ok(ghostSkipped);
      assert.equal(ghostSkipped.reason, 'Allocation not found');

      const termSkipped = result.skipped.find((s) => s.allocationId === 'alloc-revoked');
      assert.ok(termSkipped);
      assert.equal(termSkipped.reason, 'Allocation is closed or completed');
    });

    void it('getAssignmentOverrides allows mentee to view their own allocation overrides', async () => {
      const menteeUser = createTestUser({ id: 'mentee-1', role: 'MENTEE' });
      const mockAlloc = {
        id: 'alloc-mentee-1',
        userId: 'mentee-1',
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.findOverridesByAllocationId = () =>
        Promise.resolve([{ id: 'override-1', assignmentId: 'assign-1' } as AssignmentDueOverride]);

      const overrides = await allocationsService.getAssignmentOverrides(
        'alloc-mentee-1',
        menteeUser,
      );
      assert.equal(overrides.length, 1);
    });

    void it('getAssignmentOverrides denies mentee viewing another mentee allocation overrides with ForbiddenError', async () => {
      const menteeUser = createTestUser({ id: 'mentee-1', role: 'MENTEE' });
      const mockAlloc = {
        id: 'alloc-mentee-other',
        userId: 'mentee-2',
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.getAssignmentOverrides('alloc-mentee-other', menteeUser);
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Access denied/);
          return true;
        },
      );
    });
  });

  void describe('List & Get Allocation Authorization (ALC-16, FR-7.4)', () => {
    void it('listAllocations scopes query to mentee own userId when called by MENTEE', async () => {
      const menteeUser = createTestUser({ id: 'mentee-scoped', role: 'MENTEE' });
      let passedEnforcedUserId: string | null | undefined;

      allocationsRepository.listAllocations = (_query, _batches, enforcedUserId) => {
        passedEnforcedUserId = enforcedUserId;
        return Promise.resolve({ allocations: [], total: 0, page: 1, limit: 20 });
      };

      await allocationsService.listAllocations({ page: 1, limit: 20 }, menteeUser);
      assert.equal(passedEnforcedUserId, 'mentee-scoped');
    });

    void it('listAllocations scopes query to mentor accessible batch IDs when called by MENTOR', async () => {
      let passedBatchIds: string[] | null | undefined;

      allocationsRepository.listAllocations = (_query, allowedBatchIds) => {
        passedBatchIds = allowedBatchIds;
        return Promise.resolve({ allocations: [], total: 0, page: 1, limit: 20 });
      };

      await allocationsService.listAllocations({ page: 1, limit: 20 }, mentorUser);
      assert.ok(Array.isArray(passedBatchIds));
      assert.ok(passedBatchIds.includes(liveBatch.id));
    });

    void it('listAllocations allows Super Admin to list across all batches and mentees', async () => {
      let passedBatchIds: string[] | null | undefined;
      let passedUserId: string | null | undefined;

      allocationsRepository.listAllocations = (_query, allowedBatchIds, enforcedUserId) => {
        passedBatchIds = allowedBatchIds;
        passedUserId = enforcedUserId;
        return Promise.resolve({ allocations: [], total: 0, page: 1, limit: 20 });
      };

      await allocationsService.listAllocations({ page: 1, limit: 20 }, adminUser);
      assert.equal(passedBatchIds, null);
      assert.equal(passedUserId, null);
    });

    void it('getAllocationById allows mentee to retrieve their own allocation', async () => {
      const menteeUser = createTestUser({ id: 'mentee-1', role: 'MENTEE' });
      const mockAlloc = {
        id: 'alloc-1',
        userId: 'mentee-1',
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      const result = await allocationsService.getAllocationById('alloc-1', menteeUser);
      assert.equal(result.id, 'alloc-1');
    });

    void it('getAllocationById denies mentee from retrieving another mentee allocation with ForbiddenError', async () => {
      const menteeUser = createTestUser({ id: 'mentee-1', role: 'MENTEE' });
      const mockAlloc = {
        id: 'alloc-2',
        userId: 'mentee-2',
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.getAllocationById('alloc-2', menteeUser);
        },
        (err: unknown) => {
          assert(err instanceof ForbiddenError);
          assert.match(err.message, /Access denied/);
          return true;
        },
      );
    });

    void it('addMenteesToBatchAllocation rejects when allocation has no batchId with ValidationError', async () => {
      const mockAlloc = {
        id: 'alloc-no-batch',
        courseId: activeCourse.id,
        batchId: null,
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);

      await assert.rejects(
        async () => {
          await allocationsService.addMenteesToBatchAllocation(
            'alloc-no-batch',
            { menteeIds: ['mentee-1'] },
            adminUser,
          );
        },
        (err: unknown) => {
          assert(err instanceof ValidationError);
          assert.match(err.message, /Cannot add mentees to an allocation that has no batch/);
          return true;
        },
      );
    });

    void it('addMenteesToBatchAllocation delegates to createAllocations for batch allocation', async () => {
      const mockAlloc = {
        id: 'alloc-with-batch',
        courseId: activeCourse.id,
        batchId: liveBatch.id,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        dueDate: new Date('2026-11-15T00:00:00.000Z'),
      } as CourseAllocation;

      allocationsRepository.findAllocationById = () => Promise.resolve(mockAlloc);
      allocationsRepository.findActiveMentorBatchIds = (mentorId: string) => {
        if (mentorId === 'mentor-1') return Promise.resolve(['batch-1']);
        return Promise.resolve([]);
      };

      allocationsRepository.findOpenAllocationsForMentees = () => Promise.resolve([]);
      allocationsRepository.saveAllocations = (allocs) => Promise.resolve(allocs);

      const result = await allocationsService.addMenteesToBatchAllocation(
        'alloc-with-batch',
        { menteeIds: ['mentee-1'] },
        adminUser,
      );

      assert.equal(result.created.length, 1);
    });

    void it('defaults pagination limit to 10 in listAllocationsQuerySchema', () => {
      const parsed = listAllocationsQuerySchema.shape.query.parse({});
      assert.equal(parsed.limit, 10);
      assert.equal(parsed.page, 1);
    });
  });
});
