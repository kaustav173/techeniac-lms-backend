import type { AuthenticatedUser } from '../../core/auth';
import { ForbiddenError } from '../../core/errors';
import { BatchMemberRole, BatchRepository, batchRepository } from '../batches';
// eslint-disable-next-line architecture/cross-module-index-imports -- isolate repository import to eliminate circular barrel evaluation
import {
  type MentorMenteeRepository,
  mentorMenteeRepository,
} from '../batches/mentor-mentee.repository';
import { UserRole } from '../users';

export interface PerformanceScopeFilter {
  isSuperAdmin: boolean;
  mentorId?: string;
  allowedMenteeIds?: string[];
  scopedBatchId?: string;
}

export class PerformancePolicy {
  constructor(
    private readonly batchRepo: BatchRepository = batchRepository,
    private readonly mentorMenteeRepo: MentorMenteeRepository = mentorMenteeRepository,
  ) {}

  /**
   * Asserts whether an actor can view the performance dashboard or export performance data,
   * and returns the resolved mentor scope constraints (FR-11.2, FR-11.3, PER-03, PER-11, PER-12).
   */
  async resolvePerformanceScope(
    actor: AuthenticatedUser,
    requestedBatchId?: string,
  ): Promise<PerformanceScopeFilter> {
    const role = actor.role as UserRole;

    if (role === UserRole.SUPER_ADMIN) {
      return {
        isSuperAdmin: true,
        scopedBatchId: requestedBatchId,
      };
    }

    if (role === UserRole.MENTOR) {
      if (requestedBatchId) {
        // Verify mentor is a member of the requested batch (active or historical)
        let membership = await this.batchRepo.findActiveMemberInBatch(requestedBatchId, actor.id);
        if (!membership || membership.memberRole !== BatchMemberRole.MENTOR) {
          membership = await this.batchRepo.findMemberInBatch(requestedBatchId, actor.id);
        }

        if (!membership || membership.memberRole !== BatchMemberRole.MENTOR) {
          throw new ForbiddenError(
            'Access denied: You are not an active mentor in the specified batch',
          );
        }

        // Find mentees mapped to this mentor in this specific batch (fallback to historical if archived)
        let mappings = await this.mentorMenteeRepo.findActiveMappingsForMentor(
          actor.id,
          requestedBatchId,
        );
        if (mappings.length === 0) {
          const allBatchMappings =
            await this.mentorMenteeRepo.findAllMappingsByBatch(requestedBatchId);
          mappings = allBatchMappings.filter((m) => m.mentorId === actor.id);
        }
        const mappedMenteeIds = mappings.map((m) => m.menteeId);

        return {
          isSuperAdmin: false,
          mentorId: actor.id,
          scopedBatchId: requestedBatchId,
          allowedMenteeIds: mappedMenteeIds,
        };
      }

      // If no batchId requested, fetch all active mappings for this mentor across all batches he belongs to
      const mappings = await this.mentorMenteeRepo.findActiveMappingsForMentor(actor.id);
      const mappedMenteeIds = mappings.map((m) => m.menteeId);

      return {
        isSuperAdmin: false,
        mentorId: actor.id,
        allowedMenteeIds: mappedMenteeIds,
      };
    }

    throw new ForbiddenError(
      'Access denied: Performance metrics are restricted to Mentors and Super Admins',
    );
  }
}

export const performancePolicy = new PerformancePolicy();
