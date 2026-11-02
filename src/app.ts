import cookieParser from 'cookie-parser';
import express, { Express } from 'express';
import helmet from 'helmet';
import { StatusCodes } from 'http-status-codes';

import { env } from './core/config';
import { healthRouter } from './core/health';
import { corsMiddleware, errorMiddleware, notFoundMiddleware } from './core/http';
import { allocationsRouter, registerAllocationLifecycleListeners } from './modules/allocations';
import { auditRouter } from './modules/audit';
import { authRouter } from './modules/auth';
import { batchRouter, menteeRouter, mentorRouter } from './modules/batches';
import { coursesRouter } from './modules/courses';
import { dashboardRouter } from './modules/dashboard';
import { meRouter, performanceRouter } from './modules/performance';
import {
  progressRouter,
  progressTrackerRouter,
  registerProgressLifecycleListeners,
} from './modules/progress';
import { submissionsRouter } from './modules/submissions';
import { user360Router } from './modules/user-360';
// eslint-disable-next-line architecture/cross-module-index-imports -- router mount isolated from barrel to eliminate circular dependency
import { usersRouter } from './modules/users/users.routes';

export function createApp(): Express {
  registerAllocationLifecycleListeners();
  registerProgressLifecycleListeners();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(corsMiddleware);
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/health', healthRouter);

  app.get('/api/v1', (_req, res) => {
    res.status(StatusCodes.OK).json({
      name: 'techeniac-lms-backend',
      version: '0.1.0',
      status: 'operational',
    });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/audit-logs', auditRouter);
  app.use('/api/v1/users', user360Router);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/courses', coursesRouter);
  app.use('/api/v1/course-allocations', allocationsRouter);
  app.use('/api/v1/course-allocations', progressRouter);
  app.use('/api/v1/progress', progressTrackerRouter);
  app.use('/api/v1/batches', batchRouter);
  app.use('/api/v1/mentor', mentorRouter);
  app.use('/api/v1/mentee', menteeRouter);
  app.use('/api/v1/submissions', submissionsRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/performance', performanceRouter);
  app.use('/api/v1/me', meRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

export const app = createApp();
