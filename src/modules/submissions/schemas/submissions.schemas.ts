import { z } from 'zod';

import { SubmissionStatus } from '../entities/submission.enums';

export const ASSIGNMENT_DERIVED_STATUSES = [
  'PENDING',
  SubmissionStatus.SUBMITTED,
  SubmissionStatus.RESUBMIT_REQUESTED,
  SubmissionStatus.GRADED,
  'OVERDUE',
  'CLOSED',
] as const;

export type AssignmentDerivedStatus = (typeof ASSIGNMENT_DERIVED_STATUSES)[number];

export const ASSIGNMENT_QUERY_STATUSES = ['ALL', ...ASSIGNMENT_DERIVED_STATUSES] as const;
export type AssignmentQueryStatus = (typeof ASSIGNMENT_QUERY_STATUSES)[number];
export const createSubmissionSchema = z.object({
  body: z.object({
    assignmentId: z.string().uuid({ message: 'assignmentId must be a valid UUID' }),
    courseAllocationId: z
      .string()
      .uuid({ message: 'courseAllocationId must be a valid UUID' })
      .optional(),
    confirmedComplete: z.boolean({
      required_error: 'Please confirm you have completed the assignment',
      invalid_type_error: 'confirmedComplete must be a boolean',
    }),
    submissionData: z
      .object({
        pdfUrl: z.string().trim().optional().nullable(),
        zipUrl: z.string().trim().optional().nullable(),
        linkUrl: z.string().trim().optional().nullable(),
      })
      .transform((data): { pdfUrl?: string; zipUrl?: string; linkUrl?: string } => ({
        pdfUrl: data.pdfUrl || undefined,
        zipUrl: data.zipUrl || undefined,
        linkUrl: data.linkUrl || undefined,
      }))
      .refine(
        (data) => {
          const hasPdf = Boolean(data.pdfUrl && data.pdfUrl.trim().length > 0);
          const hasZip = Boolean(data.zipUrl && data.zipUrl.trim().length > 0);
          const hasLink = Boolean(data.linkUrl && data.linkUrl.trim().length > 0);
          return hasPdf || hasZip || hasLink;
        },
        {
          message: 'At least one submission field (pdfUrl, zipUrl, or linkUrl) must be provided',
        },
      ),
  }),
});

export const listMyAssignmentsQuerySchema = z.object({
  query: z.object({
    courseId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
    status: z.enum(ASSIGNMENT_QUERY_STATUSES).optional().default('ALL'),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
  }),
});

export const assignmentIdParamSchema = z.object({
  params: z.object({
    assignmentId: z.string().uuid({ message: 'assignmentId must be a valid UUID' }),
  }),
});

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>['body'];
export type ListMyAssignmentsQuery = z.infer<typeof listMyAssignmentsQuerySchema>['query'];
