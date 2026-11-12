import type { AuthenticatedUser } from '../../core/auth';
import { ForbiddenError } from '../../core/errors';
import {
  BatchMemberRole,
  BatchRepository,
  batchRepository,
  type MentorMenteeRepository,
  mentorMenteeRepository,
} from '../batches';
import { UserRole } from '../users';

export interface PerformanceScopeFilter {
  isSuperAdmin: boolean;
  mentorId?: string;
  allowedMenteeIds?: string[];
  scopedBatchId?: string;
  scopedBatchIds?: string[];
}

export class PerformancePolicy {
  private readonly _batchRepo?: BatchRepository;
  private readonly _mentorMenteeRepo?: MentorMenteeRepository;

  constructor(batchRepo?: BatchRepository, mentorMenteeRepo?: MentorMenteeRepository) {
    this._batchRepo = batchRepo;
    this._mentorMenteeRepo = mentorMenteeRepo;
  }

  private get batchRepo(): BatchRepository {
    return this._batchRepo ?? batchRepository;
  }

  private get mentorMenteeRepo(): MentorMenteeRepository {
    return this._mentorMenteeRepo ?? mentorMenteeRepository;
  }

  /**
   * Asserts whether an actor can view the performance dashboard or export performance data,
   * and returns the resolved mentor scope constraints (FR-11.2, FR-11.3, PER-03, PER-11, PER-12).
   */
  async resolvePerformanceScope(
    actor: AuthenticatedUser,
    requestedBatchId?: string | string[],
  ): Promise<PerformanceScopeFilter> {
    const role = actor.role as UserRole;
    const requestedBatchIds = Array.isArray(requestedBatchId)
      ? requestedBatchId
      : requestedBatchId
        ? requestedBatchId
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    if (role === UserRole.SUPER_ADMIN) {
      return {
        isSuperAdmin: true,
        scopedBatchId: requestedBatchIds[0],
        scopedBatchIds: requestedBatchIds.length > 0 ? requestedBatchIds : undefined,
      };
    }

    if (role === UserRole.MENTOR) {
      if (requestedBatchIds.length > 0) {
        const menteeIdArrays = await Promise.all(
          requestedBatchIds.map(async (bId) => {
            let membership = await this.batchRepo.findActiveMemberInBatch(bId, actor.id);
            if (!membership || membership.memberRole !== BatchMemberRole.MENTOR) {
              membership = await this.batchRepo.findMemberInBatch(bId, actor.id);
            }

            if (!membership || membership.memberRole !== BatchMemberRole.MENTOR) {
              throw new ForbiddenError(
                'Access denied: You are not an active mentor in the specified batch',
              );
            }

            let mappings = await this.mentorMenteeRepo.findActiveMappingsForMentor(actor.id, bId);
            if (mappings.length === 0) {
              const allBatchMappings = await this.mentorMenteeRepo.findAllMappingsByBatch(bId);
              mappings = allBatchMappings.filter((m) => m.mentorId === actor.id);
            }
            return mappings.map((m) => m.menteeId);
          }),
        );

        const allowedMenteeIds = menteeIdArrays.flat();

        return {
          isSuperAdmin: false,
          mentorId: actor.id,
          scopedBatchId: requestedBatchIds[0],
          scopedBatchIds: requestedBatchIds,
          allowedMenteeIds: [...new Set(allowedMenteeIds)],
        };
      }

      // If no batchId requested, fetch all active mappings for this mentor across all batches he belongs to
      const mappings = await this.mentorMenteeRepo.findActiveMappingsForMentor(actor.id);
      const mappedMenteeIds = mappings.map((m) => m.menteeId);

      return {
        isSuperAdmin: false,
        mentorId: actor.id,
        allowedMenteeIds: [...new Set(mappedMenteeIds)],
      };
    }

    throw new ForbiddenError(
      'Access denied: Performance metrics are restricted to Mentors and Super Admins',
    );
  }
}

export const performancePolicy = new PerformancePolicy();
