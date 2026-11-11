import { z } from 'zod';

import { AssignmentScope, SubmissionMode } from '../entities';

export const resourceItemSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, 'Resource title cannot be empty').max(150),
  url: z
    .string()
    .trim()
    .url('Invalid resource URL')
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return false;
      }
    }, 'Only http(s) URLs are allowed'),
  type: z.enum(['LINK', 'ATTACHMENT']),
});

// Course Schemas
export const createCourseSchema = z.object({
  body: z.object({
    title: z.string().trim().min(3, 'Course title must be at least 3 characters').max(150),
    description: z.string().trim().max(5000).optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateCourseSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid course ID'),
  }),
  body: z.object({
    title: z
      .string()
      .trim()
      .min(3, 'Course title must be at least 3 characters')
      .max(150)
      .optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true, message: 'expectedUpdatedAt must be a valid ISO 8601 datetime' }),
  }),
});

export const listCoursesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    search: z.string().trim().max(100).optional(),
    isActive: z
      .enum(['true', 'false', 'all'])
      .optional()
      .transform((val) => (val === undefined || val === 'all' ? undefined : val === 'true')),
    sortBy: z
      .enum(['createdAt', 'title', 'updatedAt', 'topics', 'assignments'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const courseIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid course ID'),
  }),
});

export const idParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID parameter'),
  }),
});

// Topic Schemas
export const createTopicSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid course ID'),
  }),
  body: z.object({
    title: z.string().trim().min(1, 'Topic title cannot be empty').max(150),
    description: z.string().trim().max(5000).optional(),
    resources: z.array(resourceItemSchema).optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateTopicSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid topic ID'),
  }),
  body: z.object({
    title: z.string().trim().min(1, 'Topic title cannot be empty').max(150).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    resources: z.array(resourceItemSchema).nullable().optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true, message: 'expectedUpdatedAt must be a valid ISO 8601 datetime' }),
  }),
});

export const reorderItemsSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          displayOrder: z.coerce.number().int().min(0),
        }),
      )
      .min(1, 'At least one item must be provided for reordering')
      .refine(
        (items) => {
          const ids = new Set(items.map((i) => i.id));
          return ids.size === items.length;
        },
        {
          message: 'Duplicate item IDs are not allowed in reordering payload',
        },
      ),
  }),
});

// Subtopic Schemas
export const createSubtopicSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid topic ID'),
  }),
  body: z.object({
    title: z.string().trim().min(1, 'Subtopic title cannot be empty').max(150),
    content: z.string().trim().max(20000).optional(),
    resources: z.array(resourceItemSchema).optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateSubtopicSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid subtopic ID'),
  }),
  body: z.object({
    title: z.string().trim().min(1, 'Subtopic title cannot be empty').max(150).optional(),
    content: z.string().trim().max(20000).nullable().optional(),
    resources: z.array(resourceItemSchema).nullable().optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    estimatedMinutes: z.coerce
      .number()
      .int()
      .positive('Estimated minutes must be positive')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true, message: 'expectedUpdatedAt must be a valid ISO 8601 datetime' }),
  }),
});

// Assignment Schemas
export const createAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid course ID'),
  }),
  body: z
    .object({
      scope: z.nativeEnum(AssignmentScope),
      topicId: z.string().uuid().nullable().optional(),
      title: z.string().trim().min(1, 'Assignment title cannot be empty').max(150),
      instructions: z.string().trim().max(20000).optional(),
      estimatedMinutes: z.coerce
        .number()
        .int()
        .positive('Estimated minutes must be greater than 0'),
      maxMarks: z.coerce
        .number()
        .positive('Max marks must be greater than 0')
        .max(1000, 'Max marks cannot exceed 1000'),
      passMarks: z.coerce.number().positive('Pass marks must be greater than 0'),
      allowLate: z.boolean().default(false),
      pdfMode: z.nativeEnum(SubmissionMode).default(SubmissionMode.OFF),
      zipMode: z.nativeEnum(SubmissionMode).default(SubmissionMode.OFF),
      urlMode: z.nativeEnum(SubmissionMode).default(SubmissionMode.OFF),
      resources: z.array(resourceItemSchema).optional(),
      displayOrder: z.coerce.number().int().min(0).optional(),
    })
    .refine((data) => data.passMarks <= data.maxMarks, {
      message: 'Pass marks cannot exceed max marks',
      path: ['passMarks'],
    })
    .refine(
      (data) =>
        data.pdfMode !== SubmissionMode.OFF ||
        data.zipMode !== SubmissionMode.OFF ||
        data.urlMode !== SubmissionMode.OFF,
      {
        message: 'At least one submission mode (PDF, ZIP, or URL) must be enabled',
        path: ['pdfMode'],
      },
    )
    .refine(
      (data) => {
        if (data.scope === AssignmentScope.TOPIC) {
          return !!data.topicId;
        }
        return !data.topicId;
      },
      {
        message:
          'Topic ID is required when scope is TOPIC, and must be absent when scope is COURSE',
        path: ['topicId'],
      },
    ),
});

export const updateAssignmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid assignment ID'),
  }),
  body: z
    .object({
      title: z.string().trim().min(1, 'Assignment title cannot be empty').max(150).optional(),
      instructions: z.string().trim().max(20000).nullable().optional(),
      estimatedMinutes: z.coerce
        .number()
        .int()
        .positive('Estimated minutes must be positive')
        .optional(),
      maxMarks: z.coerce.number().positive('Max marks must be greater than 0').max(1000).optional(),
      passMarks: z.coerce.number().positive('Pass marks must be greater than 0').optional(),
      allowLate: z.boolean().optional(),
      pdfMode: z.nativeEnum(SubmissionMode).optional(),
      zipMode: z.nativeEnum(SubmissionMode).optional(),
      urlMode: z.nativeEnum(SubmissionMode).optional(),
      resources: z.array(resourceItemSchema).nullable().optional(),
      displayOrder: z.coerce.number().int().min(0).optional(),
      expectedUpdatedAt: z
        .string()
        .datetime({ offset: true, message: 'expectedUpdatedAt must be a valid ISO 8601 datetime' }),
    })
    .refine(
      (data) => {
        if (data.passMarks !== undefined && data.maxMarks !== undefined) {
          return data.passMarks <= data.maxMarks;
        }
        return true;
      },
      {
        message: 'Pass marks cannot exceed max marks',
        path: ['passMarks'],
      },
    ),
});

export const statusToggleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    isActive: z.boolean(),
    expectedUpdatedAt: z
      .string()
      .datetime({ offset: true, message: 'expectedUpdatedAt must be a valid ISO 8601 datetime' }),
  }),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>['body'];
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>['body'];
export type ListCoursesQueryInput = z.infer<typeof listCoursesQuerySchema>['query'];
export type CreateTopicInput = z.infer<typeof createTopicSchema>['body'];
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>['body'];
export type ReorderItemsInput = z.infer<typeof reorderItemsSchema>['body'];
export type CreateSubtopicInput = z.infer<typeof createSubtopicSchema>['body'];
export type UpdateSubtopicInput = z.infer<typeof updateSubtopicSchema>['body'];
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>['body'];
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>['body'];
export type StatusToggleInput = z.infer<typeof statusToggleSchema>['body'];
