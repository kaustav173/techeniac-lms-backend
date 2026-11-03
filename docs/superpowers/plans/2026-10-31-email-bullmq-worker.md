# BullMQ Email Queue & Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Redis-backed BullMQ `email-queue` with automatic retries and Bull Board registration, routing all `EmailService` dispatches through this queue with graceful in-process fallback when Redis is unavailable.

**Architecture:** Define typed email jobs in `src/jobs/email.types.ts`. Create `src/jobs/email.queue.ts` to manage the queue with exponential backoff (`attempts: 3`). Implement `src/jobs/email.worker.ts` to process jobs via `emailService.dispatchDirectly()`. Register `email-queue` in Bull Board in `src/jobs/register-jobs.ts`. Integrate with `EmailService` without changing any caller contracts.

**Tech Stack:** Node.js 24, TypeScript, BullMQ v6, Nodemailer, `@bull-board/api`.

**Spec:** [`docs/superpowers/specs/2026-10-31-email-bullmq-worker-design.md`](file:///home/kaustav-das/Documents/LMS/techeniac-lms-backend/docs/superpowers/specs/2026-10-31-email-bullmq-worker-design.md)

---

## Global Constraints

- Must support all 11 email types currently implemented in `EmailService`.
- Job options must enforce `attempts: 3` and exponential backoff (`delay: 2000`).
- Retain completed jobs (100) and failed jobs (200) for inspection in Bull Board.
- Must provide graceful fallback: if Redis is offline/uninitialized, dispatch directly via SMTP without throwing an unhandled exception.
- Public method signatures of `EmailService` must remain 100% backward-compatible.
- Branch diff must not exceed ~400 lines (target ~250 lines).

## Review Focus

1. Queue creation uses shared `redisConnection` without separate connection leaks.
2. `enqueueEmailJob` returns `false` (triggering fallback) when Redis is offline or queue uninitialized.
3. BullMQ worker catches dispatch failures and BullMQ handles retries without crashing the Node process.
4. `email-queue` tab appears in Bull Board (`/admin/queues`) alongside `token-cleanup`.
5. Shutdown sequence cleanly awaits `emailWorker.close()` and `emailQueue.close()`.

---

### Task 1: Email Job Types & Queue Module

**Files:**

- Create: `src/jobs/email.types.ts`
- Create: `src/jobs/email.queue.ts`
- Modify: `src/jobs/index.ts`
- Test: `tests/unit/email-queue.unit.test.ts`

**Interfaces:**

- Produces:
  - `EMAIL_QUEUE_NAME = 'email-queue'`
  - `type EmailJobData = ...` (discriminated union over 11 email types)
  - `initEmailQueue(): Queue<EmailJobData>`
  - `getEmailQueue(): Queue<EmailJobData> | null`
  - `enqueueEmailJob(data: EmailJobData): Promise<boolean>`
  - `closeEmailQueue(): Promise<void>`

- [x] **Step 1: Write unit tests in `tests/unit/email-queue.unit.test.ts`**

Write tests covering:

- `EMAIL_QUEUE_NAME` equals `'email-queue'`.
- `enqueueEmailJob` returns `false` when queue is uninitialized (fallback contract).
- `enqueueEmailJob` calls `queue.add()` with `attempts: 3` and exponential backoff when queue is initialized.

- [x] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx --test tests/unit/email-queue.unit.test.ts`
Expected: FAIL (`Cannot find module '../../src/jobs/email.queue'`).

- [x] **Step 3: Implement `src/jobs/email.types.ts`**

Define `EmailJobData` discriminated union covering all 11 email types:
`PASSWORD_RESET`, `INVITE`, `COURSE_ALLOCATED`, `COURSE_DEADLINE_CHANGED`, `MENTOR_MAPPED`, `MENTEE_REASSIGNED`, `SUBMISSION_RECEIVED`, `ASSIGNMENT_GRADED`, `RESUBMISSION_REQUESTED`, `ALLOCATION_COMPLETED`, `TOPIC_DEADLINE_CHANGED`.

- [x] **Step 4: Implement `src/jobs/email.queue.ts`**

Implement:

- Default job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 200`.
- `initEmailQueue()`
- `getEmailQueue()`
- `enqueueEmailJob()` with try-catch returning `false` on failure.
- `closeEmailQueue()`

- [x] **Step 5: Re-export in `src/jobs/index.ts`**

Export `EMAIL_QUEUE_NAME`, `EmailJobData`, `initEmailQueue`, `getEmailQueue`, `enqueueEmailJob`, `closeEmailQueue`.

- [x] **Step 6: Run test to verify it passes (GREEN)**

Run: `npx tsx --test tests/unit/email-queue.unit.test.ts`
Expected: PASS.

- [x] **Step 7: Commit Task 1**

```bash
git add src/jobs/email.types.ts src/jobs/email.queue.ts src/jobs/index.ts tests/unit/email-queue.unit.test.ts
git commit -m "feat(jobs): create email queue and job types module"
```

---

### Task 2: Email Worker and Bull Board Registration

**Files:**

- Create: `src/jobs/email.worker.ts`
- Modify: `src/jobs/register-jobs.ts`
- Modify: `src/jobs/index.ts`
- Test: `tests/unit/email-worker.unit.test.ts`

**Interfaces:**

- Consumes:
  - `EMAIL_QUEUE_NAME`, `EmailJobData`, `initEmailQueue`, `closeEmailQueue` from `./email.queue`
  - `registerBullBoardQueue` from `./bull-board`
  - `redisConnection` from `./redis-connection`
  - `emailService.dispatchDirectly` from `../core/email`
- Produces:
  - `createEmailWorker(): Worker<EmailJobData>`

- [x] **Step 1: Write unit tests in `tests/unit/email-worker.unit.test.ts`**

Verify `createEmailWorker` sets up worker with `redisConnection` and calls dispatch logic.

- [x] **Step 2: Implement `src/jobs/email.worker.ts`**

Create `Worker<EmailJobData>` on `EMAIL_QUEUE_NAME`:

- Processes jobs by invoking `emailService.dispatchDirectly(job.data)`.
- Listens to `failed` and `error` events with Pino logger.

- [x] **Step 3: Update `src/jobs/register-jobs.ts`**

- In `registerScheduledJobs()`:
  - `const emailQueue = initEmailQueue();`
  - `registerBullBoardQueue(emailQueue);`
  - `emailWorker = createEmailWorker();`
- In `closeScheduledJobs()`:
  - Closes `emailWorker` and `emailQueue`.

- [x] **Step 4: Re-export in `src/jobs/index.ts`**

Export `createEmailWorker`.

- [x] **Step 5: Run tests and static analysis**

Run:

```bash
npx tsx --test tests/unit/email-worker.unit.test.ts
npm run typecheck
npm run lint
```

Expected: PASS with 0 errors.

- [x] **Step 6: Commit Task 2**

```bash
git add src/jobs/email.worker.ts src/jobs/register-jobs.ts src/jobs/index.ts tests/unit/email-worker.unit.test.ts
git commit -m "feat(jobs): add email bullmq worker and register in bull board"
```

---

### Task 3: Integrate with `EmailService` and End-to-End Verification

**Files:**

- Modify: `src/core/email/email.service.ts`
- Test: `tests/integration/email-queue.api.test.ts`

**Interfaces:**

- Produces:
  - `EmailService.dispatchDirectly(job: EmailJobData): Promise<void>`
  - `EmailService.enqueueOrDispatch(job: EmailJobData): Promise<void>`

- [x] **Step 1: Write integration test in `tests/integration/email-queue.api.test.ts`**

Verify:

- Calling `emailService.sendPasswordResetEmail()` enqueues a job into `email-queue`.
- When worker executes, `dispatchDirectly` is triggered.
- If queue is unavailable, falls back to direct SMTP dispatch without error.

- [x] **Step 2: Refactor `src/core/email/email.service.ts`**

- Add `dispatchDirectly(job: EmailJobData): Promise<void>` containing the existing rendering and `transporter.sendMail()` switch-case logic.
- Add `private async enqueueOrDispatch(job: EmailJobData): Promise<void>`:
  - Checks if `enqueueEmailJob(job)` returns true.
  - If false (or throws), logs warning and awaits `this.dispatchDirectly(job)`.
- Update all 11 public methods to route through `enqueueOrDispatch(job)`.

- [x] **Step 3: Run integration test and existing unit tests**

Run:

```bash
npx tsx --test tests/integration/email-queue.api.test.ts
npx tsx --test tests/unit/bull-board.unit.test.ts tests/integration/bull-board.api.test.ts
```

Expected: All tests pass.

- [x] **Step 4: Full verification gate**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/core/email/email.service.ts tests/integration/email-queue.api.test.ts docs/superpowers/plans/2026-10-31-email-bullmq-worker.md
git commit -m "feat(email): route email dispatching through bullmq email queue with fallback"
```
