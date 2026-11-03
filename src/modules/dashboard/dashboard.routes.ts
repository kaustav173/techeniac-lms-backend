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

// Main /dashboard root redirects to admin dashboard
dashboardRouter.get('/', requireRole(UserRole.SUPER_ADMIN), (_req, res) => {
  res.redirect('/api/v1/admin/dashboard');
});

dashboardRouter.get('/dashboard', requireRole(UserRole.SUPER_ADMIN), (_req, res) => {
  res.redirect('/api/v1/admin/dashboard');
});

dashboardRouter.get('/admin', requireRole(UserRole.SUPER_ADMIN), (_req, res) => {
  res.redirect('/api/v1/admin/dashboard');
});

dashboardRouter.get('/mentor', requireRole(UserRole.MENTOR), (_req, res) => {
  res.redirect('/api/v1/mentor/dashboard');
});

dashboardRouter.get('/mentee', requireRole(UserRole.MENTEE), (_req, res) => {
  res.redirect('/api/v1/mentee/dashboard');
});
