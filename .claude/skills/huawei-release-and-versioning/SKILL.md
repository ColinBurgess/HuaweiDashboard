# HuaweiDashboard - Release & Versioning Skill

**Purpose**: Ensure proper release discipline, version management, and documentation synchronization across commits.

**Use when**: Making commits with functional changes, bumping versions, or publishing releases.

---

## 🔴 Critical Rule - ALWAYS Apply Before `git commit && git push`

**Any code changes that affect version, features, or fixes MUST trigger this checklist:**

### Pre-Commit Validation Checklist

```
✅ BEFORE pushing code with changes:

1. [ ] LOCAL VALIDATION (run all, no errors):
   - pnpm install --frozen-lockfile
   - pnpm lint
   - hadolint Dockerfile
   - docker-compose config

2. [ ] CHANGELOG UPDATED:
   - Add entry to [Unreleased] section OR
   - Create new version [X.Y.Z] section if bumping version
   - Document features, fixes, breaking changes, deprecations
   - Use Keep a Changelog format (https://keepachangelog.com)

3. [ ] VERSION BUMPED (if applicable):
   - Determine SemVer bump: patch (0.1.X), minor (0.X.0), or major (X.0.0)
   - Update package.json "version" field
   - Match version in CHANGELOG.md header

4. [ ] ROADMAP UPDATED (if applicable):
   - Mark completed features with [x]
   - Move completed items from [In Progress] to [✅ COMPLETE]
   - Link to CHANGELOG.md for release details
   - Update Current Status section if major release

5. [ ] COMMIT MESSAGE (Conventional Commits):
   ```
   <type>: <subject>

   <body - why this change, what problem does it solve>

   Refs: #ticket-number (if applicable)
   ```

   Valid types: feat, fix, docs, chore, refactor, perf, test, ci, build

   **Examples**:
   ```
   feat: add GitHub Actions CI/CD pipeline

   Implement automated validation and multi-arch Docker builds with GHCR publication
   Includes: ESLint, TypeScript type-check, Hadolint, semantic versioning

   Closes #42
   ```

   ```
   docs: update ROADMAP to mark DevOps Phase 1 complete

   - Updated Current Status to v0.1.2
   - All CI/CD features implemented and tested
   - Ready for Phase 2 deployment automation
   ```

6. [ ] PUSH WITH GPG SIGNING:
   git push  # (GPG signing enabled by default via git config)
```

---

## 📋 Version Numbering (SemVer 2.0.0)

**Current Version**: v0.1.8 (see `package.json`)

### When to Bump Version

| Change Type | Bump | Example |
|---|---|---|
| New feature | Minor (0.X.0) | `0.1.0 → 0.2.0` |
| Bug fix | Patch (0.1.X) | `0.1.2 → 0.1.3` |
| Breaking API change | Major (X.0.0) | `1.0.0 → 2.0.0` |
| Infrastructure/DevOps | Minor (0.X.0) | `0.1.2 → 0.2.0` (often grouped with features) |

**Current Release Cycle**:
- `0.1.x` - Alpha phase (foundation features, debugging, DevOps setup)
- `0.2.0` - Stability phase (fix charger comms, add monitoring)
- `0.3.0` - Smart features phase (AI-driven charging)
- `1.0.0` - Production release

---

## 📝 CHANGELOG Format (Keep a Changelog)

### Structure

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
### Added
- New features not yet released

### Changed
- Behavioral changes to existing features

### Fixed
- Bug fixes

### Deprecated
- Features marked for removal in future versions

---

## [0.1.2] - 2026-06-24
### Added
- GitHub Actions CI/CD pipeline (validate + build-and-publish)
- Multi-architecture Docker builds (linux/amd64, linux/arm64)
- GHCR image publication with semantic versioning
- Watchtower integration for automatic image updates

### Changed
- Dockerfile: Use corepack instead of npm
- docker-compose.yml: Reference GHCR images instead of local builds
- pnpm setup: Migrated to official pnpm/action-setup@v4

### Fixed
- pnpm version conflicts (package.json packageManager field)
- Deprecated pnpm configuration (moved to .pnpmrc)

---

## [0.1.1] - 2026-06-19
...
```

### Key Rules
- Use **ISO 8601** dates: `YYYY-MM-DD`
- Group changes by: Added, Changed, Fixed, Deprecated, Removed, Security
- Link to merged pull requests or tickets when applicable
- Keep unreleased changes at top
- One version section per release

---

## 🔄 Common Workflows

### Workflow 1: Hotfix (Patch Release)

```bash
# 1. Make code changes
# 2. Validate locally
pnpm install --frozen-lockfile
pnpm lint
hadolint Dockerfile

# 3. Update CHANGELOG.md
#    - Add new [0.1.3] section at top (below [Unreleased] if it exists)
#    - Move relevant fixes from [Unreleased] to [0.1.3]
#    - Add date in YYYY-MM-DD format

# 4. Bump version in package.json
#    "version": "0.1.2" → "0.1.3"

# 5. Commit with GPG signing
git add CHANGELOG.md package.json
git commit -S -m "fix: critical bug in charger service

Description of what broke and how it's fixed

Closes #123"

# 6. Git automatically pushes with GPG signature
git push
```

### Workflow 2: Feature Release (Minor)

```bash
# 1. Develop feature(s) across multiple commits
# 2. When feature complete, validate locally
pnpm install --frozen-lockfile
pnpm lint
hadolint Dockerfile
docker-compose config

# 3. Update CHANGELOG.md
#    - Create new [0.2.0] section
#    - List all features added in this release
#    - Include "Changed" and "Fixed" if applicable

# 4. Update ROADMAP.md
#    - Mark completed features with [x]
#    - Update "Current Status" section
#    - Link to CHANGELOG.md for details

# 5. Bump version in package.json
#    "version": "0.1.2" → "0.2.0"

# 6. Commit everything together
git add CHANGELOG.md ROADMAP.md package.json
git commit -S -m "feat: add prometheus metrics and structured logging

Implements:
- Prometheus metrics export on /metrics endpoint
- Correlation IDs across all services
- Enhanced dashboard logs view with filtering

References Phase v0.2.0 stability goals"

git push
```

### Workflow 3: Documentation-Only (Docs)

```bash
# No version bump needed
git add ROADMAP.md docs/**
git commit -S -m "docs: update deployment guide for v0.1.2

Add GHCR image references and multi-arch instructions"

git push
```

---

## 🚨 Anti-Patterns (What NOT to Do)

❌ **NEVER**:
- Push code without validating locally first
- Forget to update CHANGELOG when making functional changes
- Have mismatched versions between package.json and CHANGELOG
- Make vague commits like "fix stuff" or "updates"
- Commit to master without GPG signing
- Update ROADMAP/CHANGELOG AFTER push (do before)

❌ **NEVER say**:
- "I'll update the changelog later"
- "This is a small change, doesn't need CHANGELOG"
- "Let me commit first, document later"

---

## ✅ Validation Commands

Keep these quick checks in your terminal history:

```bash
# Full validation suite
pnpm install --frozen-lockfile && pnpm lint && hadolint Dockerfile && docker-compose config

# Quick check of current version
grep '"version"' package.json | head -1

# View current CHANGELOG
head -20 CHANGELOG.md

# Verify git is set to sign commits
git config --global user.signingkey
git config --global commit.gpgsign  # Should be "true"
```

---

## 📌 Integration with Agent Workflows

**When this skill should trigger**:
- User says: "commit these changes", "push to master", "release v0.x.x"
- You detect code changes related to: versioning, features, bugfixes, infrastructure
- Before any `git commit && git push` command

**Action steps for agents**:
1. ✅ Read this skill
2. ✅ Run local validation
3. ✅ Verify CHANGELOG is up-to-date
4. ✅ Verify version matches
5. ✅ Verify ROADMAP reflects current state (if major work)
6. ✅ THEN commit and push

**If something is missing**:
- 🚫 STOP before push
- 📝 Update missing file (CHANGELOG, version, ROADMAP)
- ✅ Commit together
- 🚀 Then push

---

## 🔗 Related Resources

- [Keep a Changelog](https://keepachangelog.com/)
- [Semantic Versioning](https://semver.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [HuaweiDashboard CHANGELOG](../../../CHANGELOG.md)
- [HuaweiDashboard ROADMAP](../../../ROADMAP.md)
