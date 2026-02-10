---
approved: 2026-02-09
validated: [gemini, codex, claude]
---

# Spec 0096: Test Infrastructure Improvements

## Status: Approved

## Problem

Codev's test infrastructure has grown organically across four frameworks (Vitest, BATS, Playwright, porch e2e) without a coherent strategy. Several issues have accumulated:

1. **BATS is a legacy artifact**. BATS was introduced when Codev was a collection of bash scripts. Now that the CLI is TypeScript, BATS adds a separate framework, vendored libraries (`tests/lib/bats-core/`, `bats-support/`, `bats-assert/`), bash helpers, and platform-specific CI setup — all to test what Vitest could test directly by importing and calling the same CLI functions.

2. **CI only runs BATS**. The GH Actions `e2e.yml` workflow only runs BATS tests. Vitest unit tests (600+ tests) don't run in CI at all. A PR can merge with broken unit tests.

3. **No coverage tracking**. No `@vitest/coverage` configured. No thresholds. No visibility into what's tested.

4. **Tower integration tests leak into unit suite**. `bugfix-202-stale-temp-projects.test.ts` spawns a real tower but isn't in the e2e exclusion list, causing failures when running `npm test`.

5. **Playwright tests require manual setup**. Tower must be started manually before running. Not in CI. Easy to forget.

6. **Stale BATS tests**. `10_fresh_spider.bats` references the pre-rename "spider" protocol. Framework self-tests (`00-03`) test BATS itself, not Codev.

7. **Test organization is inconsistent**. Some tests live in `src/__tests__/`, others in `src/agent-farm/__tests__/`, bugfix regression tests are scattered alongside unit tests, and e2e tests are in a nested `e2e/scenarios/` directory.

## Goals

1. **Vitest in CI**: Unit tests must run on every PR as a merge gate.
2. **Retire BATS**: Migrate valuable BATS tests to Vitest, remove BATS framework.
3. **Coverage tracking**: Add `@vitest/coverage-v8` with a minimum threshold, enforced in CI.
4. **Fix test classification**: All tests that spawn servers should be in the e2e config. Prevent future leaks via naming convention.
5. **Automate Playwright**: Tower auto-start via playwright config's `webServer`, with build prerequisite.
6. **Clean up stale tests**: Remove or update tests referencing dead concepts.

## Non-Goals

- Achieving 100% coverage. Aim for 80% lines as a floor.
- Replacing porch e2e tests (they're already Vitest-based in `src/commands/porch/__tests__/e2e/scenarios/`, testing real AI interactions — no substitute exists).
- Adding load/stress testing (not needed at current scale).

## What Runs Where

| Suite | Where | When | Time | Cost |
|-------|-------|------|------|------|
| **Vitest unit** (~600 tests) | CI + local | Every PR, push to main | ~5s | Free |
| **Vitest unit + coverage** | CI | Every PR (merge gate) | ~10s | Free |
| **Tower integration** (~200 tests) | CI + local | Every PR, push to main | ~60s | Free |
| **CLI integration** (migrated from BATS) | CI + local | Every PR, push to main | ~30s | Free |
| **Playwright dashboard** (~30 tests) | CI + local | Every PR, push to main | ~30s | Free |
| **Porch e2e** (~70 tests, AI) | Local only | Before releases, after porch changes | ~40 min | ~$4/run |
| **Post-release install** | CI | After npm publish | ~2 min | Free |

Everything except porch e2e runs in CI. Porch e2e is too expensive/slow.

## Proposed Changes

### Phase 1: CI for Vitest unit tests + tower integration

Add a GH Actions workflow that runs both unit tests and tower integration tests on every PR and push to main. This is the highest-impact, lowest-effort change.

```yaml
# .github/workflows/test.yml
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
      - run: npm test -- --coverage
        working-directory: packages/codev

  integration:
    name: Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
        working-directory: packages/codev
      - run: npm run build
        working-directory: packages/codev
      - run: npm run test:e2e
        working-directory: packages/codev
```

### Phase 2: Fix test classification

**Immediate fix**: Add `**/bugfix-202-stale-temp-projects.test.ts` to `vitest.config.ts` exclusions and `vitest.e2e.config.ts` includes.

**Naming convention to prevent future leaks**: Tests that spawn servers or need `dist/` must use the `.e2e.test.ts` suffix. Update `vitest.config.ts` to exclude `**/*.e2e.test.ts` globally.

```typescript
// vitest.config.ts
exclude: [
  '**/node_modules/**',
  '**/dist/**',
  '**/e2e/**',
  '**/*.e2e.test.ts',     // Convention: server-spawning tests
  '**/dashboard/__tests__/**',
  '**/.builders/**',
]
```

Rename existing server-spawning tests:
- `tower-baseline.test.ts` → `tower-baseline.e2e.test.ts`
- `tower-api.test.ts` → `tower-api.e2e.test.ts`
- `tower-terminals.test.ts` → `tower-terminals.e2e.test.ts`
- `cli-tower-mode.test.ts` → `cli-tower-mode.e2e.test.ts`
- `bugfix-202-stale-temp-projects.test.ts` → `bugfix-202-stale-temp-projects.e2e.test.ts`

Update `vitest.e2e.config.ts` to include `**/*.e2e.test.ts` instead of listing files by name.

### Phase 3: Migrate BATS to Vitest

The BATS tests do two things Vitest can also do:

**a) CLI integration tests** (init, adopt, doctor, af, consult)

Location: `packages/codev/src/__tests__/cli/` — a dedicated subdirectory to avoid mixing with existing unit tests. Files use `*.e2e.test.ts` suffix.

These tests must replicate BATS's tarball-based testing to preserve packaging integrity checking:

```typescript
// packages/codev/src/__tests__/cli/init.e2e.test.ts
import { execa } from 'execa';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Path to the built binary (from npm run build, not source)
const CODEV_BIN = resolve(import.meta.dirname, '../../../dist/codev.js');

describe('codev init (CLI)', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'codev-cli-test-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates codev/ directory', async () => {
    await execa('node', [CODEV_BIN, 'init'], { cwd: dir });
    expect(existsSync(join(dir, 'codev'))).toBe(true);
  });

  it('creates CLAUDE.md', async () => {
    await execa('node', [CODEV_BIN, 'init'], { cwd: dir });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
  });
});
```

Key differences from the naive approach:
- Runs `node dist/codev.js` (built artifact), not a PATH-resolved `codev` binary
- Uses `realpathSync` for macOS `/var` → `/private/var` normalization
- Temp directory cleanup in `afterEach`
- XDG isolation via `env` overrides where needed (replicating BATS `setup_e2e_env`)

**b) Install/packaging verification** (install.bats)

Location: `packages/codev/scripts/verify-install.mjs`

This script replicates what BATS `install.bats` does: `npm pack` → `npm install -g` in a temp prefix → verify binaries exist and run. Used by `post-release-e2e.yml`.

```javascript
// packages/codev/scripts/verify-install.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = mkdtempSync(join(tmpdir(), 'codev-install-verify-'));
try {
  // Install from tarball (or published package)
  const tarball = process.argv[2]; // Pass tarball path or package name
  execSync(`npm install -g --prefix "${prefix}" "${tarball}"`, { stdio: 'inherit' });

  // Verify binaries
  for (const bin of ['codev', 'af', 'porch', 'consult']) {
    execSync(`"${join(prefix, 'bin', bin)}" --help`, { stdio: 'pipe' });
    console.log(`  OK: ${bin} --help`);
  }

  console.log('Install verification passed.');
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
```

**After migration, delete**:
- `tests/lib/bats-core/`, `tests/lib/bats-support/`, `tests/lib/bats-assert/`
- `tests/e2e/*.bats`, `tests/*.bats`
- `tests/e2e/helpers.bash`
- BATS install step from `e2e.yml`

**Migrated `e2e.yml` workflow**:

```yaml
# .github/workflows/e2e.yml (updated)
name: CLI Integration Tests
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 9 * * *'

jobs:
  cli:
    name: CLI Tests (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
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

### Phase 4: Coverage tracking

```bash
npm install -D @vitest/coverage-v8
```

Add to `vitest.config.ts`:
```typescript
test: {
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    thresholds: {
      lines: 70,   // Start conservative, ratchet up
      branches: 60,
    },
    exclude: [
      '**/dist/**', '**/e2e/**', '**/__tests__/**',
      '**/dashboard/**',  // React app has separate concerns
    ],
  },
}
```

Coverage is enforced in CI via `npm test -- --coverage` in the `test.yml` workflow (Phase 1). If thresholds aren't met, the workflow fails and the PR cannot merge.

### Phase 5: Automate Playwright (in CI)

**Prerequisites**: Playwright tests need `dist/` to exist (tower is a built JS file). The workflow and config must handle this.

Update `playwright.config.ts`:

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

Port is configurable via `TOWER_TEST_PORT` env var (default 14100). Uses `reuseExistingServer: true` so it works both in CI (auto-starts) and locally (reuses running tower if present).

**CI workflow addition** (added to `test.yml`):

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

**Local usage**: Run `npm run build && npx playwright test` or, if tower is already running, just `npx playwright test` (auto-detected via `reuseExistingServer`).

### Phase 6: Clean up stale tests

- Delete or update `tests/10_fresh_spider.bats` (references "spider", now "spir")
- Delete BATS framework self-tests (`00-03`) after BATS removal
- Delete `tests/20_claude_execution.bats` if Claude CLI isolation is no longer relevant

## Porch E2E Tests (No Changes)

The porch e2e tests (`src/commands/porch/__tests__/e2e/scenarios/`) are already Vitest-based, not BATS-based. They use real Claude API calls at ~$4/run. They remain:
- In `vitest.e2e.config.ts` (not the default config)
- Run locally via `npm run test:e2e`
- Not in CI (too expensive/slow)
- Run manually before releases or when changing protocol code

## Test Organization (Target State)

```
packages/codev/
  src/
    __tests__/                  # Unit tests for CLI commands
      cli/                      # CLI integration tests (migrated from BATS)
        init.e2e.test.ts
        adopt.e2e.test.ts
        doctor.e2e.test.ts
        af.e2e.test.ts
        consult.e2e.test.ts
    agent-farm/__tests__/       # Unit tests for agent farm
      e2e/                      # Playwright dashboard tests
      *.e2e.test.ts             # Tower integration tests (renamed)
    terminal/__tests__/         # Unit tests for terminal
    commands/porch/__tests__/
      e2e/scenarios/            # Porch AI e2e tests ($4/run, local only)
  scripts/
    verify-install.mjs          # Post-release install verification
  vitest.config.ts              # Unit tests (fast, no servers, with coverage)
  vitest.e2e.config.ts          # Integration tests (servers, AI)
  playwright.config.ts          # Dashboard UI tests (auto-starts tower)

.github/workflows/
  test.yml                      # Unit tests + coverage + Playwright (NEW)
  e2e.yml                       # CLI integration tests (MIGRATED from BATS)
  post-release-e2e.yml          # Install verification after npm publish
```

## Acceptance Criteria

1. `npm test` runs clean — no server-spawning tests in default config
2. GH Actions runs Vitest unit tests with coverage on every PR (merge gate)
3. GH Actions runs tower integration tests on every PR
4. GH Actions runs CLI integration tests (migrated from BATS) on every PR
5. GH Actions runs Playwright dashboard tests on every PR
6. BATS framework and tests removed; equivalent coverage in Vitest + verify-install script
7. Coverage report generated and thresholds enforced in CI
8. Playwright tests runnable without manual tower setup (via `webServer`)
9. No test files referencing "spider" (old protocol name)
10. `*.e2e.test.ts` naming convention prevents future test classification leaks

## Effort Estimate

| Phase | Effort | Priority |
|-------|--------|----------|
| 1. CI for Vitest + integration | Small (1 workflow file) | P0 — merge gate |
| 2. Fix test classification | Small (renames + config) | P0 — unit tests broken |
| 3. Migrate BATS to Vitest | Medium (rewrite ~50 tests + verify script) | P1 — reduce framework sprawl |
| 4. Coverage tracking | Small (config + dependency) | P1 — visibility |
| 5. Automate Playwright in CI | Small (config + workflow) | P1 — catches UI regressions |
| 6. Clean up stale tests | Trivial | P2 — housekeeping |

## Risks

- **Tarball fidelity**: BATS tests install from a real tarball, catching packaging issues (missing files in `files` array, broken shebang lines). The CLI integration tests run `node dist/codev.js` which tests the built artifact but not the packaged one. The `verify-install.mjs` script covers this gap for post-release, and we can add a pre-release step that does `npm pack` + install verification before publishing.
- **Coverage thresholds too aggressive**: Starting at 70% lines is conservative. Can ratchet up as gaps are filled.
- **Playwright `webServer` port conflicts**: The auto-started tower could conflict with a running dev tower. Using port 14100 (well above dev ports 4100-4200) mitigates this. `reuseExistingServer: true` lets it coexist with a dev tower if configured on a different port.
- **CI time budget**: Adding unit + integration + CLI + Playwright to every PR could total ~3-4 minutes. Acceptable for a merge gate.

## Consultation Feedback

**Gemini (APPROVE)**: Recommended dedicated directory for CLI integration tests (done: `src/__tests__/cli/`), tarball install fidelity via `npm pack` flow (addressed via `verify-install.mjs`), and clarifying porch e2e fate (added explicit section).

**Codex (REQUEST_CHANGES)**: Flagged undefined tarball flow (addressed via `verify-install.mjs` + `node dist/codev.js` for CLI tests), missing e2e workflow sketch (added), Playwright build prerequisite (added `npm run build` step), coverage not enforced in CI (added `--coverage` to `test.yml`), and no guardrail for future test leaks (added `*.e2e.test.ts` naming convention).
