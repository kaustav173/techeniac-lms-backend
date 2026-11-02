import { z } from 'zod';

const passwordPattern =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{10,64}$/;

export const passwordValidation = z
  .string({ required_error: 'Password is required' })
  .min(10, 'Password must be at least 10 characters long')
  .max(64, 'Password must not exceed 64 characters')
  .regex(
    passwordPattern,
    'Password must contain at least 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character',
  );

export const emailValidation = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Invalid email address format')
  .max(254, 'Email must not exceed 254 characters');

export const loginSchema = z.object({
  body: z.object({
    email: emailValidation,
    password: z
      .string({ required_error: 'Password is required' })
      .min(1, 'Password is required')
      .max(128, 'Password is too long'),
  }),
});

export const refreshTokenSchema = z.object({
  body: z
    .object({
      refreshToken: z.string().optional(),
    })
    .optional(),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: emailValidation,
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string({ required_error: 'Reset token is required' }),
    newPassword: passwordValidation,
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string({ required_error: 'Current password is required' }),
    newPassword: passwordValidation,
  }),
});

export const verifyResetTokenSchema = z.object({
  body: z.object({
    token: z
      .string({ required_error: 'Reset token is required' })
      .trim()
      .min(1, 'Reset token cannot be empty'),
  }),
});

export const updateProfileSchema = z.object({
  body: z
    .object({
      name: z
        .string({ required_error: 'Name is required' })
        .trim()
        .min(2, 'Name must be at least 2 characters long')
        .max(100, 'Name must not exceed 100 characters'),
    })
    .strict(),
});

export type LoginInput = z.infer<typeof loginSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];
export type VerifyResetTokenInput = z.infer<typeof verifyResetTokenSchema>['body'];
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>['body'];
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>['body'];
