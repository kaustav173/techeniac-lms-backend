import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ForbiddenError } from '../../src/core/errors';
import {
  Batch,
  BatchMember,
  BatchMemberRole,
  batchRepository,
  batchService,
  BatchStatus,
  MentorMentee,
  mentorMenteeRepository,
} from '../../src/modules/batches';

void describe('Batches Mentor Scoping Unit Tests', () => {
  const mentorId = '11111111-1111-4111-a111-111111111111';
  const otherMentorId = '22222222-2222-4222-a222-222222222222';
  const batchId = '731c98a2-88dc-4de2-90bd-8689f63f64b8';

  const mockBatch = {
    id: batchId,
    name: 'Indus test mca',
    code: 'MCA001',
    status: BatchStatus.LIVE,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-12-31'),
    description: 'Test batch description',
    creator: { id: 'admin-1', name: 'Admin', email: 'admin@TechEniac.com' },
  } as unknown as Batch;

  const mockMentorMember = {
    id: 'bm-mentor-1',
    batchId,
    userId: mentorId,
    memberRole: BatchMemberRole.MENTOR,
    isActive: true,
    user: { id: mentorId, name: 'Mentor User', email: 'mentor@TechEniac.com' },
  } as unknown as BatchMember;

  const mockOtherMentorMember = {
    id: 'bm-mentor-2',
    batchId,
    userId: otherMentorId,
    memberRole: BatchMemberRole.MENTOR,
    isActive: true,
    user: { id: otherMentorId, name: 'Other Mentor', email: 'other_mentor@TechEniac.com' },
  } as unknown as BatchMember;

  const mockMenteeMember = {
    id: 'bm-mentee-1',
    batchId,
    userId: '33333333-3333-4333-a333-333333333333',
    memberRole: BatchMemberRole.MENTEE,
    isActive: true,
    user: {
      id: '33333333-3333-4333-a333-333333333333',
      name: 'Mentee User',
      email: 'mentee@TechEniac.com',
    },
  } as unknown as BatchMember;

  const mockUnmappedMenteeMember = {
    id: 'bm-mentee-2',
    batchId,
    userId: '44444444-4444-4444-a444-444444444444',
    memberRole: BatchMemberRole.MENTEE,
    isActive: true,
    user: {
      id: '44444444-4444-4444-a444-444444444444',
      name: 'Second Mentee',
      email: 'second_mentee@TechEniac.com',
    },
  } as unknown as BatchMember;

  beforeEach(() => {
    // Mock batch repository methods
    batchRepository.findById = (id: string) => {
      if (id === batchId) return Promise.resolve(mockBatch);
      return Promise.resolve(null);
    };

    batchRepository.findActiveMemberInBatch = (bId: string, uId: string) => {
      if (bId === batchId && uId === mentorId) {
        return Promise.resolve(mockMentorMember);
      }
      return Promise.resolve(null);
    };

    batchRepository.findMembersByBatchId = (bId: string) => {
      if (bId === batchId) {
        return Promise.resolve([
          mockMentorMember,
          mockOtherMentorMember,
          mockMenteeMember,
          mockUnmappedMenteeMember,
        ]);
      }
      return Promise.resolve([]);
    };

    batchRepository.getStatusHistory = () => Promise.resolve([]);
    mentorMenteeRepository.findActiveMappingsByBatch = () =>
      Promise.resolve([
        Object.assign(new MentorMentee(), {
          id: 'mm-1',
          batchId,
          mentorId,
          menteeId: '33333333-3333-4333-a333-333333333333',
          isActive: true,
          mentor: { id: mentorId, name: 'Mentor User' },
        }),
        Object.assign(new MentorMentee(), {
          id: 'mm-2',
          batchId,
          mentorId: otherMentorId,
          menteeId: '44444444-4444-4444-a444-444444444444',
          isActive: true,
          mentor: { id: otherMentorId, name: 'Other Mentor' },
        }),
      ]);
    mentorMenteeRepository.findActiveMappingsForMentor = () =>
      Promise.resolve([
        Object.assign(new MentorMentee(), {
          id: 'mm-1',
          batchId,
          mentorId,
          menteeId: '33333333-3333-4333-a333-333333333333',
          isActive: true,
        }),
      ]);
  });

  void it('allows mentor to retrieve batch details when mentor is an active member in batch', async () => {
    const result = await batchService.getBatchByIdForMentor(batchId, mentorId);

    assert.ok(result);
    assert.equal(result.batch.id, batchId);
    assert.equal(result.mentors.length, 1);
    assert.equal(result.mentors[0]?.userId, mentorId);
    assert.equal(result.mentors[0]?.user?.id, mentorId);
    assert.equal(result.mentees.length, 2);
    assert.equal(result.mentees[0]?.user?.id, '33333333-3333-4333-a333-333333333333');
    assert.equal(result.mentees[0]?.user?.name, 'Mentee User');
    assert.deepEqual(result.mentees[0]?.mappedToUser, { id: mentorId, name: 'Mentor User' });
    assert.equal(result.mentees[1]?.user?.id, '44444444-4444-4444-a444-444444444444');
    assert.equal(result.mentees[1]?.user?.name, 'Second Mentee');
    assert.equal(result.mentees[1]?.mappedToUser, null);
  });

  void it('denies mentor access with ForbiddenError when mentor is not a member of the batch', async () => {
    await assert.rejects(
      async () => {
        await batchService.getBatchByIdForMentor(batchId, otherMentorId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(
          err.message,
          /Operation denied: mentor is not within required batch\/mentee scope/i,
        );
        return true;
      },
    );
  });

  void it('denies mentor access with ForbiddenError when batch is ARCHIVED', async () => {
    batchRepository.findById = (id: string) => {
      if (id === batchId) {
        return Promise.resolve({ ...mockBatch, status: BatchStatus.ARCHIVED });
      }
      return Promise.resolve(null);
    };

    await assert.rejects(
      async () => {
        await batchService.getBatchByIdForMentor(batchId, mentorId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(
          err.message,
          /Operation denied: mentors cannot access archived or completed batches/i,
        );
        return true;
      },
    );
  });

  void it('denies mentor access with ForbiddenError when batch is COMPLETED', async () => {
    batchRepository.findById = (id: string) => {
      if (id === batchId) {
        return Promise.resolve({ ...mockBatch, status: BatchStatus.COMPLETED });
      }
      return Promise.resolve(null);
    };

    await assert.rejects(
      async () => {
        await batchService.getBatchByIdForMentor(batchId, mentorId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(
          err.message,
          /Operation denied: mentors cannot access archived or completed batches/i,
        );
        return true;
      },
    );
  });
});
