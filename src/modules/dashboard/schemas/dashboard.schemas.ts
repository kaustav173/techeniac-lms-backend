import { z } from 'zod';

export const adminDashboardSchema = z.object({
  users: z.object({
    totalUsers: z.number().int().nonnegative(),
    menteesCount: z.number().int().nonnegative(),
    mentorsCount: z.number().int().nonnegative(),
    adminsCount: z.number().int().nonnegative(),
  }),
  batches: z.object({
    totalBatches: z.number().int().nonnegative(),
    liveBatches: z.number().int().nonnegative(),
    draftBatches: z.number().int().nonnegative(),
    completedBatches: z.number().int().nonnegative(),
    onHoldBatches: z.number().int().nonnegative(),
    archivedBatches: z.number().int().nonnegative(),
  }),
  courses: z.object({
    totalCourses: z.number().int().nonnegative(),
    publishedCourses: z.number().int().nonnegative(),
  }),
  allocations: z.object({
    activeAllocations: z.number().int().nonnegative(),
    completedAllocations: z.number().int().nonnegative(),
  }),
  submissions: z.object({
    pendingReviewCount: z.number().int().nonnegative(),
    gradedCount: z.number().int().nonnegative(),
    resubmitRequestedCount: z.number().int().nonnegative(),
  }),
});

export const latestSubmissionItemSchema = z.object({
  id: z.string().guid('Invalid uuid'),
  assignmentId: z.string().guid('Invalid uuid'),
  assignmentTitle: z.string(),
  courseId: z.string().guid('Invalid uuid'),
  courseName: z.string(),
  menteeId: z.string().guid('Invalid uuid'),
  menteeName: z.string(),
  menteeEmail: z.string(),
  batchId: z.string().guid('Invalid uuid').nullable(),
  batchName: z.string().nullable(),
  version: z.number().int().positive(),
  status: z.string(),
  isLate: z.boolean(),
  submittedAt: z.string(),
});

export const mentorDashboardSchema = z.object({
  assignedBatchesCount: z.number().int().nonnegative(),
  activeMenteesCount: z.number().int().nonnegative(),
  pendingReviewCount: z.number().int().nonnegative(),
  gradedCount: z.number().int().nonnegative(),
  isZeroState: z.boolean(),
  latestSubmissions: z.array(latestSubmissionItemSchema),
});

export const menteeRecentSubmissionItemSchema = z.object({
  id: z.string().guid('Invalid uuid'),
  assignmentId: z.string().guid('Invalid uuid'),
  assignmentTitle: z.string(),
  courseName: z.string(),
  status: z.string(),
  marks: z.number().nullable(),
  gradeLabel: z.string().nullable(),
  isLate: z.boolean(),
  submittedAt: z.string(),
});

export const menteeUpcomingDeadlineItemSchema = z.object({
  allocationId: z.string().guid('Invalid uuid'),
  courseName: z.string(),
  dueDate: z.string(),
  progressPercent: z.number(),
  isOverdue: z.boolean(),
});

export const menteeDashboardSchema = z.object({
  activeCoursesCount: z.number().int().nonnegative(),
  completedCoursesCount: z.number().int().nonnegative(),
  overallProgressPercent: z.number().nonnegative(),
  pendingAssignmentsCount: z.number().int().nonnegative(),
  recentSubmissions: z.array(menteeRecentSubmissionItemSchema),
  upcomingDeadlines: z.array(menteeUpcomingDeadlineItemSchema),
});

export type AdminDashboardResponse = z.infer<typeof adminDashboardSchema>;
export type MentorDashboardResponse = z.infer<typeof mentorDashboardSchema>;
export type MenteeDashboardResponse = z.infer<typeof menteeDashboardSchema>;
export type LatestSubmissionItem = z.infer<typeof latestSubmissionItemSchema>;
export type MenteeRecentSubmissionItem = z.infer<typeof menteeRecentSubmissionItemSchema>;
export type MenteeUpcomingDeadlineItem = z.infer<typeof menteeUpcomingDeadlineItemSchema>;
