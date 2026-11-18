import type { CookieOptions, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../../core/auth';
import { env } from '../../core/config';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
import { BaseController } from '../../core/http';
import { type AuthResult, AuthService, authService } from './auth.service';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  UpdateProfileInput,
  VerifyResetTokenInput,
} from './schemas/auth.schemas';

const isProduction = env.NODE_ENV === 'production';

const cookieDefaults: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'none' : 'lax',
  path: '/',
};

const accessCookieOptions: CookieOptions = {
  ...cookieDefaults,
  maxAge: ACCESS_TOKEN_TTL_MS,
};

const refreshCookieOptions: CookieOptions = {
  ...cookieDefaults,
  maxAge: REFRESH_TOKEN_TTL_MS,
};

function usesBearerMode(req: Request): boolean {
  if (req.get('X-Auth-Mode') !== 'bearer') {
    return false;
  }

  if (
    ['Cookie', 'Origin', 'Referer', 'Sec-Fetch-Site'].some(
      (header) => req.get(header) !== undefined,
    )
  ) {
    throw new ForbiddenError(
      'Bearer mode requires a non-browser client without cookies',
      'AUTH_MODE_FORBIDDEN',
    );
  }

  return true;
}

export class AuthController extends BaseController {
  private serviceInstance?: AuthService;

  constructor(service?: AuthService) {
    super();
    this.serviceInstance = service;
  }

  private get service(): AuthService {
    return this.serviceInstance ?? authService;
  }

  private sessionPayload(
    res: Response,
    result: AuthResult,
    bearerMode: boolean,
  ): AuthResult | Pick<AuthResult, 'user'> {
    if (bearerMode) {
      return result;
    }
    res.cookie('accessToken', result.tokens.accessToken, accessCookieOptions);
    res.cookie('refreshToken', result.tokens.refreshToken, refreshCookieOptions);
    return { user: result.user };
  }

  public login = async (req: Request, res: Response): Promise<void> => {
    const bearerMode = usesBearerMode(req);
    const result = await this.service.login(req.body as LoginInput);
    this.sendSuccess(res, this.sessionPayload(res, result, bearerMode));
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    const bearerMode = usesBearerMode(req);
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const token = (bearerMode ? body.refreshToken : cookies.refreshToken) ?? '';

    const result = await this.service.refresh(token);
    this.sendSuccess(res, this.sessionPayload(res, result, bearerMode));
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const token = cookies.refreshToken ?? body.refreshToken;

    await this.service.logout(token);

    res.clearCookie('accessToken', cookieDefaults);
    res.clearCookie('refreshToken', cookieDefaults);

    this.sendMessage(res, 'Logged out successfully');
  };

  public getMe = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const user = await this.service.getCurrentUser(req.user.id);

    this.sendSuccess(res, { user });
  };

  public forgotPassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.forgotPassword(req.body as ForgotPasswordInput);
    this.sendMessage(res, 'If the email exists, a password reset link has been sent');
  };

  public resetPassword = async (req: Request, res: Response): Promise<void> => {
    await this.service.resetPassword(req.body as ResetPasswordInput);
    this.sendMessage(res, 'Password reset successfully. You may now log in.');
  };

  public verifyResetToken = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as VerifyResetTokenInput;
    const result = await this.service.verifyResetToken(token);
    this.sendSuccess(res, result);
  };

  public changePassword = async (req: Request, res: Response): Promise<void> => {
    const bearerMode = usesBearerMode(req);
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await this.service.changePassword(userId, req.body as ChangePasswordInput);

    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Password changed successfully',
      data: this.sessionPayload(res, result, bearerMode),
    });
  };

  public updateProfile = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const user = await this.service.updateProfile(userId, req.body as UpdateProfileInput);

    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Profile updated successfully',
      data: { user },
    });
  };
}

export const authController = new AuthController();
