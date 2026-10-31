# Phase 3 Design Spec: Scheduled Overdue Jobs & Deadline Notifications

## 1. Overview & Objectives

In LMS workflows, course allocations and topics have deadlines (`dueDate` and `deadline`). To keep mentees, mentors, and administrators proactive:

1. **Daily Overdue Detection Job**: Identifies active allocations and incomplete topics whose deadlines have passed, logs structured metrics, and emits lifecycle events (`allocation.overdueDetected`, `topic.overdueDetected`).
2. **Upcoming Deadline Reminder Job**: Identifies allocations due within the next 48 hours and emits `allocation.reminderDue` events to trigger proactive reminders.

Both recurring tasks are managed by BullMQ v6 using `upsertJobScheduler` (idempotent, preventing duplicate cron triggers across cluster restarts) and registered in Bull Board for operational visibility and manual triggers.

---

## 2. Queue Architecture

### 2.1. Queue & Schedulers

- **Queue Name**: `overdue-jobs` (`OVERDUE_JOBS_QUEUE_NAME`)
- **Default Job Options**:
  - `removeOnComplete`: 100
  - `removeOnFail`: 200
  - `attempts`: 3
  - `backoff`: `{ type: 'exponential', delay: 5000 }`
- **Schedulers**:
  1. `OVERDUE_DETECTION_SCHEDULER_ID = 'daily-overdue-detection'`
     - Cron Pattern: `0 0 * * *` (Daily at midnight)
     - Job Name: `detect-overdue`
  2. `DEADLINE_REMINDER_SCHEDULER_ID = 'daily-deadline-reminders'`
     - Cron Pattern: `0 8 * * *` (Daily at 8:00 AM)
     - Job Name: `remind-deadlines`

### 2.2. Bull Board Integration

The `overdue-jobs` queue is registered in `src/jobs/bull-board.ts` alongside `token-cleanup` and `email-queue`. Administrators can:

- View scheduler status and next run times at `/admin/queues`.
- Trigger manual executions of `detect-overdue` or `remind-deadlines`.
- Inspect completed or failed execution logs.

---

## 3. Worker Implementation (`src/jobs/overdue.worker.ts`)

A dedicated BullMQ `Worker` listens on `overdue-jobs` and handles two job types:

### 3.1. `detect-overdue`

1. Queries all open `CourseAllocation` records (`status IN ('ASSIGNED', 'IN_PROGRESS')`) where `dueDate < NOW()` and `deletedAt IS NULL`.
2. Queries all incomplete `TopicProgress` records (`status IN ('NOT_STARTED', 'IN_PROGRESS')`) where `deadline < NOW()` and `deletedAt IS NULL`.
3. For each detected overdue item, emits corresponding lifecycle events on `eventBus`.
4. Returns summary `{ overdueAllocationsCount, overdueTopicsCount }`.

### 3.2. `remind-deadlines`

1. Computes reminder window `[NOW(), NOW() + 48 hours]`.
2. Queries open `CourseAllocation` records where `dueDate BETWEEN :now AND :windowEnd`.
3. Emits `allocation.reminderDue` event for each allocation.
4. Returns summary `{ reminderAllocationsCount }`.

---

## 4. Lifecycle Events (`src/core/lifecycle/event-bus.ts`)

Adds three new event definitions:

- `allocation.overdueDetected`: `{ allocationId: string; userId: string; courseId: string; dueDate: Date }`
- `topic.overdueDetected`: `{ topicProgressId: string; courseAllocationId: string; topicId: string; deadline: Date }`
- `allocation.reminderDue`: `{ allocationId: string; userId: string; courseId: string; dueDate: Date; hoursRemaining: number }`

---

## 5. Lifecycle Management (`src/jobs/register-jobs.ts`)

In `registerScheduledJobs()`:

```typescript
overdueQueue = new Queue(OVERDUE_JOBS_QUEUE_NAME, { connection: redisConnection });
registerBullBoardQueue(overdueQueue);

await overdueQueue.upsertJobScheduler(
  OVERDUE_DETECTION_SCHEDULER_ID,
  { pattern: '0 0 * * *' },
  { name: 'detect-overdue', opts: { removeOnComplete: 100, removeOnFail: 200 } },
);

await overdueQueue.upsertJobScheduler(
  DEADLINE_REMINDER_SCHEDULER_ID,
  { pattern: '0 8 * * *' },
  { name: 'remind-deadlines', opts: { removeOnComplete: 100, removeOnFail: 200 } },
);

overdueWorker = createOverdueWorker();
```

In `closeScheduledJobs()`:

```typescript
if (overdueWorker) {
  await overdueWorker.close();
  overdueWorker = null;
}
if (overdueQueue) {
  await overdueQueue.close();
  overdueQueue = null;
}
```

---

## 6. Testing Strategy

1. **Unit Tests (`tests/unit/overdue-worker.unit.test.ts`)**:
   - Verify `processOverdueDetection` queries overdue records and emits events.
   - Verify `processDeadlineReminders` queries 48h window records and emits events.
   - Verify worker instance creation and event handlers.
2. **Integration Verification (`tests/integration/overdue-jobs.api.test.ts`)**:
   - Verify scheduler upsert in `overdue-jobs` queue without errors.
   - Verify presence in Bull Board registry.
   - Verify end-to-end execution of both jobs.
3. **Static Analysis**:
   - `npm run typecheck`, `npm run lint`, `npm run format:check`.

---

## 7. Diff Estimate

- `src/core/lifecycle/event-bus.ts`: ~25 lines
- `src/jobs/overdue.worker.ts`: ~120 lines
- `src/jobs/register-jobs.ts`: ~30 lines
- `src/jobs/index.ts`: ~10 lines
- `tests/unit/overdue-worker.unit.test.ts`: ~80 lines
- `tests/integration/overdue-jobs.api.test.ts`: ~70 lines
- **Total estimated diff**: **~335 lines** (well below ~400-line limit).
