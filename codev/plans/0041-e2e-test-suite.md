# Plan: E2E Test Suite for @cluesmith/codev

## Metadata
- **Spec**: [0041-e2e-test-suite.md](../specs/0041-e2e-test-suite.md)
- **Status**: draft
- **Created**: 2025-12-08
- **Protocol**: SPIR

## Overview

Implement BATS-based end-to-end tests that verify the `@cluesmith/codev` npm package works correctly after installation. Tests run against a local tarball (for PRs) or published package (post-release).

## Phase 1: Test Infrastructure Setup

**Goal**: Create test directory structure and common setup

### Tasks

- [ ] Create `tests/e2e/` directory
- [ ] Create `tests/e2e/helpers.bash` with e2e-specific helpers:
  - `install_codev()` - npm init + npm install $E2E_TARBALL
  - `run_codev()` - wrapper for ./node_modules/.bin/codev
  - `run_af()` - wrapper for ./node_modules/.bin/af
- [ ] Create `tests/e2e/setup_suite.bash`:
  - Verify E2E_TARBALL env var is set
  - Validate tarball exists
- [ ] Create common `setup()` function with XDG sandboxing:
  - Isolated HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME
  - Isolated npm_config_prefix, npm_config_cache
- [ ] Create common `teardown()` function to cleanup TEST_DIR

### Exit Criteria
- `bats tests/e2e/` runs (even with no tests) without error
- XDG sandboxing verified (test doesn't touch real $HOME)

## Phase 2: Installation Tests (TC-001)

**Goal**: Verify package installs correctly and binaries are available

### Tasks

- [ ] Create `tests/e2e/install.bats`
- [ ] Implement tests:
  - `npm install from tarball creates binaries`
  - `codev --version returns expected version`
  - `af --version returns expected version`
  - `consult --help works`
  - `codev unknown-command fails gracefully`

### Exit Criteria
- All installation tests pass
- Version output matches package.json

## Phase 3: codev init Tests (TC-002)

**Goal**: Verify project initialization works correctly

### Tasks

- [ ] Create `tests/e2e/init.bats`
- [ ] Implement tests:
  - `codev init creates project structure`
  - `codev init replaces PROJECT_NAME placeholder`
  - `codev init fails if directory exists`
  - `codev init --yes requires project name`
  - `codev init creates .gitignore with correct entries`
  - `codev init initializes git repository`

### Exit Criteria
- All init tests pass
- Project structure matches expected layout

## Phase 4: codev adopt Tests (TC-003)

**Goal**: Verify adoption into existing projects works

### Tasks

- [ ] Create `tests/e2e/adopt.bats`
- [ ] Implement tests:
  - `codev adopt adds codev to existing project`
  - `codev adopt preserves existing files`
  - `codev adopt is idempotent`

### Exit Criteria
- Adoption tests pass
- Existing files not modified

## Phase 5: codev doctor Tests (TC-004)

**Goal**: Verify dependency checking works

### Tasks

- [ ] Create `tests/e2e/doctor.bats`
- [ ] Implement tests:
  - `codev doctor checks core dependencies`
  - `codev doctor handles missing optional deps gracefully`
  - `codev doctor output includes expected entries`

### Exit Criteria
- Doctor tests pass on macOS and Linux

## Phase 6: af command Tests (TC-005)

**Goal**: Verify agent-farm CLI works

### Tasks

- [ ] Create `tests/e2e/af.bats`
- [ ] Implement tests:
  - `af --help shows available commands`
  - `af status works without running dashboard`
  - `af --version returns version`

### Exit Criteria
- af tests pass in clean environment

## Phase 7: consult Tests (TC-006)

**Goal**: Verify consult subcommand help works

### Tasks

- [ ] Create `tests/e2e/consult.bats`
- [ ] Implement tests:
  - `codev consult --help shows subcommands`
  - `codev consult pr --help shows pr options`

### Exit Criteria
- Consult help tests pass

## Phase 8: CI Workflow - PR Tests

**Goal**: Run e2e tests on every PR against local tarball

### Tasks

- [ ] Create `.github/workflows/e2e.yml`
- [ ] Configure matrix for ubuntu-latest and macos-latest
- [ ] Install BATS on each platform
- [ ] Build package and create tarball
- [ ] Run tests with E2E_TARBALL env var
- [ ] Add to repo's required checks (optional)

### Exit Criteria
- Workflow runs on PRs
- Tests pass on both macOS and Linux

## Phase 9: CI Workflow - Post-Release

**Goal**: Verify published package after npm release

### Tasks

- [ ] Create `.github/workflows/post-release-e2e.yml`
- [ ] Trigger on release published
- [ ] Wait for npm propagation (120s)
- [ ] Download published tarball via `npm pack @cluesmith/codev@version`
- [ ] Run tests against downloaded tarball

### Exit Criteria
- Workflow triggers on releases
- Tests verify published package

## Phase 10: Documentation & Verification

**Goal**: Document how to run tests and verify all works

### Tasks

- [ ] Add "E2E Tests" section to CLAUDE.md
- [ ] Add npm script: `npm run e2e` in packages/codev/package.json
- [ ] Verify tests pass locally on macOS
- [ ] Verify CI workflow passes on a test PR

### Exit Criteria
- Documentation updated
- Full test suite passes

## Implementation Order

```
Phase 1 (Infrastructure) ──> Phase 2 (Install) ──> Phase 3 (Init) ──> Phase 4 (Adopt)
                                    │                                        │
                                    v                                        v
                             Phase 5 (Doctor) ──> Phase 6 (af) ──> Phase 7 (Consult)
                                                                            │
                                                                            v
                                                              Phase 8 (CI-PR) ──> Phase 9 (CI-Release)
                                                                                        │
                                                                                        v
                                                                                 Phase 10 (Docs)
```

Phases 2-7 can be parallelized after Phase 1. Phases 8-9 can be done after any test phase.

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Infrastructure | 30 min |
| Phase 2: Install tests | 20 min |
| Phase 3: Init tests | 20 min |
| Phase 4: Adopt tests | 15 min |
| Phase 5: Doctor tests | 15 min |
| Phase 6: af tests | 15 min |
| Phase 7: Consult tests | 10 min |
| Phase 8: CI-PR workflow | 30 min |
| Phase 9: CI-Release workflow | 20 min |
| Phase 10: Documentation | 15 min |
| **Total** | ~3 hours |

## Testing Requirements

- Run `bats tests/e2e/` locally before each commit
- Verify on both macOS (dev machine) and Linux (Docker or CI)
- Use `E2E_TARBALL` from fresh `npm pack` output

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| BATS version mismatch | Document required version, pin in CI |
| npm pack creates different filename | Use glob pattern `cluesmith-codev-*.tgz` |
| Tests interfere with each other | Strong isolation via setup()/teardown() |
| CI caching issues | Don't cache npm in e2e tests |

## Notes

- All tests use `npm install` not `npx` (per user requirement)
- XDG sandboxing pattern from spec 0001
- Existing `tests/helpers/common.bash` provides assertion helpers
