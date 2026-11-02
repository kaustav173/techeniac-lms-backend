import { z } from 'zod';

import { UserRole } from './entities/user.entity';

export const userRoleSchema = z.nativeEnum(UserRole);

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(150),
  email: z.string().trim().email('Invalid email address').toLowerCase(),
  role: userRoleSchema,
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(150).optional(),
  email: z.string().trim().email('Invalid email address').toLowerCase().optional(),
});

export const changeRoleSchema = z.object({
  newRole: userRoleSchema,
  reason: z
    .string()
    .trim()
    .min(10, 'Reason must be at least 10 characters long')
    .max(500, 'Reason cannot exceed 500 characters'),
});

export const userIdParamsSchema = z.object({
  id: z.string().uuid('Invalid user ID format'),
});

export const userQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  role: userRoleSchema.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(100).optional(),
  batchId: z.string().uuid('Invalid batch ID').optional(),
  mentorId: z.string().uuid('Invalid mentor ID').optional(),
  withoutActiveBatch: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        if (val.toLowerCase() === 'true') return true;
        if (val.toLowerCase() === 'false') return false;
      }
      return val;
    }, z.boolean())
    .optional(),
});

export const listUsersSchema = z.object({
  query: userQuerySchema,
});

export const createUserRequestSchema = z.object({
  body: createUserSchema,
});

export const getUserByIdSchema = z.object({
  params: userIdParamsSchema,
});

export const updateUserRequestSchema = z.object({
  params: userIdParamsSchema,
  body: updateUserSchema,
});

export const changeRoleRequestSchema = z.object({
  params: userIdParamsSchema,
  body: changeRoleSchema,
});

export const userStatusRequestSchema = z.object({
  params: userIdParamsSchema,
});

export const roleImpactQuerySchema = z.object({
  newRole: userRoleSchema,
});

export const getRoleImpactRequestSchema = z.object({
  params: userIdParamsSchema,
  query: roleImpactQuerySchema,
});

export const resendInviteRequestSchema = z.object({
  params: userIdParamsSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
export type UserQueryParams = z.infer<typeof userQuerySchema>;
export type RoleImpactQueryParams = z.infer<typeof roleImpactQuerySchema>;
