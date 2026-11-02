# Bull Board Dashboard Integration Design Spec

- **Date**: 2026-10-31
- **Branch**: `feat/bull-board-setup`
- **Scope**: Phase 1 of BullMQ Expansion (Dashboard & Queue Registry)
- **Status**: Draft for User Review

---

## 1. Problem Statement & Motivation

The Techeniac LMS Backend uses BullMQ for background job processing (starting with hourly expired refresh token cleanup). However, developers and system administrators currently have zero runtime observability into queue metrics, active jobs, completed jobs, delayed schedulers, or failed jobs with error stack traces.

To enable analysis and management of background jobs without introducing third-party SaaS dependencies, we need a visual administrative dashboard embedded into the backend application.

---

## 2. Goals & Non-Goals

### Goals

- Mount `@bull-board/express` at `/admin/queues`.
- Restrict dashboard access strictly to authenticated `SUPER_ADMIN` users via existing LMS JWT cookies or Bearer tokens.
- Establish an extensible registry pattern (`registerBullBoardQueue(queue: Queue)`) so any current or future queue automatically attaches to the dashboard.
- Register the existing `token-cleanup` queue immediately.
- Ensure the server starts gracefully even if Redis is temporarily unreachable.
- Adhere strictly to the repository's ~400-line code change limit.

### Non-Goals

- Migrating email services or cron jobs (reserved for Phase 2 and Phase 3 branches).
- Introducing separate HTTP basic auth credentials when native LMS role authentication already provides centralized, session-audited access.

---

## 3. Architecture & Component Design

```
                     ┌──────────────────────────────────────────────┐
                     │ Express Application (src/app.ts)            │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                          GET /admin/queues (Mount Path)
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ Security Middleware Chain                   │
                     │  1. requireAuth (verifies JWT / cookie)     │
                     │  2. requireRole(UserRole.SUPER_ADMIN)       │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼ (200 OK)
                     ┌──────────────────────────────────────────────┐
                     │ Bull Board ExpressAdapter                    │
                     │ (src/jobs/bull-board.ts)                     │
                     ├──────────────────────────────────────────────┤
                     │ createBullBoard({ serverAdapter, queues })   │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │ Queue Registry                               │
                     │  - token-cleanup (BullMQAdapter)             │
                     │  - [future: email-queue, etc.]               │
                     └──────────────────────────────────────────────┘
```

### 3.1. Components & Files

1. **`package.json`**:
   - Add `@bull-board/api` (`^9.10.5`)
   - Add `@bull-board/express` (`^9.10.5`)
     _(Note: BullMQ adapter is included directly within `@bull-board/api/bullMQAdapter`)._

2. **`src/jobs/bull-board.ts` (New Module)**:
   - Sets up `ExpressAdapter` with base path `/admin/queues`.
   - Initializes Bull Board instance via `createBullBoard`.
   - Exports `registerBullBoardQueue(queue: Queue): void` using `new BullMQAdapter(queue)`.
   - Exports `mountBullBoard(app: Express): void` to attach the Bull Board router to Express.

3. **`src/jobs/register-jobs.ts`**:
   - In `registerScheduledJobs()`, calls `registerBullBoardQueue(tokenCleanupQueue)` as soon as `tokenCleanupQueue` is initialized.

4. **`src/app.ts`**:
   - Protects and mounts Bull Board:
     ```typescript
     app.use(BULL_BOARD_BASE_PATH, requireAuth, requireRole(UserRole.SUPER_ADMIN));
     mountBullBoard(app);
     ```

5. **`src/jobs/index.ts`**:
   - Re-exports `registerBullBoardQueue`, `mountBullBoard`, and `BULL_BOARD_BASE_PATH`.

---

## 4. Security & Access Control

- **Authentication Mechanism**: Uses existing `requireAuth` middleware (`src/modules/auth/auth.middleware.ts`).
  - Supports `req.cookies.accessToken` (direct browser dashboard navigation).
  - Supports `Authorization: Bearer <token>` (API clients / proxy).
- **Authorization**: Uses `requireRole(UserRole.SUPER_ADMIN)`.
- **Response Matrix**:
  - Unauthenticated request: `401 Unauthorized` JSON envelope.
  - Authenticated as `MENTEE` or `MENTOR`: `403 Forbidden` JSON envelope.
  - Authenticated as `SUPER_ADMIN`: `200 OK` (renders Bull Board UI).

---

## 5. Error Handling & Resilience

- **Redis Offline / Delayed Startup**: `main.ts` already handles Redis unavailability non-fatally (`Failed to register BullMQ scheduled jobs. Running HTTP server with background jobs disabled`). Bull Board router will mount with empty queues if jobs fail to register, rather than crashing HTTP bootstrap.
- **Graceful Shutdown**: Handled via existing `closeScheduledJobs()` in `src/main.ts`.

---

## 6. Testing Strategy

1. **Integration Tests (`tests/integration/bull-board.api.test.ts`)**:
   - Verify unauthenticated requests to `/admin/queues` return `401 Unauthorized`.
   - Verify authenticated `MENTEE` requests return `403 Forbidden`.
   - Verify authenticated `MENTOR` requests return `403 Forbidden`.
   - Verify authenticated `SUPER_ADMIN` requests return `200 OK` with HTML contentType and Bull Board script assets.
2. **Type Checking & Linting**:
   - `npm run typecheck` (`tsc --noEmit`).
   - `npm run lint` (`eslint . --max-warnings 0`).
   - `npm run format:check`.

---

## 7. Line Budget & Diff Estimate

- `package.json` & `package-lock.json`: ~30 lines
- `src/jobs/bull-board.ts`: ~40 lines
- `src/jobs/register-jobs.ts`: ~5 lines
- `src/jobs/index.ts`: ~5 lines
- `src/app.ts`: ~10 lines
- `tests/integration/bull-board.api.test.ts`: ~90 lines
- **Total estimated diff**: **~180 lines** (well within the ~400-line diff limit).
