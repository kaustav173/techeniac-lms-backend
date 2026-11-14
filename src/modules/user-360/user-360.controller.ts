import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '../../core/auth';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
import { BaseController } from '../../core/http';
import { mentorMenteeRepository } from '../batches';
import { UserRole } from '../users';
import type { User360ExportParams, User360QueryParams } from './user-360.schemas';
import { User360Service, user360Service } from './user-360.service';

export class User360Controller extends BaseController {
  constructor(private readonly service: User360Service = user360Service) {
    super();
  }

  private getAuthUser(req: Request): AuthenticatedUser {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    return req.user;
  }

  public getUser360 = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const authUser = this.getAuthUser(req);
      if ((authUser.role as UserRole) === UserRole.MENTOR) {
        const mappings = await mentorMenteeRepository.findActiveMappingsForMentor(authUser.id);
        const isMapped = mappings.some((m) => m.menteeId === String(id));
        if (!isMapped) {
          throw new ForbiddenError(
            'Mentors can only access 360 profiles of their assigned mentees',
          );
        }
      }

      const query = (req.query || {}) as unknown as User360QueryParams;
      const profile = await this.service.getUser360(String(id), query);
      this.sendSuccess(res, profile);
    } catch (error) {
      next(error);
    }
  };

  public exportUser360 = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const authUser = this.getAuthUser(req);
      if ((authUser.role as UserRole) === UserRole.MENTOR) {
        const mappings = await mentorMenteeRepository.findActiveMappingsForMentor(authUser.id);
        const isMapped = mappings.some((m) => m.menteeId === String(id));
        if (!isMapped) {
          throw new ForbiddenError(
            'Mentors can only export 360 profiles of their assigned mentees',
          );
        }
      }

      const query = (req.query || {}) as unknown as User360ExportParams;
      const csv = await this.service.exportUser360Csv(String(id), query);
      const filename = `user-360-${String(id)}-${Date.now()}.csv`;
      this.sendFile(res, Buffer.from(csv, 'utf-8'), filename, 'text/csv');
    } catch (error) {
      next(error);
    }
  };
}

export const user360Controller = new User360Controller();
