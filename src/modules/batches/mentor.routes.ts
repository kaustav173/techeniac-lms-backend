import { Router } from 'express';

import { validate } from '../../core/http';
import { requireAuth, requireRole } from '../auth';
import { dashboardController } from '../dashboard';
import {
  exportPerformanceSchema,
  performanceController,
  performanceFilterSchema,
} from '../performance';
import {
  gradeSubmissionSchema,
  gradingController,
  requestResubmissionSchema,
  submissionIdParamSchema,
  submissionQueueQuerySchema,
} from '../submissions';
import { UserRole } from '../users';
import { batchController } from './batch.controller';
import { batchQuerySchema, getBatchByIdSchema, mentorQuerySchema } from './schemas';

export const mentorRouter = Router();

// Restricted to Mentors only (Section 2.1 Mentor Scope)
mentorRouter.use(requireAuth, requireRole(UserRole.MENTOR));

// Root redirect to dashboard
mentorRouter.get('/', (_req, res) => {
  res.redirect('/api/v1/mentor/dashboard');
});

// Note: Handlers are wrapped in arrow functions to defer controller resolution
// and prevent undefined evaluation during circular module loading between batches and imported modules.

// Dashboard
mentorRouter.get('/dashboard', (req, res, next) =>
  dashboardController.getMentorDashboard(req, res, next),
);

// Batches
mentorRouter.get('/batches', validate(batchQuerySchema), batchController.getBatches);
mentorRouter.get('/batches/:id', validate(getBatchByIdSchema), batchController.getBatchById);

// Mentees
mentorRouter.get('/my-mentees', validate(mentorQuerySchema), batchController.getMentorMentees);
mentorRouter.get('/mentees', validate(mentorQuerySchema), batchController.getMentorMentees);

// Reviews (renamed/aliased from submissions)
mentorRouter.get('/reviews', validate(submissionQueueQuerySchema), (req, res) =>
  gradingController.getSubmissionQueue(req, res),
);
mentorRouter.get('/reviews/queue', validate(submissionQueueQuerySchema), (req, res) =>
  gradingController.getSubmissionQueue(req, res),
);
mentorRouter.get('/reviews/:submissionId', validate(submissionIdParamSchema), (req, res) =>
  gradingController.getReviewDetails(req, res),
);
mentorRouter.get('/reviews/:submissionId/review', validate(submissionIdParamSchema), (req, res) =>
  gradingController.getReviewDetails(req, res),
);
mentorRouter.post('/reviews/:submissionId/grade', validate(gradeSubmissionSchema), (req, res) =>
  gradingController.gradeSubmission(req, res),
);
mentorRouter.post(
  '/reviews/:submissionId/resubmit-request',
  validate(requestResubmissionSchema),
  (req, res) => gradingController.requestResubmission(req, res),
);

// Performance
mentorRouter.get('/mentees-performance', validate(performanceFilterSchema), (req, res, next) =>
  performanceController.getPerformance(req, res, next),
);
mentorRouter.get(
  '/mentees-performance/export',
  validate(exportPerformanceSchema),
  (req, res, next) => performanceController.exportPerformance(req, res, next),
);
