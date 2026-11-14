import { Router } from 'express';

import { validate } from '../../core/http';
import { requireAuth, requireRole } from '../auth';
import { UserRole } from '../users';
import { user360Controller } from './user-360.controller';
import { user360ExportSchema, user360QuerySchema } from './user-360.schemas';

const router = Router();

// Module 3: User 360 Profile is accessible to Super Admin and Mentors for assigned mentees (PRD M3, HIS-06)
router.get(
  '/:id/360/export',
  requireAuth,
  requireRole(UserRole.SUPER_ADMIN, UserRole.MENTOR),
  validate(user360ExportSchema),
  (req, res, next) => {
    void user360Controller.exportUser360(req, res, next);
  },
);

router.get(
  '/:id/360',
  requireAuth,
  requireRole(UserRole.SUPER_ADMIN, UserRole.MENTOR),
  validate(user360QuerySchema),
  (req, res, next) => {
    void user360Controller.getUser360(req, res, next);
  },
);

export const user360Router = router;
