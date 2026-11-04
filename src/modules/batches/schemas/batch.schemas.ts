import { z } from 'zod';

import { BatchMemberRole, BatchStatus } from '../entities/batch.enums';

const calendarDateSchema = (fieldName: string) =>
  z
    .string({ required_error: `${fieldName} is required` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${fieldName} must be in YYYY-MM-DD format`)
    .refine((s) => {
      const d = new Date(s);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, 'Invalid calendar date');

const optionalCalendarDateSchema = (fieldName: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${fieldName} must be in YYYY-MM-DD format`)
    .refine((s) => {
      const d = new Date(s);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, 'Invalid calendar date')
    .optional();

export const createBatchSchema = z.object({
  body: z
    .object({
      name: z
        .string({ required_error: 'Batch name is required' })
        .trim()
        .min(3, 'Batch name must be at least 3 characters')
        .max(100, 'Batch name must not exceed 100 characters'),
      code: z
        .string({ required_error: 'Batch code is required' })
        .trim()
        .min(3, 'Batch code must be at least 3 characters')
        .max(20, 'Batch code must not exceed 20 characters')
        .regex(
          /^[A-Z0-9-]+$/,
          'Batch code must contain only uppercase alphanumeric characters and hyphens',
        ),
      startDate: calendarDateSchema('Start date'),
      endDate: calendarDateSchema('End date'),
      description: z
        .string()
        .max(5000, 'Description must not exceed 5000 characters')
        .optional()
        .nullable(),
    })
    .refine(
      (data) => {
        return new Date(data.startDate) <= new Date(data.endDate);
      },
      {
        message: 'Start date must be before or equal to end date',
        path: ['endDate'],
      },
    ),
});

export const getBatchByIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const updateBatchSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(3, 'Batch name must be at least 3 characters')
        .max(100, 'Batch name must not exceed 100 characters')
        .optional(),
      startDate: optionalCalendarDateSchema('Start date'),
      endDate: optionalCalendarDateSchema('End date'),
      description: z
        .string()
        .max(5000, 'Description must not exceed 5000 characters')
        .optional()
        .nullable(),
    })
    .refine(
      (data) => {
        if (data.startDate && data.endDate) {
          return new Date(data.startDate) <= new Date(data.endDate);
        }
        return true;
      },
      {
        message: 'Start date must be before or equal to end date',
        path: ['endDate'],
      },
    ),
});

export const changeBatchStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
  body: z.object({
    toStatus: z.nativeEnum(BatchStatus, {
      errorMap: () => ({ message: 'Invalid batch status' }),
    }),
    reason: z.string().max(500, 'Reason must not exceed 500 characters').optional().nullable(),
  }),
});

export const addBatchMembersSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
  body: z.object({
    userIds: z
      .array(z.string().uuid('Each user ID must be a valid UUID'))
      .min(1, 'At least one user must be specified'),
    memberRole: z.nativeEnum(BatchMemberRole, {
      errorMap: () => ({ message: 'Invalid member role' }),
    }),
  }),
});

export const removeBatchMemberSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
    userId: z.string().uuid('Invalid user ID'),
  }),
});

export const transferMenteeSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid source batch ID'),
  }),
  body: z.object({
    menteeId: z.string().uuid('Invalid mentee ID'),
    targetBatchId: z.string().uuid('Invalid target batch ID'),
    reason: z.string().max(500, 'Reason must not exceed 500 characters').optional().nullable(),
  }),
});

export const batchQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().max(100).optional(),
    status: z
      .union([z.nativeEnum(BatchStatus), z.array(z.nativeEnum(BatchStatus)), z.string()])
      .optional()
      .transform((val): BatchStatus[] | undefined => {
        if (!val) return undefined;
        if (Array.isArray(val)) {
          const valid = val.filter((s): s is BatchStatus => Object.values(BatchStatus).includes(s));
          return valid.length > 0 ? valid : undefined;
        }
        if (typeof val === 'string') {
          const parts = val.split(',').map((s) => s.trim());
          const valid = parts.filter((s): s is BatchStatus =>
            Object.values(BatchStatus).includes(s as BatchStatus),
          );
          return valid.length > 0 ? valid : undefined;
        }
        return undefined;
      }),
  }),
});

export type CreateBatchInput = z.infer<typeof createBatchSchema>['body'];
export type UpdateBatchInput = z.infer<typeof updateBatchSchema>['body'];
export type ChangeBatchStatusInput = z.infer<typeof changeBatchStatusSchema>['body'];
export type AddBatchMembersInput = z.infer<typeof addBatchMembersSchema>['body'];
export type TransferMenteeInput = z.infer<typeof transferMenteeSchema>['body'];
export type BatchQueryParams = z.infer<typeof batchQuerySchema>['query'];
