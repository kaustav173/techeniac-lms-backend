import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  closeScheduledJobs,
  DEADLINE_REMINDER_SCHEDULER_ID,
  OVERDUE_DETECTION_SCHEDULER_ID,
  OVERDUE_JOBS_QUEUE_NAME,
  registerScheduledJobs,
} from '../../src/jobs';

void describe('Scheduled Overdue Jobs Integration Tests', () => {
  void it('registers overdue-jobs queue and schedulers, then closes cleanly', async () => {
    assert.equal(OVERDUE_DETECTION_SCHEDULER_ID, 'daily-overdue-detection');
    assert.equal(DEADLINE_REMINDER_SCHEDULER_ID, 'daily-deadline-reminders');
    assert.equal(OVERDUE_JOBS_QUEUE_NAME, 'overdue-jobs');

    // Run registration
    await registerScheduledJobs();

    // Verify registration does not throw on idempotent re-registration
    await registerScheduledJobs();

    // Clean teardown
    await closeScheduledJobs();
  });
});
