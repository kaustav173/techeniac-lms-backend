# TechEniac LMS Backend

TechEniac LMS Backend provides the REST API, domain business logic, and PostgreSQL data persistence for the TechEniac Learning Management System. It is engineered with Node.js 24, Express, TypeScript strict mode, and TypeORM on Neon PostgreSQL.

## Repository Map

- `src/main.ts`: Application bootstrap entry point.
- `src/app.ts`: Core application configuration.
- `src/core/`: Cross-cutting concerns (config, db, errors, health, http, logging, openapi).
- `src/modules/`: Domain feature modules.
- `src/migrations/`: TypeORM schema migrations.
- `tests/`: Integration and unit test suites.
- `.agent/`: Operational guides, architecture decisions, and non-negotiable rules.

## Available Commands

- `npm run typecheck`: Run static type checking via TypeScript compiler (`tsc --noEmit`).
- `npm run build`: Compile TypeScript source code to `dist/`.
- `npm run lint`: Lint source files with ESLint (`--max-warnings 0`).
- `npm run lint:test-rules`: Test ESLint fixtures against expected rule IDs.
- `npm run format`: Format code with Prettier.
- `npm run format:check`: Check code formatting with Prettier.
- `npm run dev`: Run the development server with live reload (`tsx watch src/main.ts`).
- `npm start`: Run the compiled backend application (`node dist/main.js`).
- `npm run migration:run`: Run TypeORM database migrations via direct connection.
- `npm run migration:revert`: Revert the most recently executed migration.
- `npm run migration:generate`: Generate a new migration from entity changes.
- `npm run migration:create`: Create a blank migration file.
- `npm test`: _(coming soon)_ Run automated test suite.

## Non-Negotiable Rules

- **Git Safety**: Never execute state-changing Git/GitHub commands without per-command approval. Prohibit `git add .`, `git add -A`, `git push --force`, `git reset --hard`, and `--no-verify`.
- **Branch Diff Limit (<400 Lines)**: Changes in a single branch or Pull Request must not exceed ~400 lines of code. If a planned implementation or task requires changing or adding more than 400 lines of code in a single branch, the agent must ask the user for explicit confirmation before making those changes.
- **Branch Pre-Flight & Approval Protocol**: Before implementing any feature, module, or change, determine the required branch. If creating a new branch, obtain explicit user approval first. For large features needing multiple branches, outline all required branches and secure approval. Always switch to the relevant branch before editing code.
- **Security**: Never commit, inspect, or log real `.env` contents or credentials.
- **Workflow**: Document architectural choices in `.agent/decisions.md`.
- **Mandatory AuditableEntity**: All domain database entities must extend `AuditableEntity` (`src/core/db`), standardizing UUID primary keys (`gen_random_uuid()`), `created_at`, `updated_at`, soft-delete `deleted_at` timestamps, and `created_by`/`updated_by` actor audit tracking.

## Agent Governance Links

- [Agents Guide](AGENTS.md)
- [Git Safety Rules](.agent/rules/git-safety.md)
- [Security Rules](.agent/rules/security.md)
- [Architecture Overview](.agent/architecture.md)
- [Development Conventions](.agent/conventions.md)
- [Architecture Decision Records](.agent/decisions.md)
