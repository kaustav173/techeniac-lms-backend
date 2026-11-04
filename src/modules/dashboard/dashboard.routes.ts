import type { Request, Response } from 'express';
import { Router } from 'express';

import { requireAuth, requireRole } from '../auth';
import { UserRole } from '../users';
import { dashboardController } from './dashboard.controller';

/* -------------------------------------------------------------------------- */
/* Admin Router (PRD M12: FR-12.1)                                             */
/* -------------------------------------------------------------------------- */
export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(UserRole.SUPER_ADMIN));

// Root redirect to dashboard
adminRouter.get('/', (_req, res) => {
  res.redirect('/api/v1/admin/dashboard');
});

adminRouter.get('/dashboard', dashboardController.getAdminDashboard);

/* -------------------------------------------------------------------------- */
/* Main Dashboard Router & Redirects (PRD M12: FR-12.1 - FR-12.5)             */
/* -------------------------------------------------------------------------- */
export const dashboardRouter = Router();

// Authentication required for all dashboard routes
dashboardRouter.use(requireAuth);

const handleRoleDashboardRedirect = (req: Request, res: Response): void => {
  const role = req.user?.role as UserRole | undefined;
  if (role === UserRole.MENTOR) {
    res.redirect('/api/v1/mentor/dashboard');
    return;
  }
  if (role === UserRole.MENTEE) {
    res.redirect('/api/v1/mentee/dashboard');
    return;
  }
  res.redirect('/api/v1/admin/dashboard');
};

// Generic dashboard root redirects dispatch by role
dashboardRouter.get('/', handleRoleDashboardRedirect);
dashboardRouter.get('/dashboard', handleRoleDashboardRedirect);

dashboardRouter.get('/admin', requireRole(UserRole.SUPER_ADMIN), (_req, res) => {
  res.redirect('/api/v1/admin/dashboard');
});

dashboardRouter.get('/mentor', requireRole(UserRole.MENTOR), (_req, res) => {
  res.redirect('/api/v1/mentor/dashboard');
});

dashboardRouter.get('/mentee', requireRole(UserRole.MENTEE), (_req, res) => {
  res.redirect('/api/v1/mentee/dashboard');
});
