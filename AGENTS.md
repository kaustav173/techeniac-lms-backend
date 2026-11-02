# TechEniac LMS Backend - Agent Guidelines

These rules and guidelines apply to all AI agents and developers working on the `TechEniac-lms-backend` repository.

## Branch & Pull Request Rules

### 400-Line Code Change Limit

- **Diff Limit**: Changes in a single branch or Pull Request must not exceed ~400 lines of code.
- **Mandatory User Confirmation**: If a feature, bug fix, or refactoring task requires adding or changing more than 400 lines of code in a single branch, the agent **must ask the user for explicit confirmation** before making or staging those changes, or recommend breaking down the task into smaller, reviewable branches/PRs.

### Feature & Module Branching Protocol (Mandatory Pre-Flight Check)

- **Automatic Pre-Flight Check**: On every prompt requesting a feature, module, or code change (for the user or collaborators), the agent must **never** start modifying code immediately without first verifying the branch strategy.
- **Branch Identification & Permission**: Identify and communicate which branch is required. If a new branch needs to be created (e.g., `feat/<name>`, `fix/<name>`, branched off `dev`), present the branch name and purpose to the user, and obtain explicit user permission before creating the branch or writing any code.
- **Multi-Branch Breakdown for Large Features**: If a feature is large or complex and requires more than one branch (to comply with the ~400-line diff limit or separate concerns like migrations, services, controllers), outline all branches needed from start to finish, present the roadmap, and obtain user approval for the branch plan before starting.
- **Relevant Branch Selection & Verification**: Always ensure that changes are confined strictly to the relevant branch designated for that task.
- **Switch Before Modifying Code**: Before making any file changes or writing any code, verify the current Git branch and ensure switching to the relevant approved branch (requesting user approval for `git switch` or `git checkout`). Never write code on `main`, `staging`, `dev`, or on an unrelated feature branch.

## Non-Negotiable Safety Rules

- **Git Safety**: Never execute state-changing Git/GitHub commands without per-command user approval. Prohibit `git add .`, `git add -A`, `git push --force`, `git reset --hard`, and `--no-verify`.
- **Security**: Never commit, inspect, or log real `.env` contents or credentials.
- **Workflow**: Document architectural choices in `.agent/decisions.md`.

## Database & Entity Architecture Rules

### Mandatory AuditableEntity Inheritance

- **Base Entity**: All database domain entities created in `src/modules/*/entities/*.entity.ts` (or any table entities across the system) **must extend `AuditableEntity`** exported from `src/core/db`.
- **Standard Columns Provided by `AuditableEntity`**:
  - `id`: `uuid` primary key (`@PrimaryGeneratedColumn('uuid')`, PostgreSQL `gen_random_uuid()`)
  - `created_at`: `timestamptz`, not null (managed by `@CreateDateColumn`, default `CURRENT_TIMESTAMP`)
  - `updated_at`: `timestamptz`, not null (managed by `@UpdateDateColumn`, default `CURRENT_TIMESTAMP`)
  - `deleted_at`: `timestamptz`, nullable (managed by `@DeleteDateColumn` for soft delete)
  - `created_by`: `uuid`, nullable (`@Column({ type: 'uuid', nullable: true })` for actor tracking)
  - `updated_by`: `uuid`, nullable (`@Column({ type: 'uuid', nullable: true })` for actor tracking)
- **Prohibition**: Never manually declare duplicate `id`, `created_at`, `updated_at`, `deleted_at`, `created_by`, or `updated_by` fields in individual entity classes. Always inherit from `AuditableEntity`.

## Governance Links

- [GEMINI.md](GEMINI.md)
- [Git Safety Rules](.agent/rules/git-safety.md)
- [Security Rules](.agent/rules/security.md)
- [Architecture Overview](.agent/architecture.md)
- [Development Conventions](.agent/conventions.md)
- [Architecture Decision Records](.agent/decisions.md)
