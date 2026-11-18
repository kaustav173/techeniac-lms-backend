import { z } from 'zod';

// eslint-disable-next-line architecture/cross-module-index-imports -- Zod 4 reads enum values during schema initialization, so avoid the allocations barrel cycle.
import { CourseAllocationStatus } from '../../allocations/entities/allocation.enums';

const createDelimitedFilterSchema = <T extends z.ZodType<string, string>>(
  itemSchema: T,
  invalidMessage: string,
  maxItems = 20,
  maxMessage = 'At most 20 values may be filtered at once',
) => {
  const listSchema = z.array(itemSchema).max(maxItems, maxMessage);

  return z
    .transform((input, ctx) => {
      if (typeof input === 'string') {
        const single = itemSchema.safeParse(input);
        if (single.success) return single.data;
      }

      const values =
        typeof input === 'string'
          ? input
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : input;
      const list = listSchema.safeParse(values);
      if (list.success) return list.data;

      const exceedsLimit = list.error.issues.some(
        (issue) => issue.code === 'too_big' && issue.origin === 'array',
      );
      ctx.issues.push({
        code: 'custom',
        input,
        message: exceedsLimit ? maxMessage : invalidMessage,
      });
      return z.NEVER;
    })
    .optional();
};

const performanceDateFilterSchema = z
  .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)], {
    error: 'Invalid datetime',
  })
  .optional();

export const performanceFilterSchema = z.object({
  query: z.object({
    batchId: createDelimitedFilterSchema(
      z.string().guid(),
      'batchId must be a valid UUID',
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    batchIds: createDelimitedFilterSchema(
      z.string().guid(),
      'batchIds must contain valid UUIDs',
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    mentorId: z.string().guid({ message: 'mentorId must be a valid UUID' }).optional(),
    courseId: createDelimitedFilterSchema(
      z.string().guid(),
      'courseId must be a valid UUID',
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    courseIds: createDelimitedFilterSchema(
      z.string().guid(),
      'courseIds must contain valid UUIDs',
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    startDate: performanceDateFilterSchema,
    endDate: performanceDateFilterSchema,
    status: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      'status must be a valid allocation status',
      20,
      'At most 20 statuses may be filtered at once',
    ),
    statuses: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      'statuses must contain valid allocation statuses',
      20,
      'At most 20 statuses may be filtered at once',
    ),
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
    batchId: createDelimitedFilterSchema(
      z.string().guid(),
      'batchId must be a valid UUID',
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    batchIds: createDelimitedFilterSchema(
      z.string().guid(),
      'batchIds must contain valid UUIDs',
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    mentorId: z.string().guid('Invalid uuid').optional(),
    courseId: createDelimitedFilterSchema(
      z.string().guid(),
      'courseId must be a valid UUID',
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    courseIds: createDelimitedFilterSchema(
      z.string().guid(),
      'courseIds must contain valid UUIDs',
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    startDate: performanceDateFilterSchema,
    endDate: performanceDateFilterSchema,
    status: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      'status must be a valid allocation status',
      20,
      'At most 20 statuses may be filtered at once',
    ),
    statuses: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      'statuses must contain valid allocation statuses',
      20,
      'At most 20 statuses may be filtered at once',
    ),
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
      batchId: z.string().guid('Invalid uuid').optional(),
      // Note: If any user attempts to pass userId or email in query, it is ignored by design
    })
    .passthrough(),
});

export type PerformanceFilterQuery = z.infer<typeof performanceFilterSchema>['query'];
export type ExportPerformanceQuery = z.infer<typeof exportPerformanceSchema>['query'];
export type LearningHistoryQuery = z.infer<typeof learningHistoryQuerySchema>['query'];

export interface PerformanceOverviewMetrics {
  averageMarks: number | null;
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
