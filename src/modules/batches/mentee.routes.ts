import { Router } from 'express';

import { validate } from '../../core/http';
import { requireAuth, requireRole } from '../auth';
import { dashboardController } from '../dashboard';
import { learningHistoryQuerySchema, performanceController } from '../performance';
import { UserRole } from '../users';
import { batchController } from './batch.controller';

export const menteeRouter = Router();

// Restricted to Mentees only
menteeRouter.use(requireAuth, requireRole(UserRole.MENTEE));

// Root redirect to dashboard
menteeRouter.get('/', (_req, res) => {
  res.redirect('/api/v1/mentee/dashboard');
});

// Dashboard
menteeRouter.get('/dashboard', (req, res, next) =>
  dashboardController.getMenteeDashboard(req, res, next),
);

// Batch
menteeRouter.get('/batch', batchController.getMyBatch);

// Performance (renamed to my-performance)
menteeRouter.get('/my-performance', validate(learningHistoryQuerySchema), (req, res, next) =>
  performanceController.getLearningHistory(req, res, next),
);
