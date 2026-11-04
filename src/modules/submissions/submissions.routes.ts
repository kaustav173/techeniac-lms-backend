import { Router } from 'express';

import { validate } from '../../core/http';
import { requireAuth, requireRole } from '../auth';
import { gradingController } from './grading.controller';
import {
  gradeSubmissionSchema,
  requestResubmissionSchema,
  submissionIdParamSchema,
  submissionQueueQuerySchema,
} from './schemas/grading.schemas';
import {
  assignmentIdParamSchema,
  createSubmissionSchema,
  listMyAssignmentsQuerySchema,
} from './schemas/submissions.schemas';
import { submissionsController } from './submissions.controller';

export const submissionsRouter = Router();

// Authentication required for all submission routes
submissionsRouter.use(requireAuth);

/* -------------------------------------------------------------------------- */
/* Mentor / Super Admin Grading Endpoints (PRD M10: FR-10.1 - FR-10.7)        */
/* -------------------------------------------------------------------------- */
const gradingAuth = requireRole('SUPER_ADMIN', 'MENTOR');

submissionsRouter.get(
  '/queue',
  gradingAuth,
  validate(submissionQueueQuerySchema),
  gradingController.getSubmissionQueue,
);

submissionsRouter.get(
  '/:submissionId/review',
  gradingAuth,
  validate(submissionIdParamSchema),
  gradingController.getReviewDetails,
);

submissionsRouter.post(
  '/:submissionId/grade',
  gradingAuth,
  validate(gradeSubmissionSchema),
  gradingController.gradeSubmission,
);

submissionsRouter.post(
  '/:submissionId/resubmit-request',
  gradingAuth,
  validate(requestResubmissionSchema),
  gradingController.requestResubmission,
);

/* -------------------------------------------------------------------------- */
/* Dedicated Reviews Router for Mentor / Super Admin (PRD M10 & Review Queue)  */
/* -------------------------------------------------------------------------- */
export const reviewsRouter = Router();

reviewsRouter.use(requireAuth, gradingAuth);

// Root /reviews or /reviews/queue provides the review queue
reviewsRouter.get('/', validate(submissionQueueQuerySchema), gradingController.getSubmissionQueue);

reviewsRouter.get(
  '/queue',
  validate(submissionQueueQuerySchema),
  gradingController.getSubmissionQueue,
);

reviewsRouter.get(
  '/:submissionId',
  validate(submissionIdParamSchema),
  gradingController.getReviewDetails,
);

reviewsRouter.get(
  '/:submissionId/review',
  validate(submissionIdParamSchema),
  gradingController.getReviewDetails,
);

reviewsRouter.post(
  '/:submissionId/grade',
  validate(gradeSubmissionSchema),
  gradingController.gradeSubmission,
);

reviewsRouter.post(
  '/:submissionId/resubmit-request',
  validate(requestResubmissionSchema),
  gradingController.requestResubmission,
);

/* -------------------------------------------------------------------------- */
/* Mentee Submissions Endpoints (PRD M9: FR-9.1 - FR-9.7)                     */
/* -------------------------------------------------------------------------- */
const menteeAuth = requireRole('MENTEE');

submissionsRouter.get(
  '/my-assignments',
  menteeAuth,
  validate(listMyAssignmentsQuerySchema),
  submissionsController.getMyAssignments,
);

submissionsRouter.get(
  '/assignments/:assignmentId',
  menteeAuth,
  validate(assignmentIdParamSchema),
  submissionsController.getAssignmentSubmissionDetails,
);

submissionsRouter.post(
  '/',
  menteeAuth,
  validate(createSubmissionSchema),
  submissionsController.submitAssignment,
);
