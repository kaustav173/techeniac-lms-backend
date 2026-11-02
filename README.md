# TechEniac-lms-backend

## Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- npm (bundled with Node 24)
- Gitleaks (required for pre-commit secret detection: `gitleaks`)

## Setup

```bash
# Ensure Node 24 is active
nvm use

# Install dependencies
npm install

# Initialize Husky git hooks
npm run prepare
```

### Git Hooks

Husky manages automated commit quality gates:

- **`pre-commit`**: Executes `gitleaks git --staged`, followed by `lint-staged` (ESLint and Prettier), and `npm run typecheck`. Fails with actionable instructions if Gitleaks is not found in `PATH`.
- **`commit-msg`**: Validates commit messages using `@commitlint/cli` and Conventional Commits.

## Environment

Copy the example environment template and supply valid local values:

```bash
cp .env.example .env
```

## Run

Available build, lint, and formatting commands:

```bash
# Type check without emitting files
npm run typecheck

# Compile TypeScript to dist/
npm run build

# Lint source files with zero warnings permitted
npm run lint

# Format code with Prettier
npm run format

# Verify formatting without modifying files
npm run format:check
```

## Test

```bash
# Validate custom architecture and TypeScript lint rule fixtures
npm run lint:test-rules
```

_(Automated application test suite coming soon)_

## Migrations

_(Database migration commands coming soon)_

## Troubleshooting

- **Gitleaks missing error on commit**: If Git commit fails with `ERROR: Gitleaks is required for pre-commit verification`, install Gitleaks via your package manager or follow https://github.com/gitleaks/gitleaks#installing.
- **Lint fixtures behavior**: Files under `lint-fixtures/` contain deliberately invalid code to test lint rule enforcement. They are excluded from `npm run lint` and Prettier, and are tested exclusively by `npm run lint:test-rules`.

## Docs

- [Agent Architecture Overview](.agent/architecture.md)
- [Development Conventions](.agent/conventions.md)
- [Architecture Decision Records](.agent/decisions.md)
- [Git Safety Rules](.agent/rules/git-safety.md)
- [Security Rules](.agent/rules/security.md)
