# BullMQ Email Queue & Worker Integration Design Spec

- **Date**: 2026-10-31
- **Branch**: `feat/email-bullmq-worker`
- **Scope**: Phase 2 of BullMQ Expansion (Reliable Background Email Delivery)
- **Status**: Draft for User Review

---

## 1. Problem Statement & Motivation

Currently, email delivery via Nodemailer in `EmailService` is executed either:

1. **Synchronously during HTTP requests** (e.g. user invite, password reset, submission receipt). If the external SMTP server experiences network latency or timeouts, the client's HTTP request hangs.
2. **Unmanaged asynchronous promises (`void emailService...`)** (e.g. course allocations, grading feedback, deadlines). If the process terminates, restarts, or SMTP fails, the email is permanently lost with zero retries.

To ensure resilience, non-blocking HTTP latency, and automatic retries with exponential backoff, email dispatching must be offloaded to a Redis-backed BullMQ queue (`email-queue`) and monitored in Bull Board.

---

## 2. Goals & Non-Goals

### Goals

- Establish an `email-queue` in BullMQ with default job options:
  - `attempts: 3` (retries up to 3 times on network/SMTP failure).
  - `backoff: { type: 'exponential', delay: 2000 }` (2s, 4s, 8s exponential delays).
  - `removeOnComplete: 100` (retains last 100 successful deliveries for inspection in Bull Board).
  - `removeOnFail: 200` (retains failed deliveries with error stacks so administrators can diagnose and click "Retry").
- Maintain **100% backward compatibility** with the existing public interface of `EmailService`. All caller services (`users`, `allocations`, `submissions`, `batches`, `auth`, `progress`) continue calling existing methods without code changes.
- Provide a **graceful fallback**: if Redis is unavailable or BullMQ registration is skipped (such as in local dev without Redis), email dispatch falls back to immediate in-process SMTP sending with a warning log.
- Register `email-queue` in Bull Board so administrators can monitor queue size, success rate, and delivery latency at `/admin/queues`.
- Adhere strictly to the repository's ~400-line code change limit.

### Non-Goals

- Changing email HTML templates or switching email service providers.
- Refactoring domain services to emit generic lifecycle events instead of triggering email actions.

---

## 3. Architecture & Data Flow

```
 Caller Service (e.g. users.service.ts)
           │
           ▼
 emailService.sendInviteEmail(options)
           │
           ▼
 ┌────────────────────────────────────────────────────────┐
 │ EmailService.enqueueOrDispatch(jobData)                │
 ├────────────────────────────┬───────────────────────────┤
 │ Redis/Queue Available?     │ Redis Offline / Fallback? │
 └─────────────┬──────────────┴─────────────┬─────────────┘
               │ (Yes)                      │ (No)
               ▼                            ▼
 ┌───────────────────────────┐  ┌───────────────────────┐
 │ BullMQ Queue: email-queue │  │ Direct SMTP Dispatch  │
 │ (attempts: 3, backoff)    │  │ (nodemailer in-proc)  │
 └─────────────┬─────────────┘  └───────────────────────┘
               │ (Redis pop)
               ▼
 ┌───────────────────────────┐
 │ BullMQ Worker:            │
 │ email.worker.ts           │
 └─────────────┬─────────────┘
               │
               ▼
 emailService.dispatchDirectly(jobData)
               │
               ▼
 Nodemailer SMTP Transport
```

---

## 4. Components & File Modifications

### 4.1. `src/jobs/email.types.ts` (New)

Defines the discriminated union of all 11 email job payloads:

- `PASSWORD_RESET`
- `INVITE`
- `COURSE_ALLOCATED`
- `COURSE_DEADLINE_CHANGED`
- `MENTOR_MAPPED`
- `MENTEE_REASSIGNED`
- `SUBMISSION_RECEIVED`
- `ASSIGNMENT_GRADED`
- `RESUBMISSION_REQUESTED`
- `ALLOCATION_COMPLETED`
- `TOPIC_DEADLINE_CHANGED`

### 4.2. `src/jobs/email.queue.ts` (New)

- Manages `emailQueue: Queue<EmailJobData> | null`.
- Exports `initEmailQueue(): Queue<EmailJobData>`.
- Exports `enqueueEmailJob(job: EmailJobData): Promise<boolean>`. Returns `true` if enqueued, `false` if fallback required.
- Exports `closeEmailQueue(): Promise<void>`.

### 4.3. `src/jobs/email.worker.ts` (New)

- Creates BullMQ `Worker<EmailJobData>` listening on `email-queue`.
- Calls `emailService.dispatchDirectly(job.data)`.
- Logs job lifecycle events (`completed`, `failed`, `error`).
- Exports `createEmailWorker(): Worker<EmailJobData>`.

### 4.4. `src/jobs/register-jobs.ts`

- Initializes `emailQueue` and registers it with Bull Board: `registerBullBoardQueue(emailQueue)`.
- Spawns `emailWorker`.
- Gracefully shuts down `emailWorker` and `emailQueue` in `closeScheduledJobs()`.

### 4.5. `src/core/email/email.service.ts`

- Adds `dispatchDirectly(job: EmailJobData): Promise<void>` for worker execution.
- Refactors public methods to call `enqueueOrDispatch(job: EmailJobData)`:
  - If `enqueueEmailJob` succeeds, returns immediately.
  - If enqueuing fails (Redis unavailable), executes `dispatchDirectly` synchronously in-process.

---

## 5. Resilience & Error Handling

1. **SMTP Outage / Temporary Network Failure**:
   BullMQ automatically retries the job up to 3 times with exponential backoff delays (2s, 4s, 8s).
2. **Terminal Failure**:
   If all 3 attempts fail, the job moves to BullMQ's `failed` state with the full error stack. The job is visible on Bull Board at `/admin/queues`, allowing administrators to inspect the failure and click "Retry".
3. **Redis Unavailable at Startup**:
   If Redis is down, `main.ts` logs a warning and proceeds without crashing. `EmailService` detects `emailQueue === null` and falls back to direct in-process SMTP dispatch.

---

## 6. Testing Strategy

1. **Unit Tests (`tests/unit/email-queue.unit.test.ts`)**:
   - Verify `enqueueEmailJob` adds jobs to BullMQ with `attempts: 3` and exponential backoff options.
   - Verify fallback mechanism when queue is unavailable.
   - Verify `emailWorker` invokes `dispatchDirectly` with expected parameters.
2. **Integration Verification**:
   - Verify existing email integration/unit tests continue to pass without modifications.
   - Run `npm run typecheck`, `npm run lint`, `npm run format:check`.

---

## 7. Diff Estimate

- `src/jobs/email.types.ts`: ~40 lines
- `src/jobs/email.queue.ts`: ~60 lines
- `src/jobs/email.worker.ts`: ~50 lines
- `src/jobs/register-jobs.ts`: ~20 lines
- `src/core/email/email.service.ts`: ~60 lines
- Unit tests: ~90 lines
- **Total estimated diff**: **~250 lines** (well below the ~400-line diff limit).
