import { z } from 'zod';

import { CourseAllocationStatus } from '../entities';

export const allocationTargetTypeSchema = z.enum([
  'BATCH',
  'SELECTED_MENTEES',
  'INDIVIDUAL_MENTEES',
]);
export type AllocationTargetType = z.infer<typeof allocationTargetTypeSchema>;

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const createAllocationsSchema = z.object({
  body: z
    .object({
      courseId: z.string().uuid('Invalid course ID'),
      targetType: allocationTargetTypeSchema,
      batchId: z.string().uuid('Invalid batch ID').optional(),
      menteeIds: z.array(z.string().uuid('Invalid mentee ID')).optional(),
      startDate: isoDateTimeSchema,
      dueDate: isoDateTimeSchema.optional(),
    })
    .refine(
      (data) => {
        if (
          (data.targetType === 'BATCH' || data.targetType === 'SELECTED_MENTEES') &&
          !data.batchId
        ) {
          return false;
        }
        return true;
      },
      {
        message: 'batchId is required for BATCH and SELECTED_MENTEES allocations',
        path: ['batchId'],
      },
    )
    .refine(
      (data) => {
        if (
          (data.targetType === 'SELECTED_MENTEES' || data.targetType === 'INDIVIDUAL_MENTEES') &&
          (!data.menteeIds || data.menteeIds.length === 0)
        ) {
          return false;
        }
        return true;
      },
      {
        message: 'menteeIds list cannot be empty for selected or individual allocations',
        path: ['menteeIds'],
      },
    )
    .refine(
      (data) => {
        if (data.dueDate && new Date(data.dueDate).getTime() < new Date(data.startDate).getTime()) {
          return false;
        }
        return true;
      },
      { message: 'Due date cannot be earlier than start date', path: ['dueDate'] },
    ),
});

export const listAllocationsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    courseId: z.string().uuid().optional(),
    batchId: z.string().uuid().optional(),
    menteeId: z.string().uuid().optional(),
    status: z
      .enum([
        CourseAllocationStatus.ASSIGNED,
        CourseAllocationStatus.IN_PROGRESS,
        CourseAllocationStatus.COMPLETED,
        CourseAllocationStatus.REVOKED,
        CourseAllocationStatus.CLOSED_ROLE_CHANGE,
        CourseAllocationStatus.CLOSED_BATCH_CHANGE,
        'OVERDUE',
      ])
      .optional(),
    dueDateFrom: z.string().optional(),
    dueDateTo: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    sortBy: z
      .enum(['course', 'mentee', 'batch', 'started', 'due', 'progress', 'status', 'createdAt'])
      .optional(),
    sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
  }),
});

export const allocationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID'),
  }),
});

export const updateAllocationDatesSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID'),
  }),
  body: z
    .object({
      startDate: isoDateTimeSchema.optional(),
      dueDate: isoDateTimeSchema.optional(),
    })
    .refine(
      (data) => {
        if (
          data.startDate &&
          data.dueDate &&
          new Date(data.dueDate).getTime() < new Date(data.startDate).getTime()
        ) {
          return false;
        }
        return true;
      },
      { message: 'Due date cannot be earlier than start date', path: ['dueDate'] },
    ),
});

export const bulkUpdateAllocationDatesSchema = z.object({
  body: z
    .object({
      allocationIds: z
        .array(z.string().uuid('Invalid allocation ID'))
        .min(1, 'At least one allocation ID is required')
        .max(200, 'Cannot exceed 200 allocations in a single bulk operation'),
      startDate: isoDateTimeSchema.optional(),
      dueDate: isoDateTimeSchema.optional(),
    })
    .refine(
      (data) => {
        if (
          data.startDate &&
          data.dueDate &&
          new Date(data.dueDate).getTime() < new Date(data.startDate).getTime()
        ) {
          return false;
        }
        return true;
      },
      { message: 'Due date cannot be earlier than start date', path: ['dueDate'] },
    ),
});

export const addMenteesToAllocationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID'),
  }),
  body: z.object({
    menteeIds: z.array(z.string().uuid()).min(1, 'At least one mentee ID is required'),
    startDate: isoDateTimeSchema.optional(),
    dueDate: isoDateTimeSchema.optional(),
  }),
});

export const revokeAllocationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID'),
  }),
});

export const assignmentDueOverrideSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid allocation ID'),
  }),
  body: z.object({
    assignmentId: z.string().uuid('Invalid assignment ID'),
    dueDate: isoDateTimeSchema,
  }),
});

export const bulkAssignmentDueOverrideSchema = z.object({
  body: z.object({
    allocationIds: z
      .array(z.string().uuid('Invalid allocation ID'))
      .min(1, 'At least one allocation ID is required')
      .max(200, 'Cannot exceed 200 allocations in a single bulk operation'),
    assignmentId: z.string().uuid('Invalid assignment ID'),
    dueDate: isoDateTimeSchema,
  }),
});

export type CreateAllocationsInput = z.infer<typeof createAllocationsSchema>['body'];
export type ListAllocationsQuery = z.infer<typeof listAllocationsQuerySchema>['query'];
export type UpdateAllocationDatesInput = z.infer<typeof updateAllocationDatesSchema>['body'];
export type BulkUpdateAllocationDatesInput = z.infer<
  typeof bulkUpdateAllocationDatesSchema
>['body'];
export type AddMenteesToAllocationInput = z.infer<typeof addMenteesToAllocationSchema>['body'];
export type AssignmentDueOverrideInput = z.infer<typeof assignmentDueOverrideSchema>['body'];
export type BulkAssignmentDueOverrideInput = z.infer<
  typeof bulkAssignmentDueOverrideSchema
>['body'];
