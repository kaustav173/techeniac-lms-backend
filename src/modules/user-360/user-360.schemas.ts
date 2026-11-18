import { z } from 'zod';

import { UserRole } from '../users';

export const user360TabEnum = z.enum([
  'all',
  'profile',
  'role-history',
  'batch-history',
  'mentor-mapping-history',
  'course-history',
  'assignment-grade-history',
  'performance-summary',
  'audit',
]);

export type User360Tab = z.infer<typeof user360TabEnum>;

export const auditTypeEnum = z.enum(['USER_ROLE', 'BATCH', 'GRADING']);
export type AuditType = z.infer<typeof auditTypeEnum>;

const isoDateFilterSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a valid ISO date string')
  .optional();

export const user360QuerySchema = z.object({
  params: z.object({
    id: z.string().guid({ message: 'User ID must be a valid UUID' }),
  }),
  query: z.object({
    rolePeriod: z.nativeEnum(UserRole).optional(),
    batchId: z.string().guid('Invalid uuid').optional(),
    startDate: isoDateFilterSchema,
    endDate: isoDateFilterSchema,
    auditType: auditTypeEnum.optional(),
    tab: user360TabEnum.default('all'),
  }),
});

export type User360QueryParams = z.infer<typeof user360QuerySchema>['query'];

export const user360ExportSchema = z.object({
  params: z.object({
    id: z.string().guid({ message: 'User ID must be a valid UUID' }),
  }),
  query: z.object({
    format: z.literal('csv').default('csv'),
    rolePeriod: z.nativeEnum(UserRole).optional(),
    batchId: z.string().guid('Invalid uuid').optional(),
    startDate: isoDateFilterSchema,
    endDate: isoDateFilterSchema,
    auditType: auditTypeEnum.optional(),
  }),
});

export type User360ExportParams = z.infer<typeof user360ExportSchema>['query'];
