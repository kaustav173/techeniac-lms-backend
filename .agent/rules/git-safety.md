# Git Safety Rules

These rules are non-negotiable and apply to all agents and automated tools working on `TechEniac-lms-backend`.

## Mandatory Approval for State-Changing Commands

- Every Git or GitHub CLI (`gh`) command that alters repository state (creating commits, modifying branches, switching branches, staging files, pushing, rebasing, stashing, tagging, etc.) requires explicit, per-command user approval.
- Present the exact command string to the user before proposing its execution.

## Prohibited Commands & Flags

- **`git add .` and `git add -A`**: Strictly prohibited. Files must be staged individually by exact file path (e.g. `git add path/to/file.ts`).
- **`git push --force` and `git push -f`**: Strictly prohibited. Force-pushing overrides history and can cause irreversible data loss.
- **`git reset --hard`**: Strictly prohibited. Hard resets destroy uncommitted or unstaged changes.
- **`--no-verify`**: Strictly prohibited. Git hooks and validation checks must never be bypassed.

## Branch Discipline

- Work must never be committed directly to protected branches (`main`, `staging`, `dev`). All changes must be developed on dedicated feature, fix, or chore branches (`feat/*`, `fix/*`, `chore/*`) branched off `dev`.
- Pull Requests must target `dev` with Conventional Commits.
- **Diff Size Limit (<400 Lines) & User Confirmation**: Changes in a single branch or PR must not exceed ~400 lines of code. If a planned implementation or task requires more than 400 lines of code change in a single branch, the agent must ask the user for explicit permission/confirmation before making those changes (or propose splitting them into smaller PRs).
- **Mandatory Branch Pre-Flight Check**: When building any feature or module or implementing changes (for the user or collaborators), the agent must first determine the target branch.
- **Branch Creation Approval**: If a new branch is needed (e.g. `feat/<name>`, `fix/<name>` branched off `dev`), the agent must communicate the branch name and purpose and obtain explicit user permission before creating it or writing code.
- **Multi-Branch Breakdown for Large Features**: If a feature is large and requires multiple branches, the agent must list and plan all necessary branches upfront and obtain user approval for the roadmap before beginning work.
- **Switch to Relevant Branch Before Modifying Code**: Always ensure work occurs strictly on the relevant branch. Verify the branch and switch to it (requesting user approval for `git switch`/`git checkout`) before modifying or writing code. Never make changes on protected branches (`main`, `staging`, `dev`) or unrelated branches.
