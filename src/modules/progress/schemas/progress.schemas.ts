import { z } from 'zod';

// eslint-disable-next-line architecture/cross-module-index-imports -- import enum directly to prevent circular barrel initialization between allocations and progress
import { CourseAllocationStatus } from '../../allocations/entities/allocation.enums';
import { TopicProgressStatus } from '../entities/progress.enums';

export const topicProgressStatusSchema = z.nativeEnum(TopicProgressStatus);

export const updateTopicStatusSchema = z.object({
  status: topicProgressStatusSchema,
  note: z.string().trim().max(1000).nullable().optional(),
});

export const updateTopicDeadlineSchema = z.object({
  deadline: z.string().datetime({ message: 'Deadline must be a valid ISO 8601 datetime' }),
});

export const allocationStatusOrOverdueSchema = z.union([
  z.nativeEnum(CourseAllocationStatus),
  z.literal('OVERDUE'),
]);

const commaSeparatedUuidsSchema = z
  .union([
    z.string().transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    z.array(z.string()),
  ])
  .pipe(z.array(z.string().uuid('Invalid UUID format')))
  .optional();

const commaSeparatedStatusesSchema = z
  .union([
    z.string().transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    z.array(z.string()),
  ])
  .pipe(z.array(allocationStatusOrOverdueSchema))
  .optional();

export const trackerQuerySchema = z.object({
  batchId: z.string().uuid().optional(),
  batchIds: commaSeparatedUuidsSchema,
  menteeId: z.string().uuid().optional(),
  menteeIds: commaSeparatedUuidsSchema,
  courseId: z.string().uuid().optional(),
  courseIds: commaSeparatedUuidsSchema,
  status: allocationStatusOrOverdueSchema.optional(),
  statuses: commaSeparatedStatusesSchema,
  isOverdue: z.coerce.boolean().optional(),
  sortField: z.enum(['menteeName', 'createdAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional().default('desc'),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

// HTTP Route Validation Schemas (used with validate() middleware)
export const getTopicProgressRouteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID format'),
  }),
});

export const updateTopicStatusRouteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID format'),
    topicId: z.string().uuid('Invalid topic ID format'),
  }),
  body: updateTopicStatusSchema,
});

export const updateTopicDeadlineRouteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID format'),
    topicId: z.string().uuid('Invalid topic ID format'),
  }),
  body: updateTopicDeadlineSchema,
});

export const getProgressTrackerRouteSchema = z.object({
  query: trackerQuerySchema,
});

export type UpdateTopicStatusInput = z.infer<typeof updateTopicStatusSchema>;
export type UpdateTopicDeadlineInput = z.infer<typeof updateTopicDeadlineSchema>;
export type TrackerQueryInput = z.infer<typeof trackerQuerySchema>;
