import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

import type { AuthenticatedUser } from '../../core/auth';
import { UnauthorizedError } from '../../core/errors';
import { BaseController } from '../../core/http';
import { PerformanceService, performanceService } from './performance.service';
import type {
  ExportPerformanceQuery,
  LearningHistoryQuery,
  PerformanceFilterQuery,
} from './schemas/performance.schemas';

export class PerformanceController extends BaseController {
  constructor(private readonly service: PerformanceService = performanceService) {
    super();
  }

  private getAuthUser(req: Request): AuthenticatedUser {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    return req.user;
  }

  public getPerformance = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const actor = this.getAuthUser(req);
      const query = req.query as unknown as PerformanceFilterQuery;
      const result = await this.service.getPerformance(actor, query);
      res.status(StatusCodes.OK).json({
        success: true,
        data: {
          metrics: result.metrics,
          mentees: result.mentees,
          pagination: result.pagination,
        },
        meta: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  };

  public exportPerformance = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const actor = this.getAuthUser(req);
      const query = req.query as unknown as ExportPerformanceQuery;
      const { csvData, filename } = await this.service.exportPerformance(actor, query);
      this.sendFile(res, Buffer.from(csvData, 'utf-8'), filename, 'text/csv; charset=utf-8');
    } catch (error) {
      next(error);
    }
  };

  public getLearningHistory = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const actor = this.getAuthUser(req);
      const query = req.query as unknown as LearningHistoryQuery;
      const result = await this.service.getLearningHistory(actor, query);
      this.sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };
}

export const performanceController = new PerformanceController();
