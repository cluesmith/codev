# RELEASE Protocol

> **Important**: This protocol is **specific to the Codev project itself**. It lives only in `codev/protocols/` and is intentionally NOT included in `codev-skeleton/`. It serves as an example of how projects can create custom protocols tailored to their specific needs.

> **Role**: This protocol is executed by the **Architect**, not by Builders. Releases are high-level coordination tasks that should not be delegated to isolated worktrees.

The RELEASE protocol is used when preparing a new version of Codev for publication to npm.

## When to Use

Use RELEASE when:
- A set of features has been integrated and validated
- You're ready to publish a new npm package version
- The projectlist shows no work in `implementing`, `implemented`, or `committed` status

## Pre-Release Checklist

### 1. Pre-flight Checks

```bash
# Ensure everything is committed and pushed
git status
git push

# Verify no running builders
afx status

# Check for incomplete work
grep -E "status: (implementing|implemented|committed)" codev/projectlist.md
```

**Stop if**: There are uncommitted changes, running builders, or incomplete projects.

### 2. Run MAINTAIN Cycle

Execute the MAINTAIN protocol to ensure:
- Dead code is removed
- Documentation is current (arch.md, lessons-learned.md)
- CLAUDE.md and AGENTS.md are in sync

```bash
# Review what MAINTAIN will do
cat codev/protocols/maintain/protocol.md
```

### 3. Run E2E Tests

```bash
bats tests/e2e/
```

**Stop if**: Any tests fail. Fix issues before proceeding.

### 4. Update Version and Tag

**Normal releases — use lockstep bump.** Run `pnpm bump-version` from the repo root to set every publishable package (`@cluesmith/codev`, `@cluesmith/codev-core`, `@cluesmith/codev-types`, and the VS Code extension) to the same version in one shot. This keeps every workspace package on the same version, preventing the class of drift bug where a release ships pointing at outdated internal dependencies and end users hit runtime API mismatches.

For VS Code stable releases the script delegates to `scripts/bump-vscode.sh` (also exposed as `pnpm bump-vscode-version` for standalone use), which bumps the extension manifest **and** renames `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` in `packages/vscode/CHANGELOG.md` so the Marketplace listing reflects the new version. No fresh `[Unreleased]` heading is inserted — the next PR with notes adds one back. Skipped for pre-release versions (vscode is skipped entirely then). Use `pnpm bump-vscode-version` directly when shipping a vscode-only patch outside the lockstep cadence.

The script anchors on the root `package.json`'s current version (Vue/Babel pattern) and accepts several invocation forms:

| Command | Effect |
|---|---|
| `pnpm bump-version` | **Default** — patch bump from the current root version (e.g. `3.0.2` → `3.0.3`) |
| `pnpm bump-version patch` | Same as no-arg |
| `pnpm bump-version minor` | Minor bump (e.g. `3.0.2` → `3.1.0`) |
| `pnpm bump-version major` | Major bump (e.g. `3.0.2` → `4.0.0`) |
| `pnpm bump-version 3.1.0-rc.1` | Explicit version (use for RCs; pre-release versions auto-skip `packages/vscode` because the VS Code Marketplace rejects pre-release suffixes) |

Replace `X.Y.Z` below with the version the script just wrote (it prints it as `Bumped … → X.Y.Z`).

```bash
pnpm bump-version            # or: pnpm bump-version minor / major / 3.1.0-rc.1

# Commit and tag (root package.json is the version anchor — Vue/Babel pattern)
git add package.json packages/codev/package.json packages/core/package.json packages/types/package.json packages/vscode/package.json pnpm-lock.yaml
git commit -m "Release @cluesmith/codev@X.Y.Z (Codename)"
git tag -a vX.Y.Z -m "vX.Y.Z Codename - Brief description"
git push && git push origin vX.Y.Z
```

**Backport path (single-package patch on a release branch)** — use `pnpm version` directly:

```bash
cd packages/codev

# Bump version (choose one)
pnpm version patch --no-git-tag-version  # Bug fixes only
pnpm version minor --no-git-tag-version  # New features
pnpm version major --no-git-tag-version  # Breaking changes

# Commit and tag
cd ../..
git add packages/codev/package.json pnpm-lock.yaml
git commit -m "Release @cluesmith/codev@X.Y.Z (Codename)"
git tag -a vX.Y.Z -m "vX.Y.Z Codename - Brief description"
git push && git push origin vX.Y.Z
```

### 5. Write Release Notes

Create `docs/releases/vX.Y.Z.md`:

```markdown
# vX.Y.Z Codename

Released: YYYY-MM-DD

## Summary

Brief overview of this release.

## New Features

- **0053 - Feature Name**: Description
- **0054 - Feature Name**: Description

## Improvements

- Item 1
- Item 2

## Breaking Changes

- None (or list them)

## Migration Notes

- None required (or list steps)

## Contributors

- Human + AI collaboration via Codev
```

### 6. Create GitHub Release

```bash
gh release create vX.Y.Z --title "vX.Y.Z Codename" --notes-file docs/releases/vX.Y.Z.md
```

### 7. Publish to npm

`@cluesmith/codev` has runtime dependencies on workspace packages (`@cluesmith/codev-core`, `@cluesmith/codev-types`). Those must be on npm **before** the main package, or `npm install -g @cluesmith/codev` will fail with E404. The VS Code extension (`packages/vscode`) also imports from these packages at runtime.

Use pnpm filters to publish the workspace deps first, then the main package. `pnpm publish` is idempotent — it skips versions already on the registry, so re-running is safe.

```bash
# 1. Publish workspace dependencies (skips already-published versions)
pnpm publish --filter '@cluesmith/codev-core' --filter '@cluesmith/codev-types' --no-git-checks --access public

# 2. Publish the main package with the appropriate tag
cd packages/codev && pnpm publish --no-git-checks            # stable → tag latest
# OR
cd packages/codev && pnpm publish --tag next --no-git-checks # RC → tag next
```

**When to bump workspace dep versions:** unnecessary if step 4 used `pnpm bump-version` (lockstep already bumped core and types). If you took the backport path and `packages/core/src/**` or `packages/types/src/**` changed since the last release, bump that package's version (`pnpm --filter @cluesmith/codev-core version patch`) before publishing — otherwise the publish step will skip it (existing version) and consumers will get the old code.

**Verification:** the `Post-Release E2E Verification` GitHub Actions workflow (triggered automatically on release) installs the published tarball on macOS and Ubuntu. If it fails with E404 on a `@cluesmith/*` package, that workspace dep is missing from npm — publish it and re-run the workflow with `gh workflow run "Post-Release E2E Verification" -f version=X.Y.Z`.

### 8. Post to Discussion Forum

Announce the release in GitHub Discussions (Announcements category):

```bash
gh api graphql -f query='
mutation {
  createDiscussion(input: {
    repositoryId: "R_kgDOPzIlIw",
    categoryId: "DIC_kwDOPzIlI84CwZYV",
    title: "vX.Y.Z Codename Released",
    body: "<release notes content>"
  }) {
    discussion {
      url
    }
  }
}'
```

Include: summary, new features, breaking changes, migration notes, and install command.

### 9. Update projectlist.md

Update the releases section to mark the new release and assign integrated projects:

```yaml
releases:
  - version: "vX.Y.Z"
    name: "Codename"
    status: released
    target_date: "YYYY-MM-DD"
    notes: "Brief description"
```

## Release Naming Convention

Codev releases are named after **great examples of architecture** from around the world:

| Version | Codename | Inspiration |
|---------|----------|-------------|
| 1.0.0 | Alhambra | Moorish palace complex in Granada, Spain |
| 1.1.0 | Bauhaus | German art school, functional modernism |
| 1.2.0 | Cordoba | Great Mosque of Cordoba, Spain |
| 1.3.0 | Doric | Ancient Greek column order, simplicity |

Future releases continue this tradition, drawing from architectural wonders across cultures and eras.

## Semantic Versioning

- **Major** (X.0.0): Breaking changes, major new capabilities
- **Minor** (0.X.0): New features, backward compatible
- **Patch** (0.0.X): Bug fixes only

## Release Candidate (RC) Workflow

Starting with v1.7.0, minor releases use a release candidate workflow for testing before stable release.

### npm Dist-Tags

| Tag | Purpose | Install Command |
|-----|---------|-----------------|
| `latest` | Stable releases (1.6.0, 1.7.0) | `npm install @cluesmith/codev` |
| `next` | Release candidates | `npm install @cluesmith/codev@next` |

**Key behavior**: `npm install @cluesmith/codev` only installs stable versions. RCs are never installed unless explicitly requested.

### RC Publishing

```bash
# Set version to RC. bump-all.sh auto-skips packages/vscode for pre-release
# versions (VS Code Marketplace rejects semver pre-release suffixes), so only
# codev, core, and types are bumped here. vscode catches up at RC → stable.
pnpm bump-version 1.7.0-rc.1

# Commit and tag (note: no packages/vscode/package.json — it wasn't bumped)
git add package.json packages/codev/package.json packages/core/package.json packages/types/package.json pnpm-lock.yaml
git commit -m "v1.7.0-rc.1"
git tag -a v1.7.0-rc.1 -m "v1.7.0-rc.1 - Release candidate"
git push && git push origin v1.7.0-rc.1

# Publish workspace deps first, then main package (see step 7 above for full details)
pnpm publish --filter '@cluesmith/codev-core' --filter '@cluesmith/codev-types' --no-git-checks --access public
cd packages/codev && pnpm publish --tag next --no-git-checks
```

### RC → Stable Promotion

When an RC is validated and ready for stable release:

```bash
# Bump to stable version (lockstep)
pnpm bump-version 1.7.0

# Follow standard release process (steps 4-9 above)
```

### Branch Strategy

```
main branch (active development)
    │
    ├── v1.6.0 ────────────────────────────────► npm @latest
    │       │
    │       └── release/1.6.x (created when 1.7.0 ships)
    │               │
    │               └── v1.6.1 (backport) ─────► npm @latest
    │
    ├── v1.7.0-rc.1 ───────────────────────────► npm @next
    ├── v1.7.0-rc.2 ───────────────────────────► npm @next
    └── v1.7.0 ────────────────────────────────► npm @latest
```

### Backporting Bug Fixes

When a bug is found in a stable release after a newer minor version ships:

```bash
# Create release branch from the stable tag (if not exists)
git checkout -b release/1.6.x v1.6.0

# Cherry-pick or implement the fix
git cherry-pick <commit-hash>

# Bump patch version
cd packages/codev
pnpm version patch --no-git-tag-version

# Commit, tag, and publish
cd ../..
git add packages/codev/package.json pnpm-lock.yaml
git commit -m "v1.6.1 - Backport: <fix description>"
git tag -a v1.6.1 -m "v1.6.1 - Backport fix"
git push origin release/1.6.x && git push origin v1.6.1

# Publish workspace deps first, then main package (see step 7 above for full details)
pnpm publish --filter '@cluesmith/codev-core' --filter '@cluesmith/codev-types' --no-git-checks --access public
cd packages/codev && pnpm publish --no-git-checks
```

### When to Use RCs

- **Use RCs** for minor releases (1.7.0, 1.8.0) - allows testing before stable
- **Skip RCs** for patch releases (1.6.1, 1.6.2) - bug fixes go direct to stable
- **Skip RCs** for the current release (1.6.0) - already at stable cadence
