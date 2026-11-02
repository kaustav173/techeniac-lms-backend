import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { NotFoundError } from '../../src/core/errors';
import { CourseAllocation, CourseAllocationStatus } from '../../src/modules/allocations';
import {
  Batch,
  BatchMember,
  BatchMemberRole,
  BatchReasonToLeave,
  MentorMentee,
} from '../../src/modules/batches';
import { Assignment } from '../../src/modules/courses';
import { Submission, SubmissionStatus } from '../../src/modules/submissions';
import {
  User360Profile,
  User360Repository,
  User360Service,
  User360Tab,
} from '../../src/modules/user-360';
import { User, UserRole, UserRoleHistory } from '../../src/modules/users';

void describe('Module 3: User 360 Profile Unit Tests (HIS-01 to HIS-09)', () => {
  let service: User360Service;
  let mockRepository: Partial<User360Repository>;

  const mockUser = {
    id: 'user-uuid-1',
    name: 'Jane Doe',
    email: 'jane@TechEniac.com',
    role: UserRole.MENTOR,
    isActive: true,
    mustChangePassword: false,
    tokenVersion: 1,
    lastLoginAt: new Date('2026-07-01T10:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    deletedAt: null,
  } as unknown as User;

  const mockRoleHistory = [
    {
      id: 'rh-1',
      userId: 'user-uuid-1',
      role: UserRole.MENTEE,
      fromAt: new Date('2026-01-01T00:00:00Z'),
      toAt: new Date('2026-06-30T23:59:59Z'),
      reason: 'Initial enrollment as mentee',
      changedBy: 'admin-uuid',
    } as unknown as UserRoleHistory,
    {
      id: 'rh-2',
      userId: 'user-uuid-1',
      role: UserRole.MENTOR,
      fromAt: new Date('2026-07-01T00:00:00Z'),
      toAt: null,
      reason: 'Promoted to mentor after graduating',
      changedBy: 'admin-uuid',
    } as unknown as UserRoleHistory,
  ];

  const mockBatchMembers = [
    {
      id: 'bm-1',
      batchId: 'batch-1',
      userId: 'user-uuid-1',
      memberRole: BatchMemberRole.MENTEE,
      joinedAt: new Date('2026-01-15T00:00:00Z'),
      leftAt: new Date('2026-06-30T23:59:59Z'),
      reasonToLeave: BatchReasonToLeave.ROLE_CHANGE,
      isActive: false,
      batch: { id: 'batch-1', name: 'Alpha Batch', code: 'ALPHA-2026' } as unknown as Batch,
    } as unknown as BatchMember,
    {
      id: 'bm-2',
      batchId: 'batch-2',
      userId: 'user-uuid-1',
      memberRole: BatchMemberRole.MENTOR,
      joinedAt: new Date('2026-07-02T00:00:00Z'),
      leftAt: null,
      reasonToLeave: null,
      isActive: true,
      batch: { id: 'batch-2', name: 'Beta Batch', code: 'BETA-2026' } as unknown as Batch,
    } as unknown as BatchMember,
  ];

  const mockMentorMappings = [
    {
      id: 'mm-1',
      batchId: 'batch-1',
      mentorId: 'mentor-uuid-9',
      menteeId: 'user-uuid-1',
      startDate: new Date('2026-01-16T00:00:00Z'),
      endDate: new Date('2026-06-30T00:00:00Z'),
      isActive: false,
      endReason: BatchReasonToLeave.ROLE_CHANGE,
      batch: { id: 'batch-1', code: 'ALPHA-2026' } as unknown as Batch,
      mentor: {
        id: 'mentor-uuid-9',
        name: 'Bob Senior',
        email: 'bob@TechEniac.com',
      } as unknown as User,
      mentee: mockUser,
    } as unknown as MentorMentee,
    {
      id: 'mm-2',
      batchId: 'batch-2',
      mentorId: 'user-uuid-1',
      menteeId: 'mentee-uuid-42',
      startDate: new Date('2026-07-05T00:00:00Z'),
      endDate: null,
      isActive: true,
      endReason: null,
      batch: { id: 'batch-2', code: 'BETA-2026' } as unknown as Batch,
      mentor: mockUser,
      mentee: {
        id: 'mentee-uuid-42',
        name: 'Charlie Junior',
        email: 'charlie@TechEniac.com',
      } as unknown as User,
    } as unknown as MentorMentee,
  ];

  const mockAllocations = [
    {
      id: 'ca-1',
      courseId: 'course-1',
      batchId: 'batch-1',
      userId: 'user-uuid-1',
      startDate: new Date('2026-01-20T00:00:00Z'),
      dueDate: new Date('2026-03-20T00:00:00Z'),
      completedAt: new Date('2026-03-15T00:00:00Z'),
      status: CourseAllocationStatus.COMPLETED,
      progressPercent: 100,
      course: { id: 'course-1', title: 'Full Stack TypeScript' },
      batch: { id: 'batch-1', code: 'ALPHA-2026' },
    } as unknown as CourseAllocation,
  ];

  const mockSubmissions = [
    {
      id: 'sub-1',
      assignmentId: 'assign-1',
      courseAllocationId: 'ca-1',
      batchId: 'batch-1',
      version: 1,
      status: SubmissionStatus.GRADED,
      submittedAt: new Date('2026-02-10T12:00:00Z'),
      isLate: false,
      marks: 92,
      gradeLabel: 'A',
      feedback: 'Excellent work!',
      gradedAt: new Date('2026-02-12T14:00:00Z'),
      grader: { id: 'mentor-uuid-9', name: 'Bob Senior' } as unknown as User,
      assignment: { id: 'assign-1', title: 'React Todo App' } as unknown as Assignment,
    } as unknown as Submission,
    {
      id: 'sub-2',
      assignmentId: 'assign-2',
      courseAllocationId: 'ca-1',
      batchId: 'batch-1',
      version: 1,
      status: SubmissionStatus.GRADED,
      submittedAt: new Date('2026-03-01T15:00:00Z'),
      isLate: false,
      marks: 85,
      gradeLabel: 'B',
      feedback: 'Good implementation, minor edge case missed',
      gradedAt: new Date('2026-03-03T10:00:00Z'),
      grader: { id: 'mentor-uuid-9', name: 'Bob Senior' } as unknown as User,
      assignment: { id: 'assign-2', title: 'Node API Microservice' } as unknown as Assignment,
    } as unknown as Submission,
  ];

  beforeEach(() => {
    mockRepository = {
      getUser: (id: string) => Promise.resolve(id === 'user-uuid-1' ? mockUser : null),
      getRoleHistory: () => Promise.resolve(mockRoleHistory),
      getBatchMemberships: () => Promise.resolve(mockBatchMembers),
      getMentorMappings: () => Promise.resolve(mockMentorMappings),
      getCourseAllocations: () => Promise.resolve(mockAllocations),
      getSubmissions: () => Promise.resolve(mockSubmissions),
    };
    service = new User360Service(mockRepository as User360Repository);
  });

  void it('HIS-01: Admin opens User 360 of a promoted mentor -> Timeline: Mentee (Jan–Jun) → Mentor (Jul–now)', async () => {
    const profile = (await service.getUser360('user-uuid-1', { tab: 'all' })) as User360Profile;

    assert.ok(profile);
    assert.equal(profile.user.name, 'Jane Doe');
    assert.equal(profile.tabs.roleHistory.length, 2);

    const menteePeriod = profile.tabs.roleHistory[0];
    assert.equal(menteePeriod?.role, UserRole.MENTEE);
    assert.equal(menteePeriod?.periodLabel, 'As Mentee: Jan 2026–Jun 2026');

    const mentorPeriod = profile.tabs.roleHistory[1];
    assert.equal(mentorPeriod?.role, UserRole.MENTOR);
    assert.equal(mentorPeriod?.periodLabel, 'As Mentor: Jul 2026–Present');
  });

  void it('HIS-02: Batch History tab -> Each batch, role, join/leave dates, reason, and period label', async () => {
    const profile = (await service.getUser360('user-uuid-1', {
      tab: 'batch-history',
    })) as User360Profile;

    assert.ok(profile.tabs.batchHistory);
    assert.equal(profile.tabs.batchHistory.length, 2);

    const alphaBatch = profile.tabs.batchHistory.find((b) => b.batchCode === 'ALPHA-2026');
    assert.ok(alphaBatch);
    assert.equal(alphaBatch?.role, 'MENTEE');
    assert.equal(alphaBatch?.reasonToLeave, 'ROLE_CHANGE');
    assert.equal(alphaBatch?.periodLabel, 'As Mentee: Jan 2026–Jun 2026');

    const betaBatch = profile.tabs.batchHistory.find((b) => b.batchCode === 'BETA-2026');
    assert.ok(betaBatch);
    assert.equal(betaBatch?.role, 'MENTOR');
    assert.equal(betaBatch?.isActive, true);
    assert.equal(betaBatch?.periodLabel, 'As Mentor: Jul 2026–Present');
  });

  void it('HIS-03: Assignment & Grade History -> All marks, grades, feedback, graders, every submission version', async () => {
    const profile = (await service.getUser360('user-uuid-1', {
      tab: 'assignment-grade-history',
    })) as User360Profile;

    assert.ok(profile.tabs.assignmentGradeHistory);
    assert.equal(profile.tabs.assignmentGradeHistory.length, 2);

    const sub1 = profile.tabs.assignmentGradeHistory[0];
    assert.equal(sub1?.assignmentTitle, 'React Todo App');
    assert.equal(sub1?.version, 1);
    assert.equal(sub1?.marks, 92);
    assert.equal(sub1?.gradeLabel, 'A');
    assert.equal(sub1?.feedback, 'Excellent work!');
    assert.equal(sub1?.graderName, 'Bob Senior');
    assert.equal(sub1?.periodLabel, 'As Mentee: Jan 2026–Jun 2026');
  });

  void it('HIS-04: Filter by "As Mentee" -> Only mentee-period records', async () => {
    const profile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      rolePeriod: UserRole.MENTEE,
    })) as User360Profile;

    assert.equal(profile.tabs.roleHistory.length, 1);
    assert.equal(profile.tabs.roleHistory[0]?.role, UserRole.MENTEE);

    assert.equal(profile.tabs.batchHistory.length, 1);
    assert.equal(profile.tabs.batchHistory[0]?.role, 'MENTEE');

    assert.equal(profile.tabs.mentorMappingHistory.length, 1);
    assert.equal(profile.tabs.mentorMappingHistory[0]?.mappedRole, 'MENTEE');

    assert.equal(profile.tabs.courseHistory.length, 1);
    assert.equal(profile.tabs.courseHistory[0]?.role, UserRole.MENTEE);

    assert.equal(profile.tabs.assignmentGradeHistory.length, 2);
    assert.equal(profile.tabs.assignmentGradeHistory[0]?.role, UserRole.MENTEE);

    // When filtered by MENTOR, mentee-only course & submission history are excluded
    const mentorProfile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      rolePeriod: UserRole.MENTOR,
    })) as User360Profile;

    assert.equal(mentorProfile.tabs.courseHistory.length, 0);
    assert.equal(mentorProfile.tabs.assignmentGradeHistory.length, 0);
    assert.equal(mentorProfile.tabs.batchHistory.length, 1);
    assert.equal(mentorProfile.tabs.batchHistory[0]?.batchCode, 'BETA-2026');
  });

  void it('HIS-05: Export CSV -> File generated with correct headers, reason, and formula escaping', async () => {
    const customRepo: Partial<User360Repository> = {
      ...mockRepository,
      getSubmissions: () =>
        Promise.resolve([
          {
            ...mockSubmissions[0],
            feedback: '=HYPERLINK("http://evil.com","Click")',
          } as Submission,
        ]),
    };
    const exportService = new User360Service(customRepo as User360Repository);
    const csv = await exportService.exportUser360Csv('user-uuid-1', { format: 'csv' });

    assert.ok(csv.includes('--- USER 360 PROFILE ---'));
    assert.ok(csv.includes('Jane Doe'));
    assert.ok(csv.includes('jane@TechEniac.com'));
    assert.ok(csv.includes('--- ROLE HISTORY ---'));
    assert.ok(csv.includes('--- BATCH HISTORY ---'));
    assert.ok(csv.includes('ALPHA-2026'));
    assert.ok(csv.includes('--- MENTOR MAPPINGS ---'));
    assert.ok(csv.includes('Reason,Status'));
    assert.ok(csv.includes('ROLE_CHANGE'));
    assert.ok(csv.includes('--- ASSIGNMENT & GRADE HISTORY ---'));
    // Formula neutralized with leading apostrophe
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.com"",""Click"")"`));
    assert.ok(csv.includes('--- PERFORMANCE SUMMARY ---'));
  });

  void it('Date range filtering includes ongoing records overlapping the requested window', async () => {
    const profile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      startDate: '2026-08-01T00:00:00Z',
    })) as User360Profile;

    // The ongoing MENTOR role started 2026-07-01 (toAt: null) is active during August
    assert.equal(profile.tabs.roleHistory.length, 1);
    assert.equal(profile.tabs.roleHistory[0]?.role, UserRole.MENTOR);

    // bm-2 joined 2026-07-02 (leftAt: null, active: true) is active during August
    assert.equal(profile.tabs.batchHistory.length, 1);
    assert.equal(profile.tabs.batchHistory[0]?.batchCode, 'BETA-2026');

    // mm-2 started 2026-07-05 (endDate: null, active: true) is active during August
    assert.equal(profile.tabs.mentorMappingHistory.length, 1);
  });

  void it('HIS-07: User with only mentor history -> Mentee tabs show empty state', async () => {
    const mentorOnlyUser = {
      ...mockUser,
      id: 'mentor-only-1',
      role: UserRole.MENTOR,
    };

    const mentorOnlyRepo: Partial<User360Repository> = {
      getUser: () => Promise.resolve(mentorOnlyUser),
      getRoleHistory: () =>
        Promise.resolve([
          {
            id: 'rh-mentor',
            userId: 'mentor-only-1',
            role: UserRole.MENTOR,
            fromAt: new Date('2026-01-01T00:00:00Z'),
            toAt: null,
            reason: 'Hired as mentor',
            changedBy: 'admin-uuid',
          } as unknown as UserRoleHistory,
        ]),
      getBatchMemberships: () =>
        Promise.resolve([
          {
            id: 'bm-m',
            batchId: 'b-1',
            userId: 'mentor-only-1',
            memberRole: BatchMemberRole.MENTOR,
            joinedAt: new Date('2026-01-01T00:00:00Z'),
            leftAt: null,
            reasonToLeave: null,
            isActive: true,
            batch: { id: 'b-1', name: 'Batch 1', code: 'B1' } as unknown as Batch,
          } as unknown as BatchMember,
        ]),
      getMentorMappings: () => Promise.resolve([]),
      getCourseAllocations: () => Promise.resolve([]),
      getSubmissions: () => Promise.resolve([]),
    };

    const mentorService = new User360Service(mentorOnlyRepo as User360Repository);
    const profile = (await mentorService.getUser360('mentor-only-1', {
      tab: 'all',
    })) as User360Profile;

    assert.deepEqual(profile.tabs.courseHistory, []);
    assert.deepEqual(profile.tabs.assignmentGradeHistory, []);
    assert.equal(profile.tabs.performanceSummary.totalAllocations, 0);
    assert.equal(profile.tabs.performanceSummary.totalSubmissions, 0);
  });

  void it('HIS-09: Audit tab filtered by auditType -> USER_ROLE, BATCH, and GRADING', async () => {
    const gradeProfile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      auditType: 'GRADING',
    })) as User360Profile;

    assert.ok(gradeProfile.tabs.audit.length > 0);
    for (const auditItem of gradeProfile.tabs.audit) {
      assert.equal(auditItem.type, 'GRADING');
      assert.equal(auditItem.action, 'ASSIGNMENT_GRADED');
    }

    const roleProfile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      auditType: 'USER_ROLE',
    })) as User360Profile;

    assert.ok(roleProfile.tabs.audit.length > 0);
    for (const auditItem of roleProfile.tabs.audit) {
      assert.equal(auditItem.type, 'USER_ROLE');
      assert.equal(auditItem.action, 'ROLE_CHANGED');
    }

    const batchProfile = (await service.getUser360('user-uuid-1', {
      tab: 'all',
      auditType: 'BATCH',
    })) as User360Profile;

    assert.ok(batchProfile.tabs.audit.length > 0);
    for (const auditItem of batchProfile.tabs.audit) {
      assert.equal(auditItem.type, 'BATCH');
    }
  });

  const tabHydrationMatrix: Array<{
    tab: User360Tab;
    expected: {
      roleHistory: boolean;
      batchMemberships: boolean;
      mentorMappings: boolean;
      courseAllocations: boolean;
      submissions: boolean;
    };
  }> = [
    {
      tab: 'profile',
      expected: {
        roleHistory: false,
        batchMemberships: false,
        mentorMappings: false,
        courseAllocations: false,
        submissions: false,
      },
    },
    {
      tab: 'all',
      expected: {
        roleHistory: true,
        batchMemberships: true,
        mentorMappings: true,
        courseAllocations: true,
        submissions: true,
      },
    },
    {
      tab: 'role-history',
      expected: {
        roleHistory: true,
        batchMemberships: false,
        mentorMappings: false,
        courseAllocations: false,
        submissions: false,
      },
    },
    {
      tab: 'batch-history',
      expected: {
        roleHistory: true,
        batchMemberships: true,
        mentorMappings: false,
        courseAllocations: false,
        submissions: false,
      },
    },
    {
      tab: 'mentor-mapping-history',
      expected: {
        roleHistory: true,
        batchMemberships: false,
        mentorMappings: true,
        courseAllocations: false,
        submissions: false,
      },
    },
    {
      tab: 'course-history',
      expected: {
        roleHistory: true,
        batchMemberships: false,
        mentorMappings: false,
        courseAllocations: true,
        submissions: false,
      },
    },
    {
      tab: 'assignment-grade-history',
      expected: {
        roleHistory: true,
        batchMemberships: false,
        mentorMappings: false,
        courseAllocations: false,
        submissions: true,
      },
    },
    {
      tab: 'performance-summary',
      expected: {
        roleHistory: true,
        batchMemberships: false,
        mentorMappings: false,
        courseAllocations: true,
        submissions: true,
      },
    },
    {
      tab: 'audit',
      expected: {
        roleHistory: true,
        batchMemberships: true,
        mentorMappings: false,
        courseAllocations: false,
        submissions: true,
      },
    },
  ];

  for (const { tab, expected } of tabHydrationMatrix) {
    void it(`Selectively hydrates repositories according to query matrix (tab=${tab})`, async () => {
      let roleHistoryQueried = false;
      let batchMembershipsQueried = false;
      let mentorMappingsQueried = false;
      let allocationsQueried = false;
      let submissionsQueried = false;

      const spyRepo = {
        ...mockRepository,
        getRoleHistory: () => {
          roleHistoryQueried = true;
          return Promise.resolve([]);
        },
        getBatchMemberships: () => {
          batchMembershipsQueried = true;
          return Promise.resolve([]);
        },
        getMentorMappings: () => {
          mentorMappingsQueried = true;
          return Promise.resolve([]);
        },
        getCourseAllocations: () => {
          allocationsQueried = true;
          return Promise.resolve([]);
        },
        getSubmissions: () => {
          submissionsQueried = true;
          return Promise.resolve([]);
        },
      };

      const spyService = new User360Service(spyRepo as unknown as User360Repository);
      const result = await spyService.getUser360('user-uuid-1', { tab });

      assert.equal(roleHistoryQueried, expected.roleHistory, `roleHistory mismatch for tab=${tab}`);
      assert.equal(
        batchMembershipsQueried,
        expected.batchMemberships,
        `batchMemberships mismatch for tab=${tab}`,
      );
      assert.equal(
        mentorMappingsQueried,
        expected.mentorMappings,
        `mentorMappings mismatch for tab=${tab}`,
      );
      assert.equal(
        allocationsQueried,
        expected.courseAllocations,
        `courseAllocations mismatch for tab=${tab}`,
      );
      assert.equal(submissionsQueried, expected.submissions, `submissions mismatch for tab=${tab}`);
      assert.equal(result.user.id, 'user-uuid-1');
    });
  }

  void it('Throws NotFoundError when user does not exist', async () => {
    await assert.rejects(
      async () => {
        await service.getUser360('non-existent-user', { tab: 'all' });
      },
      (err: unknown) => err instanceof NotFoundError,
    );
  });
});
