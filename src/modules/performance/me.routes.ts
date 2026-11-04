import { Router } from 'express';

import { validate } from '../../core/http';
import { requireAuth } from '../auth';
import { performanceController } from './performance.controller';
import { learningHistoryQuerySchema } from './schemas';

export const meRouter = Router();

meRouter.use(requireAuth);

meRouter.get(
  '/my-performance',
  validate(learningHistoryQuerySchema),
  performanceController.getLearningHistory,
);

meRouter.get(
  '/performance',
  validate(learningHistoryQuerySchema),
  performanceController.getLearningHistory,
);

meRouter.get('/', validate(learningHistoryQuerySchema), performanceController.getLearningHistory);

meRouter.get(
  '/learning-history',
  validate(learningHistoryQuerySchema),
  performanceController.getLearningHistory,
);
