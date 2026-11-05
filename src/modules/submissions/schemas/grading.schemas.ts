import { z } from 'zod';

import { SubmissionStatus } from '../entities/submission.enums';

export const submissionIdParamSchema = z.object({
  params: z.object({
    submissionId: z.string().uuid({ message: 'submissionId must be a valid UUID' }),
  }),
});

export const submissionQueueQuerySchema = z.object({
  query: z.object({
    status: z
      .nativeEnum(SubmissionStatus)
      .or(z.literal('ALL'))
      .optional()
      .default(SubmissionStatus.SUBMITTED),
    batchId: z.string().uuid().optional(),
    menteeId: z.string().uuid().optional(),
    courseId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
    isLate: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    search: z.string().trim().optional(),
    fromDate: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'fromDate must be a valid date' })
      .optional(),
    toDate: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'toDate must be a valid date' })
      .optional(),
    // Standard LMS sort convention and backward-compatible sort preset
    sort: z.enum(['latest', 'oldest']).optional().default('latest'),
    sortBy: z.enum(['submittedAt', 'mentee', 'name']).optional(),
    sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
  }),
});

export const gradeSubmissionSchema = submissionIdParamSchema.extend({
  body: z.object({
    marks: z
      .number({ required_error: 'Marks are required' })
      .min(0, { message: 'Marks cannot be negative' }),
    feedback: z.string().max(5000, 'Feedback cannot exceed 5000 characters').optional().nullable(),
  }),
});

export const requestResubmissionSchema = submissionIdParamSchema.extend({
  body: z.object({
    feedback: z
      .string({ required_error: 'Feedback is required when requesting resubmission' })
      .trim()
      .min(1, { message: 'Feedback comments are mandatory for resubmission request' })
      .max(5000, 'Feedback cannot exceed 5000 characters'),
  }),
});

export type SubmissionQueueQuery = z.infer<typeof submissionQueueQuerySchema>['query'];
export type GradeSubmissionInput = z.infer<typeof gradeSubmissionSchema>['body'];
export type RequestResubmissionInput = z.infer<typeof requestResubmissionSchema>['body'];
