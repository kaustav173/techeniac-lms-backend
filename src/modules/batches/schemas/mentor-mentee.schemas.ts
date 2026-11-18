import { z } from 'zod';

export const mapMenteesSchema = z.object({
  params: z.object({
    id: z.string().guid('Invalid batch ID'),
  }),
  body: z.object({
    mentorId: z.string().guid('Invalid mentor ID'),
    menteeIds: z
      .array(z.string().guid('Each mentee ID must be a valid UUID'))
      .min(1, 'At least one mentee must be selected')
      .max(100, 'Cannot map more than 100 mentees in a single request')
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Duplicate mentee IDs are not allowed in a single mapping request',
      }),
  }),
});

export const reassignMenteeSchema = z.object({
  params: z.object({
    id: z.string().guid('Invalid batch ID'),
  }),
  body: z.object({
    menteeId: z.string().guid('Invalid mentee ID'),
    newMentorId: z.string().guid('Invalid mentor ID'),
    reason: z.string().max(500, 'Reason cannot exceed 500 characters').optional().nullable(),
  }),
});

export const mentorQuerySchema = z.object({
  query: z.object({
    batchId: z.string().guid('Invalid batch ID').optional(),
    batchIds: z
      .union([
        z.string().transform((val) =>
          val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
        z.array(z.string()),
      ])
      .pipe(z.array(z.string().guid('Invalid UUID in batchIds')))
      .optional(),
  }),
});

export type MapMenteesInput = z.infer<typeof mapMenteesSchema>['body'];
export type ReassignMenteeInput = z.infer<typeof reassignMenteeSchema>['body'];
export type MentorQueryParams = z.infer<typeof mentorQuerySchema>['query'];
