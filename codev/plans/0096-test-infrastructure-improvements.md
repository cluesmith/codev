# Plan: Test Infrastructure Improvements

## Metadata
- **Specification**: `codev/specs/0096-test-infrastructure-improvements.md`
- **Created**: 2026-02-10

## Executive Summary

This plan transforms Codev's test infrastructure from a fragmented multi-framework setup into a unified Vitest + Playwright pipeline with CI enforcement. The work is structured in 6 phases matching the spec's proposed changes: CI for Vitest, fix test classification, migrate BATS to Vitest, add coverage tracking, automate Playwright, and clean up stale tests.

## Success Metrics
- [ ] `npm test` runs clean — no server-spawning tests in default config
- [ ] GH Actions runs Vitest unit tests with coverage on every PR (merge gate)
- [ ] GH Actions runs tower integration tests on every PR
- [ ] GH Actions runs CLI integration tests (migrated from BATS) on every PR
- [ ] GH Actions runs Playwright dashboard tests on every PR
- [ ] BATS framework and tests removed; equivalent coverage in Vitest + verify-install script
- [ ] Coverage report generated and thresholds enforced in CI
- [ ] Playwright tests runnable without manual tower setup (via `webServer`)
- [ ] No test files referencing "spider" (old protocol name)
- [ ] `*.e2e.test.ts` naming convention prevents future test classification leaks

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Fix Test Classification"},
    {"id": "phase_2", "title": "CI for Vitest Unit + Tower Integration"},
    {"id": "phase_3", "title": "Coverage Tracking"},
    {"id": "phase_4", "title": "Migrate BATS to Vitest"},
    {"id": "phase_5", "title": "Automate Playwright in CI"},
    {"id": "phase_6", "title": "Clean Up Stale Tests + Remove BATS"}
  ]
}
```

## Phase Breakdown

### Phase 1: Fix Test Classification
**Dependencies**: None

#### Objectives
- Establish `*.e2e.test.ts` naming convention for all server-spawning tests
- Fix `bugfix-202-stale-temp-projects.test.ts` leaking into unit suite
- Update vitest configs to use pattern-based inclusion/exclusion

#### Deliverables
- [ ] Rename 5 tower integration tests to `*.e2e.test.ts` suffix
- [ ] Add `**/*.e2e.test.ts` exclusion to `vitest.config.ts`
- [ ] Update `vitest.e2e.config.ts` to use `**/*.e2e.test.ts` pattern instead of explicit file list
- [ ] Verify `npm test` passes without spawning any servers

#### Implementation Details

**Files to rename** (in `packages/codev/src/agent-farm/__tests__/`):
- `tower-baseline.test.ts` → `tower-baseline.e2e.test.ts`
- `tower-api.test.ts` → `tower-api.e2e.test.ts`
- `tower-terminals.test.ts` → `tower-terminals.e2e.test.ts`
- `cli-tower-mode.test.ts` → `cli-tower-mode.e2e.test.ts`
- `bugfix-202-stale-temp-projects.test.ts` → `bugfix-202-stale-temp-projects.e2e.test.ts`

**`vitest.config.ts` changes** — replace individual file exclusions with convention:
```typescript
exclude: [
  '**/node_modules/**',
  '**/dist/**',
  '**/e2e/**',
  '**/*.e2e.test.ts',          // Convention: server-spawning tests
  '**/dashboard/__tests__/**',
  '**/worktrees/**',
  '**/.builders/**',
]
```

**`vitest.e2e.config.ts` changes** — replace explicit file list with pattern:
```typescript
include: [
  'src/commands/porch/__tests__/e2e/**/*.test.ts',
  'src/**/*.e2e.test.ts',      // All files following convention
]
```

#### Acceptance Criteria
- [ ] `npm test` completes with 0 server-spawning tests
- [ ] `npm run test:e2e` still includes all tower integration tests + porch e2e
- [ ] No import path changes needed (renames are file-level only)

#### Test Plan
- **Verification**: Run `npm test` and confirm no hanging/long-running tests
- **Verification**: Run `npx vitest run --config vitest.e2e.config.ts --reporter=verbose 2>&1 | head -30` to confirm e2e config picks up renamed files

#### Rollback Strategy
Rename files back and restore original config.

---

### Phase 2: CI for Vitest Unit + Tower Integration
**Dependencies**: Phase 1 (test classification must be clean first)

#### Objectives
- Add GH Actions workflow for Vitest unit tests on every PR
- Add GH Actions job for tower integration tests on every PR
- Make unit tests a merge gate

#### Deliverables
- [ ] New `.github/workflows/test.yml` workflow file
- [ ] Unit test job (fast, ~5s)
- [ ] Integration test job (builds first, ~60s)

#### Implementation Details

**New file**: `.github/workflows/test.yml`

```yaml
name: Tests
on:
  pull_request:
  push:
    branches: [main]

jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
        working-directory: packages/codev
      - run: npx vitest run
        working-directory: packages/codev

  integration:
    name: Tower Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
        working-directory: packages/codev
      - run: npm run build
        working-directory: packages/codev
      - run: npx vitest run --config vitest.e2e.config.ts --exclude 'src/commands/porch/__tests__/e2e/**'
        working-directory: packages/codev
```

Note: The integration job excludes porch e2e tests (too expensive for CI). Only tower integration tests run.

#### Acceptance Criteria
- [ ] Unit test job passes in CI
- [ ] Integration test job passes in CI
- [ ] Failed tests block PR merge

#### Test Plan
- **Manual**: Push branch and verify workflow runs on the PR
- **Verification**: Check that porch e2e tests are NOT included in the integration job

#### Rollback Strategy
Delete the workflow file.

---

### Phase 3: Coverage Tracking
**Dependencies**: Phase 2 (CI must exist to enforce thresholds)

#### Objectives
- Add `@vitest/coverage-v8` for code coverage measurement
- Set conservative thresholds (70% lines, 60% branches)
- Enforce thresholds in CI

#### Deliverables
- [ ] Install `@vitest/coverage-v8` dev dependency
- [ ] Add coverage configuration to `vitest.config.ts`
- [ ] Update CI workflow to run with `--coverage`

#### Implementation Details

**Install dependency**:
```bash
cd packages/codev && npm install -D @vitest/coverage-v8
```

**`vitest.config.ts` additions**:
```typescript
test: {
  // ... existing config ...
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    thresholds: {
      lines: 70,
      branches: 60,
    },
    exclude: [
      '**/dist/**',
      '**/e2e/**',
      '**/__tests__/**',
      '**/dashboard/**',
      '**/*.e2e.test.ts',
    ],
  },
}
```

**Update `.github/workflows/test.yml` unit job**:
```yaml
- run: npx vitest run --coverage
```

#### Acceptance Criteria
- [ ] `npm test -- --coverage` produces coverage report
- [ ] Coverage thresholds are enforced (build fails if below)
- [ ] CI enforces coverage on every PR

#### Test Plan
- **Verification**: Run `npx vitest run --coverage` locally and check report
- **Verification**: Confirm thresholds are realistic (not failing on current codebase)

#### Risks
- **Thresholds too high**: Start at 70%/60%, can ratchet up later
- **Mitigation**: Run coverage locally first to verify current baseline

---

### Phase 4: Migrate BATS to Vitest
**Dependencies**: Phase 1 (naming convention), Phase 2 (CI to run the new tests)

#### Objectives
- Rewrite all BATS e2e tests as Vitest CLI integration tests
- Create `verify-install.mjs` script for post-release verification
- Maintain full test coverage parity with BATS

#### Deliverables
- [ ] `packages/codev/src/__tests__/cli/init.e2e.test.ts` — migrated from `tests/e2e/init.bats`
- [ ] `packages/codev/src/__tests__/cli/adopt.e2e.test.ts` — migrated from `tests/e2e/adopt.bats`
- [ ] `packages/codev/src/__tests__/cli/doctor.e2e.test.ts` — migrated from `tests/e2e/doctor.bats`
- [ ] `packages/codev/src/__tests__/cli/af.e2e.test.ts` — migrated from `tests/e2e/af.bats`
- [ ] `packages/codev/src/__tests__/cli/consult.e2e.test.ts` — migrated from `tests/e2e/consult.bats`
- [ ] `packages/codev/src/__tests__/cli/install.e2e.test.ts` — migrated from `tests/e2e/install.bats`
- [ ] `packages/codev/src/__tests__/cli/helpers.ts` — shared test utilities (XDG sandboxing, install helpers)
- [ ] `packages/codev/scripts/verify-install.mjs` — post-release install verification
- [ ] Add CLI integration job to `.github/workflows/test.yml`

#### Implementation Details

**Test pattern**: Each BATS file maps 1:1 to a Vitest file. Tests use `execa` to run `node dist/codev.js` (built artifact, not source).

**Shared helpers** (`src/__tests__/cli/helpers.ts`):
- `setupCliEnv()` — creates temp dir with XDG sandboxing (replicates BATS `setup_e2e_env`)
- `teardownCliEnv()` — cleans up temp dir
- `installCodev()` — runs `npm init -y && npm install <tarball>` in temp dir
- `runCodev(...args)` — runs `node dist/codev.js` with execa
- `runAf(...args)` — runs `node dist/af.js` with execa
- `runConsult(...args)` — runs `node dist/consult.js` with execa

**Key migration decisions**:
- Tests run `node dist/codev.js` (built artifact) to test the real CLI, not source imports
- XDG sandboxing via env overrides (HOME, XDG_CONFIG_HOME, etc.) — same as BATS
- `realpathSync` for macOS `/var` → `/private/var` normalization
- Tests that need `sqlite3` CLI (af stale state tests) use the `better-sqlite3` npm package instead

**`verify-install.mjs`**: Standalone script that `npm pack` → `npm install -g` → verifies binaries. Used by `post-release-e2e.yml` to replace BATS install verification.

**CI addition** (new job in `test.yml`):
```yaml
  cli:
    name: CLI Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
        working-directory: packages/codev
      - run: npm run build
        working-directory: packages/codev
      - run: npx vitest run src/__tests__/cli/
        working-directory: packages/codev
```

**Update `e2e.yml` workflow**: Replace BATS execution with the new Vitest CLI tests. Keep matrix (ubuntu + macOS). Remove BATS install step.

**Update `post-release-e2e.yml`**: Replace BATS execution with `node scripts/verify-install.mjs`.

#### Acceptance Criteria
- [ ] All BATS test behaviors have Vitest equivalents
- [ ] CLI integration tests pass locally: `npx vitest run src/__tests__/cli/`
- [ ] `verify-install.mjs` passes locally: `npm pack && node scripts/verify-install.mjs cluesmith-codev-*.tgz`
- [ ] e2e.yml workflow uses Vitest instead of BATS
- [ ] post-release-e2e.yml uses verify-install.mjs instead of BATS

#### Test Plan
- **Parity check**: Count tests in BATS vs Vitest to ensure no gaps
- **Local run**: `npm run build && npx vitest run src/__tests__/cli/`
- **Cross-platform**: Verify on macOS (primary dev environment)

#### Risks
- **sqlite3 CLI dependency**: BATS af tests use `sqlite3` CLI directly. Vitest tests should use `better-sqlite3` (already a project dependency) or `execa` to call sqlite3.
- **Mitigation**: Use `better-sqlite3` for database setup in tests.

---

### Phase 5: Automate Playwright in CI
**Dependencies**: Phase 2 (CI workflow exists)

#### Objectives
- Configure Playwright to auto-start tower via `webServer`
- Add Playwright job to CI workflow
- Eliminate need for manual tower startup

#### Deliverables
- [ ] Update `playwright.config.ts` with `webServer` configuration
- [ ] Add Playwright job to `.github/workflows/test.yml`

#### Implementation Details

**`playwright.config.ts` update**:
```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src/agent-farm/__tests__/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.TOWER_TEST_PORT || '14100'}`,
  },
  webServer: {
    command: `node dist/agent-farm/servers/tower-server.js ${process.env.TOWER_TEST_PORT || '14100'}`,
    port: Number(process.env.TOWER_TEST_PORT || '14100'),
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

Port 14100 avoids conflicts with dev tower (4100-4200 range). `reuseExistingServer: true` means locally it can coexist with a running dev tower.

**CI addition** (new job in `test.yml`):
```yaml
  playwright:
    name: Dashboard Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
        working-directory: packages/codev
      - run: npm run build
        working-directory: packages/codev
      - run: npx playwright install chromium
        working-directory: packages/codev
      - run: npx playwright test
        working-directory: packages/codev
```

#### Acceptance Criteria
- [ ] `npx playwright test` works without manually starting tower
- [ ] Playwright CI job passes
- [ ] Port 14100 doesn't conflict with dev tower

#### Test Plan
- **Local**: Run `npm run build && npx playwright test` (no prior tower startup)
- **CI**: Verify job passes on PR

#### Risks
- **Tower server path**: `dist/agent-farm/servers/tower-server.js` must exist and accept port as argument. Need to verify this path.
- **Mitigation**: Check tower server entry point and argument handling before implementing.

---

### Phase 6: Clean Up Stale Tests + Remove BATS
**Dependencies**: Phase 4 (BATS migration complete)

#### Objectives
- Remove all BATS framework files and vendored libraries
- Remove stale root-level BATS tests
- Remove BATS-related package.json scripts
- Final verification that all test suites pass

#### Deliverables
- [ ] Delete `tests/lib/bats-core/`, `tests/lib/bats-support/`, `tests/lib/bats-assert/`, `tests/lib/bats-file/`
- [ ] Delete `tests/e2e/*.bats`, `tests/e2e/helpers.bash`, `tests/e2e/setup_suite.bash`
- [ ] Delete `tests/helpers/common.bash`, `tests/helpers/mock_mcp.bash`
- [ ] Delete `tests/00_framework.bats` through `tests/03_test_helpers.bats` (framework self-tests)
- [ ] Delete `tests/10_fresh_spider.bats` (references dead "spider" protocol)
- [ ] Delete `tests/12_existing_claude_md.bats` (covered by init/adopt Vitest tests)
- [ ] Delete `tests/20_claude_execution.bats` (Claude CLI isolation, no longer relevant)
- [ ] Remove `test:e2e:bats` script from `packages/codev/package.json`
- [ ] Clean up empty `tests/` directory if fully empty

#### Implementation Details

**Deletion order**: Delete BATS files first, then vendored libraries, then helpers, then empty directories.

**Package.json cleanup**: Remove `test:e2e:bats` script entry.

**Verification**: After cleanup, run all test suites to confirm nothing is broken:
```bash
npm test                          # Unit tests
npm run test:e2e                  # Tower integration + porch e2e
npx vitest run src/__tests__/cli/ # CLI integration
npx playwright test               # Dashboard tests
```

#### Acceptance Criteria
- [ ] No `.bats` files remain in repository
- [ ] No `tests/lib/bats-*` directories remain
- [ ] All test suites pass after cleanup
- [ ] No references to "spider" in test files
- [ ] `package.json` has no BATS-related scripts

#### Test Plan
- **Verification**: `find . -name "*.bats" | grep -v node_modules` returns empty
- **Verification**: All test suites pass

#### Rollback Strategy
Git revert to restore deleted files.

---

## Dependency Map
```
Phase 1 (Fix Classification) ──→ Phase 2 (CI Workflow) ──→ Phase 3 (Coverage)
                              └──→ Phase 4 (Migrate BATS) ──→ Phase 6 (Remove BATS)
                              └──→ Phase 5 (Playwright CI) ─┘
```

Phase 1 is the foundation. Phases 2-5 depend on Phase 1. Phase 6 depends on Phase 4.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Coverage thresholds fail on current code | Medium | Low | Start at 70%/60%, check baseline first |
| Tower server doesn't accept port as CLI arg | Low | Medium | Verify server entry point before Phase 5 |
| BATS tests cover edge cases not replicated | Low | Medium | Systematic 1:1 test mapping with parity check |
| CI time budget too high | Low | Low | All jobs run in parallel; total wall time ~2-3 min |

## Validation Checkpoints
1. **After Phase 1**: `npm test` runs clean (no server tests)
2. **After Phase 2**: CI workflow passes on PR
3. **After Phase 3**: Coverage report generated in CI
4. **After Phase 4**: All BATS tests have Vitest equivalents, CI passes
5. **After Phase 5**: Playwright runs in CI without manual setup
6. **After Phase 6**: Zero BATS files remain, all suites green
