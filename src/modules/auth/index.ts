// eslint-disable-next-line simple-import-sort/exports -- requireAuth must be exported before authController to prevent circular dependency deadlock with route files
export { requireAuth, requireRole } from './auth.middleware';
export { AuthController, authController } from './auth.controller';
export { authRouter } from './auth.routes';
export type {
  AuthResult,
  AuthTokens,
  AuthUserPayload,
  IAuthService,
  VerifyResetTokenResult,
} from './auth.service';
export { AuthService, authService } from './auth.service';
export { Token, TokenRevokeReason, TokenType } from './entities/token.entity';
export type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  VerifyResetTokenInput,
} from './schemas/auth.schemas';
export {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  verifyResetTokenSchema,
} from './schemas/auth.schemas';
export { TokenRepository, tokenRepository } from './token.repository';
