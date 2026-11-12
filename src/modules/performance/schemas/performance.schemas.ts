import { z } from 'zod';

import { CourseAllocationStatus } from '../../allocations';

export const performanceFilterSchema = z.object({
  query: z.object({
    batchId: z
      .union([
        z.string().uuid(),
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    batchIds: z
      .union([
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    mentorId: z.string().uuid({ message: 'mentorId must be a valid UUID' }).optional(),
    courseId: z
      .union([
        z.string().uuid(),
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    courseIds: z
      .union([
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    startDate: z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
    endDate: z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
    gradeRange: z.enum(['A+', 'A', 'B', 'C', 'D', 'F', 'ALL']).optional(),
    status: z
      .union([
        z.nativeEnum(CourseAllocationStatus),
        z.string().transform(
          (val) =>
            val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean) as CourseAllocationStatus[],
        ),
        z.array(z.nativeEnum(CourseAllocationStatus)),
      ])
      .optional(),
    statuses: z
      .union([
        z.string().transform(
          (val) =>
            val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean) as CourseAllocationStatus[],
        ),
        z.array(z.nativeEnum(CourseAllocationStatus)),
      ])
      .optional(),
    search: z.string().trim().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    sortBy: z
      .enum([
        'averageMarks',
        'completionPercentage',
        'onTimeRate',
        'overdueCount',
        'name',
        'batch',
        'courses',
        'grade',
      ])
      .optional()
      .default('name'),
    sortOrder: z
      .enum(['ASC', 'DESC', 'asc', 'desc'])
      .optional()
      .transform((val) => (val?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'))
      .default('DESC'),
  }),
});

export const exportPerformanceSchema = z.object({
  query: z.object({
    batchId: z
      .union([
        z.string().uuid(),
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    batchIds: z
      .union([
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    mentorId: z.string().uuid().optional(),
    courseId: z
      .union([
        z.string().uuid(),
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    courseIds: z
      .union([
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string().uuid()),
      ])
      .optional(),
    startDate: z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
    endDate: z
      .string()
      .datetime({ offset: true })
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
    gradeRange: z.enum(['A+', 'A', 'B', 'C', 'D', 'F', 'ALL']).optional(),
    status: z
      .union([
        z.nativeEnum(CourseAllocationStatus),
        z.string().transform(
          (val) =>
            val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean) as CourseAllocationStatus[],
        ),
        z.array(z.nativeEnum(CourseAllocationStatus)),
      ])
      .optional(),
    statuses: z
      .union([
        z.string().transform(
          (val) =>
            val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean) as CourseAllocationStatus[],
        ),
        z.array(z.nativeEnum(CourseAllocationStatus)),
      ])
      .optional(),
    search: z.string().trim().optional(),
    sortBy: z
      .enum([
        'averageMarks',
        'completionPercentage',
        'onTimeRate',
        'overdueCount',
        'name',
        'batch',
        'courses',
        'grade',
      ])
      .optional()
      .default('name'),
    sortOrder: z
      .enum(['ASC', 'DESC', 'asc', 'desc'])
      .optional()
      .transform((val) => (val?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'))
      .default('DESC'),
    format: z.literal('csv').default('csv'),
  }),
});

export const learningHistoryQuerySchema = z.object({
  query: z
    .object({
      batchId: z.string().uuid().optional(),
      // Note: If any user attempts to pass userId or email in query, it is ignored by design
    })
    .passthrough(),
});

export type PerformanceFilterQuery = z.infer<typeof performanceFilterSchema>['query'];
export type ExportPerformanceQuery = z.infer<typeof exportPerformanceSchema>['query'];
export type LearningHistoryQuery = z.infer<typeof learningHistoryQuerySchema>['query'];

export interface GradeDistributionBucket {
  count: number;
  percentage: number;
}

export interface PerformanceOverviewMetrics {
  averageMarks: number | null;
  gradeDistribution: Record<'A+' | 'A' | 'B' | 'C' | 'D' | 'F', GradeDistributionBucket>;
  onTimeRate: number | null;
  completionPercentage: number;
  overdueCount: number;
  totalMentees: number;
  totalSubmissions: number;
}

export interface MenteePerformanceRow {
  menteeId: string;
  menteeName: string;
  menteeEmail: string;
  batchId: string | null;
  batchName: string | null;
  assignedCoursesCount: number;
  completedCoursesCount: number;
  completionPercentage: number;
  averageMarks: number | null;
  totalSubmissions: number;
  onTimeSubmissions: number;
  onTimeRate: number;
  overdueCount: number;
  latestGrade: string | null;
}

export interface PaginatedPerformanceResult {
  metrics: PerformanceOverviewMetrics;
  mentees: MenteePerformanceRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface LearningHistoryAssignment {
  assignmentId: string;
  assignmentTitle: string;
  maxMarks: number;
  passMarks: number;
  version: number;
  submittedAt: Date;
  isLate: boolean;
  status: string;
  marks: number | null;
  gradeLabel: string | null;
  feedback: string | null;
}

export interface LearningHistoryAllocation {
  allocationId: string;
  courseId: string;
  courseTitle: string;
  progressPercent: number;
  status: string;
  startDate: Date;
  dueDate: Date;
  completedAt: Date | null;
  assignments: LearningHistoryAssignment[];
}

export interface LearningHistoryBatch {
  batchId: string;
  batchName: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
  courseAllocations: LearningHistoryAllocation[];
}

export interface LearningHistoryResult {
  user: {
    id: string;
    name: string;
    email: string;
  };
  batches: LearningHistoryBatch[];
  summary: {
    totalAllocations: number;
    completedAllocations: number;
    overallProgress: number;
    averageMarks: number | null;
  };
}
