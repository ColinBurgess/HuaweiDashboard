---
name: release-versioning-workflow
description: >-
  Enforces release discipline, Semantic Versioning (SemVer 2.0), CHANGELOG updates, and ROADMAP synchronization for the repository.
  Use this skill whenever the user asks to commit code, prepare a release, bump versions, update documentation for a deployment, or run pre-commit validations before pushing changes.
---

# Release & Versioning Workflow

## Agent Execution Directives

**CRITICAL RULE:** Whenever you are instructed to perform a `git commit` or `git push`, or when functional/bugfix/infrastructure changes have been made, you **MUST** execute the following decision tree before completing the git action.

### Agent Control Loop (Execute sequentially)

1. **Inspect Changes:** Run `git status` and `git diff` to identify modified files.
2. **Local Validation:** Run project health checks (linting, configuration, docker checks). Stop if any fail.
3. **Check CHANGELOG.md:** Ensure all functional changes, fixes, or deprecations are documented under `[Unreleased]` or a new version header.
4. **Check package.json Version:** Determine if a SemVer bump is required. Ensure `package.json` and `CHANGELOG.md` version strings match.
5. **Check ROADMAP.md:** Update progress checkboxes `[x]` if feature milestones were completed.
6. **Formulate Commit Message:** Draft a Conventional Commit message.
7. **Execute Git Actions:** Perform commit (with GPG signing if configured) and push.

---

## Pre-Commit Validation Checklist

Run these commands in the terminal environment before committing functional code:

```bash
# 1. Local Health & Static Analysis
pnpm install --frozen-lockfile
pnpm lint
hadolint Dockerfile
docker-compose config

# 2. Verify Version Consistency
grep '"version"' package.json | head -1
head -20 CHANGELOG.md
```

If any validation command fails, **STOP**, report the error to the user, and do not push.

---

## Semantic Versioning (SemVer 2.0.0) Rules

Determine the version bump based on `package.json`:

| Change Type | SemVer Bump | Example | Trigger Criteria |
|---|---|---|---|
| **Patch** | `0.1.X` | `0.1.2 → 0.1.3` | Bug fixes, minor patches, non-breaking refactors. |
| **Minor** | `0.X.0` | `0.1.8 → 0.2.0` | New features, infrastructure/DevOps milestones. |
| **Major** | `X.0.0` | `0.3.0 → 1.0.0` | Breaking API changes, production release. |

---

## Documentation Standards

### 1. CHANGELOG.md (`Keep a Changelog` Format)

All notable changes must be categorized under one of these standard sections:
- `Added`: New features.
- `Changed`: Behavioral changes to existing features.
- `Fixed`: Bug fixes.
- `Deprecated`: Features marked for future removal.
- `Security`: Vulnerability patches.

**Header Format:**
```markdown
## [X.Y.Z] - YYYY-MM-DD
```
*Dates MUST use ISO 8601 format (`YYYY-MM-DD`).*

### 2. Conventional Commit Format

Commit messages MUST strictly follow this structure:

```text
<type>: <short description in present tense>

<optional body explaining WHY the change was made and technical impact>

Refs: #ticket-number (if applicable)
```

**Allowed Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `ci`, `build`.

---

## Standard Workflows

### Workflow A: Hotfix / Bug Fix (Patch Release)
1. Run local validation suite.
2. Update `CHANGELOG.md`: Create `## [0.1.X] - YYYY-MM-DD` section and list fixes.
3. Update `package.json`: Bump version string to `0.1.X`.
4. Stage and commit:
   ```bash
   git add package.json CHANGELOG.md <changed-files>
   git commit -S -m "fix: critical bug in charger service

   Resolved connection drop issue by increasing timeout interval.

   Closes #123"
   git push
   ```

### Workflow B: Feature Milestone (Minor Release)
1. Run local validation suite.
2. Update `CHANGELOG.md`: Create `## [0.X.0] - YYYY-MM-DD` with `### Added` and `### Changed`.
3. Update `ROADMAP.md`: Mark completed tasks `[x]` and update status section.
4. Update `package.json`: Bump version string to `0.X.0`.
5. Stage and commit:
   ```bash
   git add package.json CHANGELOG.md ROADMAP.md <changed-files>
   git commit -S -m "feat: add prometheus metrics export

   Implements /metrics endpoint and correlation IDs across microservices."
   git push
   ```

### Workflow C: Documentation-Only
- No version bump required in `package.json`.
- Execute:
   ```bash
   git add docs/ ROADMAP.md
   git commit -S -m "docs: update deployment and architecture guides"
   git push
   ```

---

## Stopping Conditions & Anti-Patterns

**DO NOT execute `git push` if any of the following are true:**
- ❌ Local validation commands (`pnpm lint`, `hadolint`, `docker-compose config`) failed.
- ❌ Code changes introduce functional fixes/features but `CHANGELOG.md` was not updated.
- ❌ Version string in `package.json` differs from the top release entry in `CHANGELOG.md`.
- ❌ Commit message is generic (e.g., "fix stuff", "update code", "wip").