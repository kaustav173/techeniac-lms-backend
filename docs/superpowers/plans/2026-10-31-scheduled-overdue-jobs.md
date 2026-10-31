# Scheduled Overdue Jobs & Deadline Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement BullMQ recurring schedulers using `upsertJobScheduler` for daily overdue allocation/topic detection and 48-hour upcoming deadline reminders, registered in Bull Board with dedicated worker processing and lifecycle event emissions.

**Architecture:** Extend `LifecycleEvents` in `src/core/lifecycle/event-bus.ts`. Create `src/jobs/overdue.worker.ts` defining queue name, job processors, and worker factory. Register `overdue-jobs` queue and schedulers in `src/jobs/register-jobs.ts` with Bull Board visibility. Verify with unit and integration tests.

**Tech Stack:** Node.js 24, TypeScript strict mode, BullMQ v6, TypeORM on Neon PostgreSQL, `@bull-board/api`.

**Spec:** [`docs/superpowers/specs/2026-10-31-scheduled-overdue-jobs-design.md`](file:///home/kaustav-das/Documents/LMS/techeniac-lms-backend/docs/superpowers/specs/2026-10-31-scheduled-overdue-jobs-design.md)

---

## Global Constraints

- Schedulers must use `upsertJobScheduler` to guarantee idempotent cron definitions across restarts.
- Overdue queries must only check open allocations (`ASSIGNED`, `IN_PROGRESS`) and incomplete topics (`NOT_STARTED`, `IN_PROGRESS`), filtering out soft-deleted (`deleted_at IS NULL`) records.
- Must register in Bull Board for administrator visibility and manual trigger capability.
- Branch diff must not exceed ~400 lines of code.

---

### Task 1: Lifecycle Events & Overdue Worker Module

**Files:**

- Modify: `src/core/lifecycle/event-bus.ts`
- Create: `src/jobs/overdue.worker.ts`
- Modify: `src/jobs/index.ts`
- Test: `tests/unit/overdue-worker.unit.test.ts`

**Interfaces:**

- Produces:
  - `OVERDUE_JOBS_QUEUE_NAME = 'overdue-jobs'`
  - `OVERDUE_DETECTION_JOB_NAME = 'detect-overdue'`
  - `DEADLINE_REMINDER_JOB_NAME = 'remind-deadlines'`
  - `processOverdueDetection(dataSource?: DataSource): Promise<{ overdueAllocationsCount: number; overdueTopicsCount: number }>`
  - `processDeadlineReminders(dataSource?: DataSource): Promise<{ reminderAllocationsCount: number }>`
  - `createOverdueWorker(): Worker`
  - Lifecycle events: `allocation.overdueDetected`, `topic.overdueDetected`, `allocation.reminderDue`

- [x] **Step 1: Write unit tests in `tests/unit/overdue-worker.unit.test.ts`**

Write tests covering:

- `OVERDUE_JOBS_QUEUE_NAME`, `OVERDUE_DETECTION_JOB_NAME`, `DEADLINE_REMINDER_JOB_NAME` constants.
- `processOverdueDetection` querying overdue allocations and emitting `allocation.overdueDetected` events.
- `processDeadlineReminders` querying allocations in the 48-hour window and emitting `allocation.reminderDue` events.
- `createOverdueWorker` creating a worker on `overdue-jobs`.

- [x] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx --test tests/unit/overdue-worker.unit.test.ts`
Expected: FAIL.

- [x] **Step 3: Update `src/core/lifecycle/event-bus.ts`**

Add event interfaces and extend `LifecycleEvents` with:

- `'allocation.overdueDetected'`
- `'topic.overdueDetected'`
- `'allocation.reminderDue'`

- [x] **Step 4: Implement `src/jobs/overdue.worker.ts`**

Implement:

- `processOverdueDetection`
- `processDeadlineReminders`
- `createOverdueWorker` with `failed` and `error` event handlers.

- [x] **Step 5: Re-export in `src/jobs/index.ts`**

Export queue and job constants and worker creator.

- [x] **Step 6: Run test to verify it passes (GREEN)**

Run: `npx tsx --test tests/unit/overdue-worker.unit.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/core/lifecycle/event-bus.ts src/jobs/overdue.worker.ts src/jobs/index.ts tests/unit/overdue-worker.unit.test.ts
git commit -m "feat(jobs): add overdue detection and deadline reminder worker"
```

---

### Task 2: BullMQ Schedulers, Bull Board Registration & Integration Verification

**Files:**

- Modify: `src/jobs/register-jobs.ts`
- Test: `tests/integration/overdue-jobs.api.test.ts`

**Interfaces:**

- Produces:
  - `OVERDUE_DETECTION_SCHEDULER_ID = 'daily-overdue-detection'`
  - `DEADLINE_REMINDER_SCHEDULER_ID = 'daily-deadline-reminders'`
  - Schedulers registered in `overdue-jobs` queue via `upsertJobScheduler`.
  - `overdue-jobs` visible in Bull Board `/admin/queues`.

- [ ] **Step 1: Write integration tests in `tests/integration/overdue-jobs.api.test.ts`**

Write integration tests verifying:

- `registerScheduledJobs()` registers `overdue-jobs` queue with both schedulers.
- `overdue-jobs` is accessible in Bull Board router.
- `closeScheduledJobs()` closes the overdue worker and queue cleanly.

- [ ] **Step 2: Update `src/jobs/register-jobs.ts`**

- In `registerScheduledJobs()`:
  - Instantiate `overdueQueue = new Queue(OVERDUE_JOBS_QUEUE_NAME, { connection: redisConnection })`.
  - Call `registerBullBoardQueue(overdueQueue)`.
  - Register `OVERDUE_DETECTION_SCHEDULER_ID` (`0 0 * * *`) and `DEADLINE_REMINDER_SCHEDULER_ID` (`0 8 * * *`).
  - Instantiate `overdueWorker = createOverdueWorker()`.
- In `closeScheduledJobs()`:
  - Await `overdueWorker.close()` and `overdueQueue.close()`.

- [ ] **Step 3: Run integration test and existing job test suite**

Run:

```bash
npx tsx --test tests/integration/overdue-jobs.api.test.ts
npx tsx --test tests/integration/email-queue.api.test.ts tests/unit/bull-board.unit.test.ts tests/integration/bull-board.api.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Full verification gate**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/jobs/register-jobs.ts tests/integration/overdue-jobs.api.test.ts docs/superpowers/plans/2026-10-31-scheduled-overdue-jobs.md
git commit -m "feat(jobs): register overdue and deadline schedulers in bull board"
```
