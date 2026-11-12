import { z } from 'zod';

import { CourseAllocationStatus } from '../../allocations';

const createDelimitedFilterSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
  maxItems = 20,
  maxMessage = 'At most 20 values may be filtered at once',
) =>
  z
    .union([
      itemSchema,
      z
        .union([
          z.string().transform((val) =>
            val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
          z.array(z.string()),
        ])
        .pipe(z.array(itemSchema).max(maxItems, maxMessage)),
    ])
    .optional();

export const performanceFilterSchema = z.object({
  query: z.object({
    batchId: createDelimitedFilterSchema(
      z.string().uuid('batchId must be a valid UUID'),
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    batchIds: createDelimitedFilterSchema(
      z.string().uuid('batchIds must contain valid UUIDs'),
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    mentorId: z.string().uuid({ message: 'mentorId must be a valid UUID' }).optional(),
    courseId: createDelimitedFilterSchema(
      z.string().uuid('courseId must be a valid UUID'),
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    courseIds: createDelimitedFilterSchema(
      z.string().uuid('courseIds must contain valid UUIDs'),
      20,
      'At most 20 course IDs may be filtered at once',
    ),
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
    status: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      20,
      'At most 20 statuses may be filtered at once',
    ),
    statuses: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
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
      z.string().uuid('batchId must be a valid UUID'),
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    batchIds: createDelimitedFilterSchema(
      z.string().uuid('batchIds must contain valid UUIDs'),
      20,
      'At most 20 batch IDs may be filtered at once',
    ),
    mentorId: z.string().uuid().optional(),
    courseId: createDelimitedFilterSchema(
      z.string().uuid('courseId must be a valid UUID'),
      20,
      'At most 20 course IDs may be filtered at once',
    ),
    courseIds: createDelimitedFilterSchema(
      z.string().uuid('courseIds must contain valid UUIDs'),
      20,
      'At most 20 course IDs may be filtered at once',
    ),
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
    status: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
      20,
      'At most 20 statuses may be filtered at once',
    ),
    statuses: createDelimitedFilterSchema(
      z.nativeEnum(CourseAllocationStatus),
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
      batchId: z.string().uuid().optional(),
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
