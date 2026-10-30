# Bull Board Dashboard Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed `@bull-board/express` into the backend mounted securely at `/admin/queues` for `SUPER_ADMIN` users to monitor BullMQ queues and connect the existing `token-cleanup` queue.

**Architecture:** Create a modular Bull Board registry in `src/jobs/bull-board.ts` using `ExpressAdapter` and `createBullBoard`. Mount the router in `src/app.ts` protected by `requireAuth` and `requireRole(UserRole.SUPER_ADMIN)`. Automatically register `tokenCleanupQueue` upon startup.

**Tech Stack:** Node.js 24, Express 5, TypeScript, BullMQ v6, `@bull-board/api` (^9.10.5), `@bull-board/express` (^9.10.5).

**Spec:** [`docs/superpowers/specs/2026-10-31-bull-board-setup-design.md`](file:///home/kaustav-das/Documents/LMS/techeniac-lms-backend/docs/superpowers/specs/2026-10-31-bull-board-setup-design.md)

---

## Global Constraints

- Base mount path must be `/admin/queues`.
- Authorization must enforce `requireRole(UserRole.SUPER_ADMIN)` preceded by `requireAuth`.
- Unauthenticated requests must return `401 Unauthorized` with standard AppError JSON envelope.
- Non-admin requests (Mentor, Mentee) must return `403 Forbidden` with standard AppError JSON envelope.
- Total diff in branch `feat/bull-board-setup` must not exceed ~400 lines (target ~180 lines).

## Review Focus

1. Unauthenticated GET to `/admin/queues` returns `401` JSON envelope, not unhandled exception or HTML page.
2. Mentee/Mentor GET to `/admin/queues` returns `403` JSON envelope.
3. Cookie-authenticated GET (`req.cookies.accessToken`) renders the dashboard `200 OK` HTML.
4. Static assets and nested routes under `/admin/queues/*` inherit the security middleware.
5. Server boots cleanly without throwing when Redis is disabled/offline and queue registration is bypassed.

---

### Task 1: Dependencies and Bull Board Adapter Module

**Files:**

- Modify: `package.json`
- Create: `src/jobs/bull-board.ts`
- Modify: `src/jobs/index.ts`

**Interfaces:**

- Produces:
  - `BULL_BOARD_BASE_PATH: string` (`'/admin/queues'`)
  - `registerBullBoardQueue(queue: Queue): void`
  - `mountBullBoard(app: Express): void`

- [ ] **Step 1: Install `@bull-board/api` and `@bull-board/express`**

```bash
npm install @bull-board/api@^9.10.5 @bull-board/express@^9.10.5
```

- [ ] **Step 2: Verify package installation**

Run: `npm ls @bull-board/api @bull-board/express`
Expected: Both packages resolve at `^9.10.5` without peer dependency conflicts.

- [ ] **Step 3: Implement `src/jobs/bull-board.ts`**

Create `src/jobs/bull-board.ts` with:

- `serverAdapter = new ExpressAdapter()` configured with `serverAdapter.setBasePath(BULL_BOARD_BASE_PATH)`
- `board = createBullBoard({ queues: [], serverAdapter })`
- `registerBullBoardQueue(queue: Queue)`: calls `board.addQueue(new BullMQAdapter(queue))`
- `mountBullBoard(app: Express)`: mounts `serverAdapter.getRouter()` at `BULL_BOARD_BASE_PATH`

- [ ] **Step 4: Re-export from `src/jobs/index.ts`**

Export `BULL_BOARD_BASE_PATH`, `registerBullBoardQueue`, and `mountBullBoard` from `src/jobs/index.ts`.

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json package-lock.json src/jobs/bull-board.ts src/jobs/index.ts
git commit -m "feat(jobs): create modular bull board adapter module"
```

---

### Task 2: Mount Bull Board in App and Wire `token-cleanup` Queue

**Files:**

- Modify: `src/jobs/register-jobs.ts`
- Modify: `src/app.ts`

**Interfaces:**

- Consumes:
  - `registerBullBoardQueue` from `src/jobs/bull-board.ts`
  - `mountBullBoard`, `BULL_BOARD_BASE_PATH` from `src/jobs/bull-board.ts`
  - `requireAuth`, `requireRole` from `src/modules/auth/auth.middleware.ts`
  - `UserRole.SUPER_ADMIN` from `src/core/auth`

- [ ] **Step 1: Wire queue registration in `src/jobs/register-jobs.ts`**

In `registerScheduledJobs()`, call `registerBullBoardQueue(tokenCleanupQueue)` immediately after `tokenCleanupQueue` is initialized.

- [ ] **Step 2: Mount Bull Board in `src/app.ts`**

In `src/app.ts`, before the terminal error handling middleware:

```typescript
app.use(BULL_BOARD_BASE_PATH, requireAuth, requireRole(UserRole.SUPER_ADMIN));
mountBullBoard(app);
```

- [ ] **Step 3: Verify static analysis**

Run: `npm run typecheck && npm run lint`
Expected: Both exit 0 with 0 errors.

- [ ] **Step 4: Commit Task 2**

```bash
git add src/jobs/register-jobs.ts src/app.ts
git commit -m "feat(jobs): mount bull board at /admin/queues with super admin auth"
```

---

### Task 3: Integration Tests and Security Verification

**Files:**

- Create: `tests/integration/bull-board.api.test.ts`

**Interfaces:**

- Exercises:
  - `GET /admin/queues`
  - Unauthenticated access
  - Forbidden roles (`MENTEE`, `MENTOR`)
  - Authorized role (`SUPER_ADMIN`) via Bearer token and cookie

- [ ] **Step 1: Write integration tests in `tests/integration/bull-board.api.test.ts`**

Write test suite covering:

1. `GET /admin/queues` with no credentials -> returns `401 Unauthorized` (`error.code: 'UNAUTHORIZED'`).
2. `GET /admin/queues` with Mentee auth token -> returns `403 Forbidden` (`error.code: 'FORBIDDEN'`).
3. `GET /admin/queues` with Mentor auth token -> returns `403 Forbidden` (`error.code: 'FORBIDDEN'`).
4. `GET /admin/queues` with Super Admin Bearer token -> returns `200 OK` with HTML content.
5. `GET /admin/queues` with Super Admin `accessToken` cookie -> returns `200 OK` with HTML content.

- [ ] **Step 2: Run tests**

Run: `npx tsx --test tests/integration/bull-board.api.test.ts`
Expected: All 5 test cases PASS.

- [ ] **Step 3: Run full verification suite**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: All verification commands pass with 0 warnings/errors.

- [ ] **Step 4: Commit Task 3**

```bash
git add tests/integration/bull-board.api.test.ts
git commit -m "test(jobs): add security and access integration tests for bull board"
```
