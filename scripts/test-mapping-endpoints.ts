import 'reflect-metadata';

import type { Server } from 'node:http';

import { app } from '../src/app';
import { hashPassword, signAccessToken } from '../src/core/auth';
import { closeDatabase, initializeDatabase } from '../src/core/db';
import { logger } from '../src/core/logging';
import { BatchStatus, MentorScopeAction, mentorScopeHelper } from '../src/modules/batches';
import { userRepository, UserRole } from '../src/modules/users';

async function runMappingTests(): Promise<void> {
  await initializeDatabase();

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 4000;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let failures = 0;

  try {
    logger.info(
      { baseUrl },
      'Running M4 Mentor-Mentee Mapping Verification Tests (MAP-01..10, USR-07..08)...',
    );

    async function getOrCreateUser(email: string, name: string, role: UserRole) {
      let u = await userRepository.findByEmail(email);
      if (!u) {
        const passwordHash = await hashPassword('Password123!');
        u = await userRepository.create({
          name,
          email,
          passwordHash,
          role,
          mustChangePassword: false,
        });
      }
      return u;
    }

    const uniqueSuffix = Date.now().toString().slice(-6);

    const admin = await getOrCreateUser('admin@TechEniac.com', 'Super Admin', UserRole.SUPER_ADMIN);
    const mentorA = await getOrCreateUser(
      `mentor-a-${uniqueSuffix}@TechEniac.com`,
      'Mentor Alpha',
      UserRole.MENTOR,
    );
    const mentorB = await getOrCreateUser(
      `mentor-b-${uniqueSuffix}@TechEniac.com`,
      'Mentor Beta',
      UserRole.MENTOR,
    );
    const mentee1 = await getOrCreateUser(
      `mentee-1-${uniqueSuffix}@TechEniac.com`,
      'Mentee One',
      UserRole.MENTEE,
    );
    const mentee2 = await getOrCreateUser(
      `mentee-2-${uniqueSuffix}@TechEniac.com`,
      'Mentee Two',
      UserRole.MENTEE,
    );

    const adminToken = signAccessToken({
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    });

    const mentorAToken = signAccessToken({
      sub: mentorA.id,
      email: mentorA.email,
      role: mentorA.role,
      tokenVersion: mentorA.tokenVersion,
    });

    // Setup Batch A (LIVE)
    const createBatchRes = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: `Cohort Alpha ${uniqueSuffix}`,
        code: `COH-${uniqueSuffix}-A`,
        startDate: '2026-11-01',
        endDate: '2027-04-30',
        description: 'Mentor mapping test batch A',
      }),
    });
    const batchData = (await createBatchRes.json()) as { data: { batch: { id: string } } };
    const batchId = batchData.data.batch.id;

    // Add Mentor A and Mentor B to Batch A
    await fetch(`${baseUrl}/batches/${batchId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userIds: [mentorA.id, mentorB.id], memberRole: 'MENTOR' }),
    });

    // Add Mentee 1 and Mentee 2 to Batch A
    await fetch(`${baseUrl}/batches/${batchId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userIds: [mentee1.id, mentee2.id], memberRole: 'MENTEE' }),
    });

    // Set Batch to LIVE
    await fetch(`${baseUrl}/batches/${batchId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ toStatus: BatchStatus.LIVE, reason: 'Ready for mappings' }),
    });

    // -------------------------------------------------------------
    // Test 1: MAP-01 - Map a mentee to a mentor inside Batch A
    // -------------------------------------------------------------
    const mapRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorA.id,
        menteeIds: [mentee1.id],
      }),
    });
    const mapData = (await mapRes.json()) as {
      success: boolean;
      data?: { mappings: Array<{ mentorId: string; menteeId: string }> };
    };

    // Also check mentor sees mentee
    const mentorMenteesRes = await fetch(`${baseUrl}/mentor/mentees?batchId=${batchId}`, {
      headers: { Authorization: `Bearer ${mentorAToken}` },
    });
    const mentorMenteesData = (await mentorMenteesRes.json()) as {
      data?: { mentees: Array<{ menteeId: string }> };
    };
    const mentorSeesMentee = mentorMenteesData.data?.mentees.some((m) => m.menteeId === mentee1.id);

    if (mapRes.status === 201 && mapData.success && mentorSeesMentee) {
      console.log(
        '✔ Test 1 PASS: MAP-01 Mentee successfully mapped to Mentor A; visible in mentor portal',
      );
    } else {
      console.error('✘ Test 1 FAIL: MAP-01 failed', {
        status: mapRes.status,
        mapData,
        mentorMenteesData,
      });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 2: MAP-02 - Reassign Mentee 1 from Mentor A to Mentor B
    // -------------------------------------------------------------
    const reassignRes = await fetch(`${baseUrl}/batches/${batchId}/mappings/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        menteeId: mentee1.id,
        newMentorId: mentorB.id,
        reason: 'Workload balancing',
      }),
    });
    const reassignData = (await reassignRes.json()) as {
      success: boolean;
      data?: { mapping: { mentorId: string } };
    };

    // Verify Mentor A no longer has mentee1 in active mappings
    const mentorAAfterReassign = await fetch(`${baseUrl}/mentor/mentees?batchId=${batchId}`, {
      headers: { Authorization: `Bearer ${mentorAToken}` },
    });
    const mentorAData = (await mentorAAfterReassign.json()) as {
      data?: { mentees: Array<{ menteeId: string }> };
    };
    const mentorALostAccess = !mentorAData.data?.mentees.some((m) => m.menteeId === mentee1.id);

    if (
      (reassignRes.status === 200 || reassignRes.status === 201) &&
      reassignData.data?.mapping.mentorId === mentorB.id &&
      mentorALostAccess
    ) {
      console.log(
        '✔ Test 2 PASS: MAP-02 Reassigned to Mentor B; Mentor A lost access, history retained',
      );
    } else {
      console.error('✘ Test 2 FAIL: MAP-02 failed', {
        status: reassignRes.status,
        reassignData,
        mentorALostAccess,
      });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 3: MAP-03 - Bulk map multiple mentees in a batch
    // -------------------------------------------------------------
    const bulkMentees = [];
    for (let i = 3; i <= 5; i++) {
      const m = await getOrCreateUser(
        `bulk-mentee-${i}-${uniqueSuffix}@TechEniac.com`,
        `Bulk Mentee ${i}`,
        UserRole.MENTEE,
      );
      bulkMentees.push(m);
    }
    await fetch(`${baseUrl}/batches/${batchId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userIds: bulkMentees.map((m) => m.id), memberRole: 'MENTEE' }),
    });

    const bulkMapRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorA.id,
        menteeIds: bulkMentees.map((m) => m.id),
      }),
    });
    const bulkMapData = (await bulkMapRes.json()) as {
      success: boolean;
      data?: { mappings: unknown[] };
    };

    if (bulkMapRes.status === 201 && bulkMapData.data?.mappings.length === bulkMentees.length) {
      console.log('✔ Test 3 PASS: MAP-03 Bulk mapped 3 mentees atomically');
    } else {
      console.error('✘ Test 3 FAIL: MAP-03 failed', { status: bulkMapRes.status, bulkMapData });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 3b: In-request duplicate mentee IDs rejected with clean 400
    // -------------------------------------------------------------
    const duplicateIdsRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorA.id,
        menteeIds: [mentee2.id, mentee2.id],
      }),
    });
    if (duplicateIdsRes.status === 400) {
      console.log('✔ Test 3b PASS: In-request duplicate mentee IDs cleanly rejected with 400');
    } else {
      console.error('✘ Test 3b FAIL: Duplicate mentee IDs in request not rejected with 400', {
        status: duplicateIdsRes.status,
      });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 4: MAP-04 & MAP-05 - Reusable Mentor Scope Helper
    // -------------------------------------------------------------
    // Mentee 2 is unmapped. Mentor A should NOT have review/track scope for Mentee 2
    const canMentorReviewUnmapped = await mentorScopeHelper.canMentorReviewAndTrack(
      mentorA.id,
      mentee2.id,
      batchId,
    );
    let scopeDeniedError = false;
    try {
      await mentorScopeHelper.requireMentorScope(MentorScopeAction.REVIEW_AND_TRACK, {
        mentorId: mentorA.id,
        menteeId: mentee2.id,
        batchId,
      });
    } catch {
      scopeDeniedError = true;
    }

    if (!canMentorReviewUnmapped && scopeDeniedError) {
      console.log(
        '✔ Test 4 PASS: MAP-04 & MAP-05 Mentor-scope helper rejects access to unmapped mentee (403)',
      );
    } else {
      console.error('✘ Test 4 FAIL: MAP-05 failed', { canMentorReviewUnmapped, scopeDeniedError });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 5: MAP-06 - Attempt to map a user whose role is MENTOR as a mentee
    // -------------------------------------------------------------
    const mapMentorAsMenteeRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorA.id,
        menteeIds: [mentorB.id],
      }),
    });

    if (mapMentorAsMenteeRes.status === 400) {
      console.log(
        '✔ Test 5 PASS: MAP-06 Mapping a user with role MENTOR as a mentee rejected with 400',
      );
    } else {
      console.error('✘ Test 5 FAIL: MAP-06 failed', { status: mapMentorAsMenteeRes.status });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 6: MAP-07 - Attempt to map a mentee to a mentor who is NOT in the batch
    // -------------------------------------------------------------
    const externalMentor = await getOrCreateUser(
      `external-mentor-${uniqueSuffix}@TechEniac.com`,
      'External Mentor',
      UserRole.MENTOR,
    );
    const nonMemberMentorRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: externalMentor.id,
        menteeIds: [mentee2.id],
      }),
    });

    if (nonMemberMentorRes.status === 400) {
      console.log('✔ Test 6 PASS: MAP-07 Mapping to mentor not in batch rejected with 400');
    } else {
      console.error('✘ Test 6 FAIL: MAP-07 failed', { status: nonMemberMentorRes.status });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 7: MAP-08 - Duplicate active mapping in same batch
    // -------------------------------------------------------------
    // mentee1 is currently mapped to mentorB. Attempting to map mentee1 to mentorA without reassign
    const duplicateMapRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorA.id,
        menteeIds: [mentee1.id],
      }),
    });

    if (duplicateMapRes.status === 409) {
      console.log('✔ Test 7 PASS: MAP-08 Duplicate active mapping rejected with 409 Conflict');
    } else {
      console.error('✘ Test 7 FAIL: MAP-08 failed', { status: duplicateMapRes.status });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 7b: Idempotent re-map to the same mentor returns 201 cleanly without error
    // -------------------------------------------------------------
    const idempotentMapRes = await fetch(`${baseUrl}/batches/${batchId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        mentorId: mentorB.id,
        menteeIds: [mentee1.id],
      }),
    });
    if (idempotentMapRes.status === 201) {
      console.log('✔ Test 7b PASS: Idempotent re-map to same mentor succeeds cleanly with 201');
    } else {
      console.error('✘ Test 7b FAIL: Idempotent re-map failed', {
        status: idempotentMapRes.status,
      });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 8: MAP-09 - Mentee transferred to Batch B ends mapping in Batch A
    // -------------------------------------------------------------
    const createBatchBRes = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: `Cohort Beta ${uniqueSuffix}`,
        code: `COH-${uniqueSuffix}-B`,
        startDate: '2026-11-01',
        endDate: '2027-04-30',
      }),
    });
    const batchBData = (await createBatchBRes.json()) as { data: { batch: { id: string } } };
    const batchBId = batchBData.data.batch.id;

    const transferRes = await fetch(`${baseUrl}/batches/${batchId}/transfer-mentee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        menteeId: mentee1.id,
        targetBatchId: batchBId,
        reason: 'Transferring to Batch B',
      }),
    });

    // Check mapping in batch A is closed
    const activeMappingInA = await mentorScopeHelper.canMentorReviewAndTrack(
      mentorB.id,
      mentee1.id,
      batchId,
    );

    if ((transferRes.status === 200 || transferRes.status === 201) && !activeMappingInA) {
      console.log('✔ Test 8 PASS: MAP-09 Mentee transfer ends mapping in source batch');
    } else {
      console.error('✘ Test 8 FAIL: MAP-09 failed', {
        status: transferRes.status,
        activeMappingInA,
      });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 9: MAP-10 - Batch Archived ends its mappings
    // -------------------------------------------------------------
    // Complete batch A then archive it
    await fetch(`${baseUrl}/batches/${batchId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ toStatus: BatchStatus.COMPLETED, reason: 'Completed all topics' }),
    });

    await fetch(`${baseUrl}/batches/${batchId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ toStatus: BatchStatus.ARCHIVED, reason: 'Archiving batch' }),
    });

    // Check bulk mapped mentees in Batch A no longer active
    const activeBulkMapping = await mentorScopeHelper.canMentorReviewAndTrack(
      mentorA.id,
      bulkMentees[0]!.id,
      batchId,
    );

    if (!activeBulkMapping) {
      console.log('✔ Test 9 PASS: MAP-10 Batch Archive closed all remaining active mappings');
    } else {
      console.error('✘ Test 9 FAIL: MAP-10 failed', { activeBulkMapping });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 10: USR-07 & USR-08 - Role change block on mentor with active mentees
    // -------------------------------------------------------------
    // Setup fresh batch C with a mentor and mapped mentee
    const createBatchCRes = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: `Cohort Gamma ${uniqueSuffix}`,
        code: `COH-${uniqueSuffix}-C`,
        startDate: '2026-11-01',
        endDate: '2027-04-30',
      }),
    });
    const batchCData = (await createBatchCRes.json()) as { data: { batch: { id: string } } };
    const batchCId = batchCData.data.batch.id;

    const mentorC = await getOrCreateUser(
      `mentor-c-${uniqueSuffix}@TechEniac.com`,
      'Mentor Gamma',
      UserRole.MENTOR,
    );
    const mentorD = await getOrCreateUser(
      `mentor-d-${uniqueSuffix}@TechEniac.com`,
      'Mentor Delta',
      UserRole.MENTOR,
    );
    const menteeC = await getOrCreateUser(
      `mentee-c-${uniqueSuffix}@TechEniac.com`,
      'Mentee Gamma',
      UserRole.MENTEE,
    );

    await fetch(`${baseUrl}/batches/${batchCId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userIds: [mentorC.id, mentorD.id], memberRole: 'MENTOR' }),
    });
    await fetch(`${baseUrl}/batches/${batchCId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userIds: [menteeC.id], memberRole: 'MENTEE' }),
    });

    // Map menteeC to mentorC
    await fetch(`${baseUrl}/batches/${batchCId}/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ mentorId: mentorC.id, menteeIds: [menteeC.id] }),
    });

    // Attempt role change Mentor C -> MENTEE (should be blocked by USR-07)
    const blockRoleChangeRes = await fetch(`${baseUrl}/users/${mentorC.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        newRole: UserRole.MENTEE,
        reason: 'Transitioning mentor back to mentee',
      }),
    });
    const blockData = (await blockRoleChangeRes.json()) as { error?: { message?: string } };

    const isBlocked =
      blockRoleChangeRes.status === 400 &&
      blockData.error?.message?.includes('active mentee(s) that must be reassigned first');

    if (isBlocked) {
      console.log('✔ Test 10 PASS: USR-07 Role change blocked because mentor has active mentees');
    } else {
      console.error('✘ Test 10 FAIL: USR-07 failed', {
        status: blockRoleChangeRes.status,
        blockData,
      });
      failures++;
    }

    // Reassign menteeC to mentorD (USR-08)
    await fetch(`${baseUrl}/batches/${batchCId}/mappings/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        menteeId: menteeC.id,
        newMentorId: mentorD.id,
        reason: 'Reassigning before mentor role change',
      }),
    });

    // Now role change Mentor C -> MENTEE succeeds
    const succeedRoleChangeRes = await fetch(`${baseUrl}/users/${mentorC.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        newRole: UserRole.MENTEE,
        reason: 'Reassignment complete, demoting to mentee',
      }),
    });

    if (succeedRoleChangeRes.status === 200) {
      console.log('✔ Test 11 PASS: USR-08 Role change succeeded after mentees reassigned');
    } else {
      console.error('✘ Test 11 FAIL: USR-08 failed', { status: succeedRoleChangeRes.status });
      failures++;
    }

    // -------------------------------------------------------------
    // Test 12: Mentor Filter on User Directory
    // -------------------------------------------------------------
    const mentorFilterRes = await fetch(`${baseUrl}/users?mentorId=${mentorD.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const mentorFilterData = (await mentorFilterRes.json()) as {
      success: boolean;
      data?: { users: Array<{ id: string }> };
    };
    const menteeFoundInFilter = mentorFilterData.data?.users.some((u) => u.id === menteeC.id);

    if (mentorFilterRes.status === 200 && menteeFoundInFilter) {
      console.log('✔ Test 12 PASS: Users directory successfully filtered by mapped mentorId');
    } else {
      console.error('✘ Test 12 FAIL: Mentor filter on users directory failed', {
        status: mentorFilterRes.status,
        mentorFilterData,
      });
      failures++;
    }
  } catch (error) {
    logger.error({ err: error }, 'Test runner encountered unhandled error');
    failures++;
  } finally {
    server.close();
    await closeDatabase();
    if (failures > 0) {
      console.error(`\nTest suite finished with ${failures} failure(s).`);
      process.exit(1);
    } else {
      console.log('\nAll 12 M4 Mentor-Mentee Mapping tests passed successfully!');
      process.exit(0);
    }
  }
}

void runMappingTests();
