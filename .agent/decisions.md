# Architecture Decision Records (ADRs)

## ADR-001: Node.js 24 LTS Runtime

- **Date**: 2026-10-14
- **Status**: Accepted
- **Context**: The backend requires a stable, long-term supported Node.js execution runtime that offers high performance, modern ECMAScript standard support, and long-term security maintenance.
- **Options**:
  1. Node.js 20 LTS
  2. Node.js 22 LTS
  3. Node.js 24 LTS
- **Choice**: Node.js 24 LTS with `.nvmrc` set to `24` and `package.json` engines pinned to `>=24 <25`.
- **Reasons**: Node 24 is the modern LTS release offering updated V8 engine optimizations, standard native cryptographic primitives, and long-term vendor support.
- **Consequences**: Local development and deployment environments must use Node 24. Older Node runtime environments are unsupported.

---

## ADR-002: Module System Selection (CommonJS)

- **Date**: 2026-10-14
- **Status**: Accepted
- **Context**: Node.js and TypeScript support both CommonJS (CJS) and ECMAScript Modules (ESM). The project depends on TypeORM CLI for schema migrations and metadata reflection (`emitDecoratorMetadata`).
- **Options**:
  1. Pure ESM (`"type": "module"`)
  2. CommonJS (CJS)
- **Choice**: CommonJS.
- **Reasons**: TypeORM CLI relies heavily on runtime decorator reflection (`reflect-metadata`) and dynamic entity discovery. In Node.js, pure ESM often requires experimental loaders (`--loader ts-node/esm` or custom resolution flags) to load TypeScript entities and migration files dynamically. CommonJS provides seamless compatibility with TypeORM CLI, `ts-node`, and ecosystem tooling without fragile loader flags.
- **Consequences**: TypeScript compiles to CommonJS (`"module": "CommonJS"`). Code uses standard `import`/`export` syntax in source TypeScript, which is compiled down to CJS outputs.

---

## ADR-003: TypeScript Compiler Strictness Flags

- **Date**: 2026-10-14
- **Status**: Accepted
- **Context**: We need to establish static analysis guarantees in `tsconfig.json` while evaluating specific strictness flags (`noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`).
- **Options**:
  1. Baseline `strict: true` only.
  2. Enable all optional strictness flags without evaluation.
  3. Enable flags that provide strong type safety without conflicting with ORM/HTTP library typing patterns.
- **Choice**:
  - `strict`: `true`
  - `noUncheckedIndexedAccess`: `true` (Enabled) — Array and dictionary element access evaluates as `T | undefined`, eliminating unseen runtime index errors.
  - `noImplicitOverride`: `true` (Enabled) — Subclasses overriding base class methods must be explicitly marked with `override`, preventing subtle inheritance bugs.
  - `exactOptionalPropertyTypes`: `false` (Disabled) — This flag prevents assigning `undefined` to optional properties (`{ prop?: string }`). In Express and TypeORM, optional entity and request properties frequently pass explicit `undefined` or omit properties interchangeably. Enabling this flag introduces significant friction and type friction with library definitions without substantial safety gains.
- **Reasons**: Balances rigorous type safety and safety against runtime `undefined` bugs with library ecosystem compatibility.
- **Consequences**: Developers must handle possible `undefined` values when indexing arrays/records and use the `override` keyword when extending classes.

---

## ADR-004: Decoupled Repositories vs Monorepo

- **Date**: 2026-10-14
- **Status**: Accepted
- **Context**: The TechEniac LMS consists of an API backend and a separate user-facing frontend. We must choose repository organization.
- **Options**:
  1. Monorepo housing both backend and frontend.
  2. Decoupled individual repositories (`TechEniac-lms-backend` and separate frontend repo).
- **Choice**: Decoupled individual repositories.
- **Reasons**:
  - Independent deployment cycles and CI/CD pipelines.
  - Granular access control and permission management.
  - Reduced cognitive complexity and repository footprint for backend services.
  - Clean separation of concerns between client presentation and server API.
- **Consequences**: API contracts must be well-documented (OpenAPI/Swagger) to maintain synchronization between frontend and backend.

---

## ADR-005: Pull Request Merging & Linear History Discipline

- **Date**: 2026-10-14 (Updated: 2026-10-19)
- **Status**: Accepted
- **Context**: A Git branching and merging policy is required to maintain a readable, bisectable commit history on the default and integration branches.
- **Options**:
  1. Merge commits via Pull Requests (`git merge --no-ff`)
  2. Rebase and fast-forward
  3. Squash merge via Pull Requests
- **Choice**: Merge commits via reviewed Pull Requests with Conventional Commits for all branches merged into `dev`, with structured PR promotion across `dev` -> `staging` -> `main`.
- **Reasons**:
  - Preserves complete development history and author attributions across pull requests.
  - Generates clear merge commits linking pull requests to their target branches.
  - Enforces Conventional Commits across individual commits via Commitlint, ensuring changelogs and semantic versions remain structured.
  - Retains full context for multi-commit refactorings or feature slices.
- **Consequences**: Developers must adhere to Conventional Commits for commits on working branches. Pull Requests are merged using reviewed PR merge commits rather than mandatory squashing, keeping development provenance intact while maintaining linear traceability through PR merge points.

---

## ADR-006: Quality Gates, Static Analysis, and Hook Pipeline

- **Date**: 2026-10-14
- **Status**: Accepted
- **Context**: To maintain codebase health, prevent secret leakage, and enforce architectural boundaries across contributions, automated static analysis and pre-commit checks are required.
- **Options**:
  1. Manual PR reviews and ad-hoc linting.
  2. Legacy ESLint rc configuration with standard formatting plugins.
  3. ESLint 9 flat configuration (`eslint.config.mjs`) with type-aware TypeScript rules, custom in-config architectural boundary enforcement, Prettier separation, Gitleaks pre-commit secret detection, and commitlint hook validation.
- **Choice**: Option 3.
- **Reasons**:
  - ESLint flat configuration is the standard modern configuration format for ESLint 9+.
  - Type-aware TypeScript rules catch subtle promise mishandling (`no-floating-promises`, `no-misused-promises`) and unsafe types (`no-explicit-any`).
  - Custom in-config ESLint architecture rules provide automated enforcement of repository query confinement (`architecture/raw-queries-only-in-repositories`) and modular encapsulation (`architecture/cross-module-index-imports`) without extra external dependencies.
  - Prettier handles code formatting deterministically, with `eslint-config-prettier` preventing rule collisions.
  - Pre-commit scanning with Gitleaks guarantees secrets are caught locally before reaching remotes, with fallback detection failing clearly if Gitleaks is uninstalled.
  - Commitlint enforces Conventional Commits standard on commit messages to ensure integration history remains structured and semantically versionable.
- **Consequences**:
  - Developers must have Gitleaks installed locally to commit.
  - Commits that introduce unresolved promises, raw SQL queries outside repositories, or direct internal module imports will fail static checks.
  - `lint-fixtures/` is excluded from standard lint/formatting runs and tested separately via `npm run lint:test-rules`.

---

## ADR-007: Background Job Processing with BullMQ and Redis

- **Date**: 2026-10-15
- **Status**: Proposed
- **Context**: The LMS backend requires asynchronous background task processing for decoupled, fault-tolerant operations such as notification/email delivery, asynchronous file generation, data imports, and scheduled maintenance tasks.
- **Options**:
  1. In-process Node.js event emitters or setTimeout-based queues.
  2. Heavy message brokers (RabbitMQ, Apache Kafka).
  3. BullMQ backed by Redis.
- **Choice**: Option 3 (BullMQ backed by Redis).
- **Reasons**:
  - In-process queues lose state on application restarts or crashes and cannot distribute load across multiple horizontal API instances.
  - Enterprise brokers like Kafka or RabbitMQ introduce substantial infrastructure complexity disproportionate to current requirements.
  - BullMQ provides battle-tested, high-throughput Redis-backed queues with Lua script atomicity, built-in exponential backoff, job retention management, and first-class TypeScript support.
  - In local development:
    - On Linux, Redis can run natively as a system daemon (`sudo systemctl start redis-server`).
    - On macOS, Redis can run via Homebrew (`brew install redis && brew services start redis`) or Docker (`docker run -d -p 6379:6379 --name redis redis:alpine`).
  - In production, BullMQ connects seamlessly to managed Redis services or self-hosted Redis servers with password and TLS support.
- **Consequences**:
  - Implementation of core queue and worker factories in `src/core/queue/` is planned for a dedicated future PR.
  - Redis connection configurations will be centralized and validated via `src/core/config/` once implemented.
  - Local development environments will require a running Redis instance once this capability is introduced.
  - Production deployments will require configured `REDIS_HOST` or `REDIS_URL` connection parameters.

---

## ADR-008: Centralized Reusable Validation Primitives with Zod

- **Date**: 2026-10-15
- **Status**: Proposed
- **Context**: Across domain modules, input validation rules for common data types risk duplication, inconsistency, and divergent security requirements if implemented ad-hoc per endpoint.
- **Options**:
  1. Define individual Zod schemas inside each domain module independently.
  2. Implement validation using annotations or class-validator decorators.
  3. Establish a single source of truth for reusable atomic schemas and HTTP validation middleware in `src/core/validation/`.
- **Choice**: Option 3 (Single source of truth in `src/core/validation/`).
- **Reasons**:
  - Enforces uniform security criteria across the entire platform.
  - Reduces redundant code and simplifies future schema alignment between backend and frontend.
  - Provides a standard `validateRequest` middleware that normalizes 400 Bad Request error payloads with precise field errors.
  - Zod offers runtime type safety with direct TypeScript inference without decorator reflection overhead.
- **Consequences**:
  - Implementation of shared validation primitives and `validateRequest` middleware in `src/core/validation/` is planned for a dedicated validation PR.
  - Once implemented, domain modules will import standard primitives from `src/core/validation`.
  - Changes to platform-wide constraints will be centralized in one location.

---

## ADR-009: Continuous Integration (CI) Pipeline for Pull Requests

- **Date**: 2026-10-15
- **Status**: Accepted
- **Context**: Automated quality gates are required on all pull requests across all branches to prevent broken builds, formatting deviations, secret leakages, or architectural boundary violations from entering the codebase.
- **Options**:
  1. Manual pre-merge checklists.
  2. Heavy CI pipeline requiring Docker container orchestration and live DB services before DB setup is complete.
  3. Lightweight, container-free GitHub Actions CI workflow running Node 24, Gitleaks, type checking, ESLint 9 with architectural boundary tests, Prettier format verification, and TypeScript build compilation.
- **Choice**: Option 3 (`.github/workflows/ci.yml`).
- **Reasons**:
  - Automatically triggers on all pull requests from any branch to any branch (`pull_request: types: [opened, synchronize, reopened]`).
  - Matches the Node 24 LTS runtime specified in ADR-001.
  - Enforces Gitleaks pre-commit rules remotely in CI to ensure no secrets or `.env` variables are merged.
  - Executes strict static analysis (`tsc --noEmit`), ESLint with architecture rules, fixture rule checks, Prettier checks, and production compilation (`tsc`).
  - Excludes container dependencies until database persistence and migration setup are fully established.
- **Consequences**:
  - Pull requests must pass all static verification stages before merging.
  - Future database migration tests (`up -> down -> up`) can be cleanly appended once database configurations are wired.

---

## ADR-010: Multi-Stage Branching Strategy and Direct Commit Protection

- **Date**: 2026-10-15
- **Status**: Accepted
- **Context**: To establish a reliable software delivery lifecycle, direct commits to critical branches (`main`, `staging`, `dev`) must be prevented, and promotion must follow a structured pipeline (`feature` -> `dev` -> `staging` -> `main`).
- **Options**:
  1. Trunk-based development with direct commits to `main`.
  2. Multi-stage promotion (`dev` -> `staging` -> `main`) without automated branch guards.
  3. Tiered promotion hierarchy with dual-layer commit protection (local Husky `pre-commit` hook aborting direct commits on `main`, `staging`, and `dev`; GitHub Rulesets blocking direct pushes and requiring passing CI status checks).
- **Choice**: Option 3.
- **Reasons**:
  - Prevents unintended breaking changes from directly entering integration, staging, or production.
  - Gives developers a safety net locally through `.husky/pre-commit` which blocks accidental commits while on `main`, `staging`, or `dev`.
  - Enforces review, PR merge discipline, and CI validation across each promotion stage.
- **Consequences**:
  - Developers must branch from `dev` (`feat/*`, `fix/*`, `chore/*`) and submit Pull Requests.
  - Promotion between stages requires Pull Requests.
  - GitHub branch protection rules must be kept active on remote repository settings.

---

## ADR-011: Standardized AuditableEntity for Database Persistence

- **Date**: 2026-10-16 (Updated 2026-10-19)
- **Status**: Accepted
- **Context**: The LMS database schema requires uniform auditing and identification columns across all tables: UUID primary keys (`gen_random_uuid()`), timestamp with time zone creation and update tracking (`CURRENT_TIMESTAMP`), soft delete support via `deleted_at`, and audit actor tracking (`created_by`, `updated_by`). Additionally, naming must not shadow TypeORM's built-in `BaseEntity` (Active Record class) to prevent auto-import collisions and startup errors.
- **Options**:
  1. Define `id`, `created_at`, `updated_at`, `deleted_at`, `created_by`, and `updated_by` independently on each TypeORM entity.
  2. Implement an abstract `BaseEntity` in `src/core/db/base.entity.ts`.
  3. Implement an abstract `AuditableEntity` in `src/core/db/auditable.entity.ts` that includes UUID primary key, timestamps, soft delete, and actor audit fields without shadowing TypeORM's `BaseEntity`.
- **Choice**: Option 3 (`AuditableEntity` in `src/core/db/auditable.entity.ts`).
- **Reasons**:
  - Eliminates duplicate column definitions across domain entity schemas.
  - Prevents IDE auto-import conflicts with TypeORM's own Active Record `BaseEntity`.
  - Guarantees consistent PostgreSQL data types (`uuid`, `timestamptz`) and snake_case column names.
  - Pre-provisions `created_by` and `updated_by` nullable UUID audit columns across all tables before domain entities are created.
  - Native TypeORM `@CreateDateColumn`, `@UpdateDateColumn`, and `@DeleteDateColumn` support automated timestamp management and soft delete querying without boilerplate.
- **Consequences**:
  - All domain entities created in `src/modules/*/entities/` must extend `AuditableEntity`.
  - Auditing, soft-delete, and actor tracking semantics are applied consistently throughout the repository.

---

## ADR-012: Standardized HTTP Status Codes and Centralized Environment Configuration

- **Date**: 2026-10-16
- **Status**: Accepted
- **Context**: HTTP status codes were represented as literal numbers in route handlers and middleware. Additionally, direct access to `process.env` across disparate domain modules risks runtime configuration drift, unvalidated inputs, and tight coupling to host environments.
- **Options**:
  1. Continue using literal status codes (e.g. `200`, `503`, `204`) and allow ad-hoc `process.env` access.
  2. Implement a custom status code enum and manual convention for environment access.
  3. Adopt the battle-tested `http-status-codes` library across all controllers/middlewares (re-exported via `src/core/http`), enforce centralized environment loading via `src/core/config/` (Zod validation), and automate restriction via ESLint `no-process-env`.
- **Choice**: Option 3.
- **Reasons**:
  - `http-status-codes` eliminates magic status numbers and aligns with industry TypeScript standards.
  - Re-exporting `StatusCodes` via `src/core/http` provides seamless core module cohesion.
  - Centralizing environment parsing through Zod in `src/core/config/` guarantees strongly typed configuration at startup.
  - Automating enforcement via the ESLint `no-process-env` rule (with override only for `src/core/config/**`) ensures zero modules can bypass the centralized configuration.
- **Consequences**:
  - All route handlers and middlewares must use `StatusCodes.*` from `http-status-codes` (or `src/core/http`).
  - No file outside `src/core/config/` is permitted to reference `process.env`.

---

## ADR-013: Express 5 Adoption and Native Node 24 Environment Loading

- **Date**: 2026-10-16
- **Status**: Accepted
- **Context**: Express 4 requires boilerplate try-catch or wrapper libraries (e.g. `express-async-handler`) to handle asynchronous errors and forward rejected promises to error middleware. In addition, Node 24 LTS provides standard built-in `.env` file loading via `process.loadEnvFile()`, making the third-party `dotenv` dependency redundant.
- **Options**:
  1. Retain Express 4 with async route wrapper utilities and `dotenv`.
  2. Adopt Express 5 and native Node 24 `process.loadEnvFile()`.
- **Choice**: Option 2.
- **Reasons**:
  - Express 5 is the modern stable major line and natively routes rejected promises in async route handlers directly to Express error middleware without wrapper functions.
  - Using Node 24's native `process.loadEnvFile()` eliminates third-party runtime dependencies, shrinking the attack surface and reducing maintenance overhead.
  - Native loading integrates directly with standard Node configuration patterns.
- **Consequences**:
  - `express` is upgraded to `^5.0.0` with `@types/express` `^5.0.0`.
  - `dotenv` is completely removed from dependencies.
  - Async route handlers no longer require manual try-catch wrappers to forward rejected promises.

---

## ADR-014: Structured Logging with Pino

- **Date**: 2026-10-19
- **Status**: Accepted
- **Context**: Production observability requires structured JSON log outputs with standard severity levels, ISO timestamps, request correlation via child loggers, and full error stack preservation. The initial logger implementation printed string-interpolated logs and dropped error stack traces.
- **Options**:
  1. Continue using custom `console`-based wrapper with string interpolation.
  2. Adopt Winston.
  3. Adopt Pino (`pino`).
- **Choice**: Option 3 (Pino).
- **Reasons**:
  - Pino is an industry-standard, high-performance structured JSON logger for Node.js with near-zero overhead.
  - Built-in `err` serializer captures full Error stack traces, error names, and cause chains without manual stringification.
  - First-class support for child loggers (`logger.child({ requestId })`) enables granular request-scoped correlation.
  - Dynamic log level adjustments via `logger.level`.
  - Seamless ingestion by modern observability platforms (Datadog, CloudWatch, GCP Cloud Logging).
- **Consequences**:
  - `pino` is added as a runtime dependency in `src/core/logging`.
  - Loggers must pass the error object itself (`logger.error({ err }, 'message')`) rather than just `err.message`.
  - Log output is emitted as machine-readable JSON in all environments.

---

## ADR-015: Standardized JSON Error Hierarchy and Global Error Middleware

- **Date**: 2026-10-19
- **Status**: Accepted
- **Context**: An enterprise API requires consistent machine-readable error envelopes (`{ error: { code, message, details? } }`) across all responses. Without explicit error middleware, Express emits HTML stack trace pages on malformed client JSON or unhandled exceptions, leaking server paths and breaking frontend JSON parsing. Additionally, default Express headers (`X-Powered-By`) expose server implementation details.
- **Options**:
  1. Rely on Express default HTML error pages and ad-hoc error formatting per route.
  2. Implement custom global `notFoundMiddleware`, `errorMiddleware`, `app.disable('x-powered-by')`, and a centralized `AppError` hierarchy in `src/core/errors/`.
- **Choice**: Option 2.
- **Reasons**:
  - Enforces a predictable JSON error contract across all endpoints.
  - Intercepts body-parser syntax errors (400) and unhandled routes (404), converting them to JSON instead of HTML.
  - Sanitizes 500 internal server errors to prevent stack trace leaks to API consumers while logging full traces with Pino.
  - Disables the `X-Powered-By` header to prevent technology fingerprinting.
- **Consequences**:
  - All errors thrown in domain modules, middleware, or services must inherit from `AppError` (`src/core/errors`).
  - Terminal middleware chain in `src/app.ts` must always conclude with `notFoundMiddleware` followed by `errorMiddleware`.

---

## ADR-016: User Directory Search Indexing Strategy and Post-M2 Optimization Roadmap

- **Date**: 2026-10-22
- **Status**: Accepted (Trade-off Documented)
- **Context**: The M2 User Management feature introduces directory searching (`GET /api/v1/users?search=...`) by matching `name` or `email` with `ILIKE :search` pattern (`%search%`). Standard B-tree indexes (`IDX_users_email`) cannot be leveraged by PostgreSQL for leading-wildcard searches, resulting in sequential scans.
- **Options**:
  1. Immediately add `CREATE EXTENSION IF NOT EXISTS pg_trgm` and GIN trigram indexes on `name` and `email` (`gin_trgm_ops`).
  2. Accept leading-wildcard `ILIKE` sequential scan as a deliberate trade-off for initial M2 scale, queuing the `pg_trgm` GIN migration for post-M2 when user directory volume warrants it.
- **Choice**: Option 2.
- **Reasons**:
  - At M2 initial production scale (low hundreds of users across Super Admins, Mentors, and Mentees), sequential scans over `users` complete in sub-millisecond execution times.
  - Deferring GIN trigram indexes avoids adding database extension prerequisites, maintenance locks, and write overhead until directory search volume and row counts justify it.
  - The query pattern is isolated cleanly within `UserRepository.findAll`, making future index optimization transparent to application callers.
- **Consequences**:
  - In M2, directory search will perform sequential scans on the `users` table.
  - A follow-up migration enabling `pg_trgm` and creating GIN trigram indexes on `name` and `email` is tracked for future scale milestones.

---

## ADR-017: Lifecycle Event Bus Guarantees and In-Process Event Routing

- **Date**: 2026-10-26
- **Status**: Accepted
- **Context**: Module 6 Course Builder requires notifying downstream listeners (e.g., Module 8 progress recalculation per FR-6.15) when course topics are added, deactivated, reactivated, or deleted (`course.topicsChanged`). We must establish the architectural guarantees, type safety, and boundaries of the event mechanism.
- **Options**:
  1. Direct cross-module method invocation (e.g., `CoursesService` calling `ProgressService`).
  2. Durable queue via BullMQ for every lifecycle notification immediately.
  3. Strongly typed, in-process Node.js EventEmitter (`LifecycleEventBus` in `src/core/lifecycle/`) with explicit best-effort guarantees, deferring distributed BullMQ jobs to dedicated workers.
- **Choice**: Option 3.
- **Reasons**:
  - Prevents tight coupling between domain modules and preserves modular encapsulation.
  - Strict type safety: Removing the `[key: string]: unknown` index signature guarantees that only explicitly declared events in `LifecycleEvents` can be emitted or listened to.
  - Async isolation: Asynchronous listener errors are caught and logged with Pino without crashing the server or aborting HTTP request handlers.
  - Explicit Guarantees: The event bus is in-process and best-effort. It is non-transactional and events are not replayed on process restart. Durable asynchronous workflows must be routed via BullMQ per ADR-007.
- **Consequences**:
  - `eventBus` is centralized in `src/core/lifecycle`.
  - Events must be typed in `LifecycleEvents`.
  - Downstream modules can subscribe via `eventBus.onEvent`.
  - Critical tasks requiring delivery guarantees must enqueue to BullMQ rather than rely solely on in-process memory.

---

## ADR-018: Audit Log Architecture, Append-Only Storage, and PII Boundaries

- **Date**: 2026-10-29
- **Status**: Accepted
- **Context**: Module 14 provides enterprise-grade compliance auditing across administrative and operational state changes (`audit_logs` table). We must specify architectural layer boundaries, entity inheritance, append-only persistence guarantees, and PII exposure limits.
- **Options**:
  1. Have foundational `src/core` manage auditing directly while importing feature entities.
  2. Maintain `AuditLog` as an independent entity without `AuditableEntity` inheritance.
  3. Locate `AuditLog` and `logAudit` inside `src/modules/audit`, inherit standard base tracking from `AuditableEntity`, strictly enforce append-only semantics, and isolate PII from logs.
- **Choice**: Option 3.
- **Reasons**:
  - **Layer Inversion Prevention**: Core layers must never depend on feature modules. Locating `audit.writer.ts` in `src/modules/audit` and re-exporting ensures modular boundary integrity.
  - **Entity Uniformity**: Per DBML, `audit_logs` contains standard `id`, `created_at`, `updated_at`, `deleted_at`, `created_by`, and `updated_by` fields from `AuditableEntity`. The table is strictly append-only; update/delete operations are forbidden at the repository and service layers.
  - **PII Boundary**: When auditing unauthenticated events (e.g., `FAILED_LOGIN`), raw email is preserved in `old_value` for security analysis per AUD-04. However, logger error telemetry sanitizes `oldValue`/`newValue` to avoid leaking sensitive data to external log aggregators.
  - **Non-Throwing Resilience**: `logAudit` catches internal database write failures, logs non-PII operational metadata, and returns `null` so business domain mutations are never aborted by audit write failures.
- **Consequences**:
  - All domain modules audit changes via `logAudit` imported from `src/modules/audit` (or backward-compatible `src/core/audit`).
  - Read access to audit logs is restricted to `SUPER_ADMIN` via `requireRole(UserRole.SUPER_ADMIN)`.
  - Actor relations query only safe public columns (`id`, `name`, `email`) avoiding token version or internal credential exposure.

---

## ADR-019: Strict Role Transition State Machine and Super Admin Immutability

- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: User role changes (`PATCH /api/v1/users/:id/role`) originally allowed transitions across all three platform roles (`SUPER_ADMIN`, `MENTOR`, `MENTEE`), constrained only by the last Super Admin demotion guard and mentor active mentee reassignment. To enforce a structured organizational progression and protect administrative accounts, explicit role transition constraints were mandated: Mentees may only become Mentors, Mentors may only become Super Admins, and Super Admin roles cannot be changed.
- **Options**:
  1. Unrestricted transitions with client-side UI filtering only.
  2. Backend-enforced strict state machine (`ALLOWED_ROLE_TRANSITIONS`) in `users.service.ts` with explicit domain error codes and preflight impact validation.
- **Choice**: Option 2 (Server-enforced transition state machine).
- **Reasons**:
  - **Security & Authorization Safety**: Precludes direct jumps from Mentee to Super Admin and prevents arbitrary role modification of Super Admin accounts.
  - **Single Source of Truth**: The transition matrix in `users.service.ts` governs both the mutation endpoint (`changeRole`) and impact preflight (`getRoleImpact`).
  - **Actionable Error Feedback**: Disallowed transitions throw `400 Bad Request` with structured codes: `INVALID_ROLE_TRANSITION` or `SUPER_ADMIN_ROLE_IMMUTABLE`.
  - **Preserved Safety Invariants**: The prerequisite that active mentor mappings must be reassigned before promotion to Super Admin is fully retained.
- **Consequences**:
  - `ALLOWED_ROLE_TRANSITIONS` dictates valid target roles:
    - `MENTEE` $\rightarrow$ `['MENTOR']` only.
    - `MENTOR` $\rightarrow$ `['SUPER_ADMIN']` only (active mentees must be reassigned first).
    - `SUPER_ADMIN` $\rightarrow$ `[]` (immutable role; no modifications permitted).
  - Preflight `getRoleImpact` flags invalid or immutable queries with `isBlocked: true` and appropriate `blockReason` values.
  - Frontend consumers must align UI dropdowns and action buttons with these rules.

---

## ADR-020: Scheduled Overdue Detection and Deadline Reminder Jobs Architecture

- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Timely tracking of course and topic deadlines requires periodic background checks without impacting HTTP request response times. Scheduled jobs must detect overdue allocations/topics and upcoming deadlines, emit lifecycle events, and integrate into Bull Board for monitoring.
- **Options**:
  1. Ad-hoc in-process timers (`setInterval`) inside the Express server.
  2. Embed business query logic, sliding-window calculations, and event emission directly inside the BullMQ worker processor.
  3. BullMQ scheduler (`upsertJobScheduler`) on an isolated `overdue-jobs` queue with thin worker dispatchers delegating orchestration to `AllocationsService` and `ProgressService`.
- **Choice**: Option 3 (Thin BullMQ worker dispatching to domain services).
- **Reasons**:
  - **Architectural Boundary Integrity**: Keeps business logic, repository queries, calculations, and domain event emissions strictly inside domain service classes (`AllocationsService`, `ProgressService`), preserving the rule that worker files are thin dispatchers.
  - **Repeat-Safe Query Windows**: Upcoming reminders query a bounded 24-hour band (`[now + 24h, now + 48h]`) matching the 24-hour cron period to prevent duplicate reminder events on successive daily runs. Overdue detection bounds checks to newly overdue items (`since = now - 24h`) capped at 1000 items per batch.
  - **Resilience and Explicit Configuration**: Configures BullMQ with explicit retry policies (`attempts: 3`, exponential backoff) and explicit `tz: 'UTC'` to eliminate container timezone drift.
  - **Clean Teardown and Resource Safety**: Centralized job registration cleanly closes existing worker and queue handles before re-registering, wrapping individual resource closures in isolated error boundaries.
- **Consequences**:
  - `overdue-jobs` queue registers `daily-overdue-detection` (cron `0 0 * * *`, UTC) and `daily-deadline-reminders` (cron `0 8 * * *`, UTC).
  - Worker dispatches to `allocationsService.detectOverdueAllocations`, `allocationsService.processDeadlineReminders`, and `progressService.detectOverdueTopics`.
  - Emitted events (`allocation.overdueDetected`, `topic.overdueDetected`, `allocation.reminderDue`) serve as integration points for future notification delivery consumers.

---

## ADR-021: Elimination of Letter Grades in Favor of Quantitative Marks/Scores

- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The LMS system previously supported discrete letter grades (A+, A, B, C, D, F) alongside quantitative performance tracking (`marks`, `maxMarks`, `averageMarks`, `completionPercentage`, `onTimeRate`). Letter grades introduced arbitrary bucket thresholds, non-standard grade distributions, and unnecessary subqueries/complexity in performance repository queries and sorting.
- **Options**:
  1. Maintain dual-model support for both letter grades and numeric marks with configurable grading scales.
  2. Eliminate letter grades entirely across schemas, database queries, DTOs, and CSV exports, establishing numeric scores/percentages as the single source of truth for mentee evaluation.
- **Choice**: Option 2 (Pure quantitative scoring model).
- **Reasons**:
  - **Single Source of Truth**: Eliminates conflicting evaluations where letter grade buckets did not accurately reflect raw mark percentages.
  - **Query & Sorting Simplification**: Removes the `latestSubsQb` subquery and in-memory letter grade ranking lookups from `PerformanceRepository.getMenteePerformanceList`, simplifying queries and boosting performance.
  - **Consistent API Contracts**: Cleaned `sortBy` enums, query filters, metrics overviews, and CSV exports to solely represent numeric performance metrics (`averageMarks`, `completionPercentage`, `onTimeRate`).
- **Consequences**:
  - `gradeRange` filter and `'grade'` sorting parameter are removed from `performanceFilterSchema` and `exportPerformanceSchema`.
  - `GradeDistributionBucket` and `gradeDistribution` metrics are eliminated from `PerformanceOverviewMetrics`.
  - `MenteePerformanceRow.latestGrade` and `LearningHistoryAssignment.gradeLabel` fields are removed from backend DTOs.
  - CSV exports omit the 'Latest Grade' column in favor of exact score and progress numbers.
