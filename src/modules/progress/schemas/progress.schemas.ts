import { z } from 'zod';

import { TopicProgressStatus } from '../entities/progress.enums';

export const topicProgressStatusSchema = z.nativeEnum(TopicProgressStatus);

export const updateTopicStatusSchema = z.object({
  status: topicProgressStatusSchema,
  note: z.string().trim().max(1000).nullable().optional(),
});

export const updateTopicDeadlineSchema = z.object({
  deadline: z.string().datetime({ message: 'Deadline must be a valid ISO 8601 datetime' }),
});

export const trackerQuerySchema = z.object({
  batchId: z.string().uuid().optional(),
  menteeId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
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
