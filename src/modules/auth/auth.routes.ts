import { Router } from 'express';

import {
  loginRateLimiter,
  passwordResetRateLimiter,
  refreshRateLimiter,
  validate,
  verifyResetTokenRateLimiter,
} from '../../core/http';
import { authController } from './auth.controller';
import { requireAuth } from './auth.middleware';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyResetTokenSchema,
} from './schemas/auth.schemas';

export const authRouter = Router();

authRouter.post('/login', loginRateLimiter, validate(loginSchema), authController.login);
authRouter.post(
  '/refresh',
  refreshRateLimiter,
  validate(refreshTokenSchema),
  authController.refresh,
);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.getMe);
authRouter.post(
  '/forgot-password',
  passwordResetRateLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword,
);
authRouter.post(
  '/verify-reset-token',
  verifyResetTokenRateLimiter,
  validate(verifyResetTokenSchema),
  authController.verifyResetToken,
);
authRouter.post(
  '/reset-password',
  passwordResetRateLimiter,
  validate(resetPasswordSchema),
  authController.resetPassword,
);
authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  authController.changePassword,
);
authRouter.patch(
  '/profile',
  requireAuth,
  validate(updateProfileSchema),
  authController.updateProfile,
);
