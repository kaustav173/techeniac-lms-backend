import type { CookieOptions, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../../core/auth';
import { env } from '../../core/config';
import { UnauthorizedError } from '../../core/errors';
import { BaseController } from '../../core/http';
import { AuthService, authService } from './auth.service';
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

export class AuthController extends BaseController {
  private serviceInstance?: AuthService;

  constructor(service?: AuthService) {
    super();
    this.serviceInstance = service;
  }

  private get service(): AuthService {
    return this.serviceInstance ?? authService;
  }

  public login = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.login(req.body as LoginInput);

    res.cookie('accessToken', result.tokens.accessToken, accessCookieOptions);
    res.cookie('refreshToken', result.tokens.refreshToken, refreshCookieOptions);

    this.sendSuccess(res, result);
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const token = cookies.refreshToken ?? body.refreshToken ?? '';

    const result = await this.service.refresh(token);

    res.cookie('accessToken', result.tokens.accessToken, accessCookieOptions);
    res.cookie('refreshToken', result.tokens.refreshToken, refreshCookieOptions);

    this.sendSuccess(res, result);
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
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await this.service.changePassword(userId, req.body as ChangePasswordInput);

    res.cookie('accessToken', result.tokens.accessToken, accessCookieOptions);
    res.cookie('refreshToken', result.tokens.refreshToken, refreshCookieOptions);

    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Password changed successfully',
      data: result,
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
