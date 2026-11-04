import { z } from 'zod';

import { AuditLogType } from '../entities/audit.enums';

export const auditTypeSchema = z.nativeEnum(AuditLogType);

const dateStringSchema = z.string().refine((val) => !isNaN(Date.parse(val)), {
  message: 'Invalid date format. Expected valid ISO-8601 or YYYY-MM-DD date string.',
});

export const getAuditLogsSchema = z.object({
  query: z
    .object({
      type: auditTypeSchema.optional(),
      actorId: z.string().uuid('Invalid actor ID format').optional(),
      entity: z.string().min(1).max(100).optional(),
      action: z.string().min(1).max(100).optional(),
      startDate: dateStringSchema.optional(),
      endDate: dateStringSchema.optional(),
      page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
      limit: z.coerce
        .number()
        .int()
        .min(1, 'Limit must be at least 1')
        .max(100, 'Limit cannot exceed 100')
        .default(10),
    })
    .refine(
      (data) => {
        if (data.startDate && data.endDate) {
          return new Date(data.startDate).getTime() <= new Date(data.endDate).getTime();
        }
        return true;
      },
      {
        message: 'startDate must be before or equal to endDate',
        path: ['startDate'],
      },
    ),
});

export type AuditQueryParams = z.infer<typeof getAuditLogsSchema>['query'];
