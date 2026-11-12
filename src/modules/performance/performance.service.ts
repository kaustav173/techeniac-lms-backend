import type { AuthenticatedUser } from '../../core/auth';
import { ExportService, exportService } from './export.service';
import { PerformancePolicy, performancePolicy } from './performance.policy';
import { PerformanceRepository, performanceRepository } from './performance.repository';
import type {
  ExportPerformanceQuery,
  LearningHistoryQuery,
  LearningHistoryResult,
  MenteePerformanceRow,
  PaginatedPerformanceResult,
  PerformanceFilterQuery,
} from './schemas/performance.schemas';

export class PerformanceService {
  constructor(
    private readonly repo: PerformanceRepository = performanceRepository,
    private readonly policy: PerformancePolicy = performancePolicy,
    private readonly exportSvc: ExportService = exportService,
  ) {}

  /**
   * Retrieves aggregated metrics and paginated mentee records (FR-11.1, FR-11.2, FR-11.3, PER-01, PER-02, PER-03).
   */
  async getPerformance(
    actor: AuthenticatedUser,
    filter: PerformanceFilterQuery,
  ): Promise<PaginatedPerformanceResult> {
    const scope = await this.policy.resolvePerformanceScope(
      actor,
      filter.batchIds ?? filter.batchId,
    );

    const [metrics, { mentees, total }] = await Promise.all([
      this.repo.getPerformanceOverview(filter, scope),
      this.repo.getMenteePerformanceList(filter, scope),
    ]);

    const totalPages = Math.ceil(total / filter.limit) || 1;

    return {
      metrics,
      mentees,
      pagination: {
        page: filter.page,
        limit: filter.limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Exports filtered performance dataset to CSV (FR-11.6, PER-05).
   */
  async exportPerformance(
    actor: AuthenticatedUser,
    filter: ExportPerformanceQuery,
  ): Promise<{ csvData: string; filename: string }> {
    const scope = await this.policy.resolvePerformanceScope(
      actor,
      filter.batchIds ?? filter.batchId,
    );

    // Retrieve full filtered dataset across pages until exhausted without arbitrary truncation
    const pageSize = 1000;
    let page = 1;
    let allMentees: MenteePerformanceRow[] = [];
    let total = 0;

    do {
      const result = await this.repo.getMenteePerformanceList(
        {
          ...filter,
          page,
          limit: pageSize,
        },
        scope,
      );
      allMentees = allMentees.concat(result.mentees);
      total = result.total;
      page++;
      if (result.mentees.length === 0) break;
    } while (allMentees.length < total);

    const csvData = this.exportSvc.generatePerformanceCsv(allMentees);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `performance-report-${dateStr}.csv`;

    return { csvData, filename };
  }

  /**
   * Resolves personal learning history for the authenticated user (FR-11.4, FR-11.5, PER-04, PER-07, PER-08, PER-09, PER-10).
   * Note: The query parameter email or userId is strictly ignored; actor.id is always used.
   */
  async getLearningHistory(
    actor: AuthenticatedUser,
    query: LearningHistoryQuery,
  ): Promise<LearningHistoryResult> {
    return this.repo.getLearningHistory(actor.id, query.batchId);
  }
}

export const performanceService = new PerformanceService();
