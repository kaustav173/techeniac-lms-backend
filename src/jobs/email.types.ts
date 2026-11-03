import type {
  SendAllocationCompletedOptions,
  SendAssignmentGradedOptions,
  SendCourseAllocatedOptions,
  SendCourseDeadlineChangedOptions,
  SendInviteEmailOptions,
  SendMenteeReassignedOptions,
  SendMentorMappedOptions,
  SendPasswordResetOptions,
  SendResubmissionRequestedOptions,
  SendSubmissionReceivedOptions,
  SendTopicDeadlineChangedOptions,
} from '../core/email/email.service';

export type EmailJobData =
  | { type: 'PASSWORD_RESET'; payload: SendPasswordResetOptions }
  | { type: 'INVITE'; payload: SendInviteEmailOptions }
  | { type: 'COURSE_ALLOCATED'; payload: SendCourseAllocatedOptions }
  | { type: 'COURSE_DEADLINE_CHANGED'; payload: SendCourseDeadlineChangedOptions }
  | { type: 'MENTOR_MAPPED'; payload: SendMentorMappedOptions }
  | { type: 'MENTEE_REASSIGNED'; payload: SendMenteeReassignedOptions }
  | { type: 'SUBMISSION_RECEIVED'; payload: SendSubmissionReceivedOptions }
  | { type: 'ASSIGNMENT_GRADED'; payload: SendAssignmentGradedOptions }
  | { type: 'RESUBMISSION_REQUESTED'; payload: SendResubmissionRequestedOptions }
  | { type: 'ALLOCATION_COMPLETED'; payload: SendAllocationCompletedOptions }
  | { type: 'TOPIC_DEADLINE_CHANGED'; payload: SendTopicDeadlineChangedOptions };
