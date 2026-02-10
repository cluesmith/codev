# Test Infrastructure

Comprehensive guide to Codev's test suites, frameworks, and how to run them.

## Overview

Codev has four test layers, each serving a different purpose:

| Layer | Framework | Count | Run Time | Cost | CI? |
|-------|-----------|-------|----------|------|-----|
| **Unit tests** | Vitest | ~600 tests / 44 files | ~5s | Free | No (local only) |
| **Tower integration** | Vitest (e2e config) | ~200 tests / 4 files | ~60s | Free | No (local only) |
| **Porch e2e** | Vitest (e2e config) | ~70 tests / 4 files | ~40 min | ~$4/run | No (local only) |
| **BATS e2e** | BATS | ~50 tests / 6 files | ~2 min | Free | Yes (GH Actions) |
| **Playwright** | Playwright | ~30 tests / 4 files | ~30s | Free | No (manual setup) |

## 1. Unit Tests (Vitest)

**What**: Fast, isolated tests for core logic. No servers, no AI, no network.

**Run**: `cd packages/codev && npm test`

**Config**: `packages/codev/vitest.config.ts`

**Location**: `packages/codev/src/**/__tests__/*.test.ts` (excluding e2e/)

### Test areas

| Area | Files | What they test |
|------|-------|----------------|
| CLI commands | `src/__tests__/init.test.ts`, `adopt.test.ts`, `doctor.test.ts`, `update.test.ts`, `scaffold.test.ts`, `templates.test.ts`, `import.test.ts` | `codev init`, `codev adopt`, `codev doctor`, etc. |
| Consultation | `src/__tests__/consult.test.ts`, `generate-image.test.ts` | `consult` CLI, image generation |
| Projectlist | `src/__tests__/projectlist-parser.test.ts` | YAML/markdown parsing of projectlist.md |
| Agent Farm | `src/agent-farm/__tests__/spawn.test.ts`, `state.test.ts`, `config.test.ts`, `types.test.ts`, `roles.test.ts`, `port-registry.test.ts`, `db.test.ts`, `migrate.test.ts`, `start.test.ts`, `attach.test.ts`, `server-utils.test.ts` | Builder spawning, state management, config, ports, SQLite |
| Terminal | `src/terminal/__tests__/pty-manager.test.ts`, `pty-session.test.ts`, `ring-buffer.test.ts`, `ws-protocol.test.ts` | PTY lifecycle, WebSocket protocol, output buffering |
| Porch | `src/commands/porch/__tests__/protocol.test.ts`, `checks.test.ts`, `state.test.ts`, `plan.test.ts`, `next.test.ts`, `parse-verdict.test.ts`, `build-counter.test.ts` | Protocol loading, phase transitions, check running, verdict parsing |
| Bugfix regressions | `bugfix-195.test.ts`, `bugfix-195-attach.test.ts`, `bugfix-199-zombie-tab.test.ts` | Specific regression tests tied to GitHub issues |
| Other | `concurrency.test.ts`, `shell.test.ts`, `clipboard.test.ts`, `terminal-proxy.test.ts`, `tower-proxy.test.ts`, `dashboard-race.test.ts` | Concurrency, proxy, clipboard, race conditions |

### Exclusions

The default vitest config **excludes** tests that need a running tower:
- `tower-baseline.test.ts`, `tower-api.test.ts`, `tower-terminals.test.ts`, `cli-tower-mode.test.ts`
- Everything in `**/e2e/**`
- Dashboard tests (separate vitest config)
- Worktree/builder directories

## 2. Tower Integration Tests (Vitest E2E)

**What**: Tests that spawn a real tower server and make HTTP/WebSocket requests against it.

**Run**: `cd packages/codev && npm run test:e2e`

**Config**: `packages/codev/vitest.e2e.config.ts`

**Prerequisites**: `npm run build` (needs `dist/` and `skeleton/`)

### Test files

| File | What it tests |
|------|---------------|
| `tower-baseline.test.ts` | Server startup, health endpoint, project activation/deactivation lifecycle |
| `tower-api.test.ts` | Full REST API: project CRUD, terminal creation, WebSocket connections |
| `tower-terminals.test.ts` | Terminal session management, tmux integration, output streaming |
| `cli-tower-mode.test.ts` | CLI `af tower` command startup and shutdown |
| `bugfix-202-stale-temp-projects.test.ts` | Stale temp directory filtering (spawns its own tower on port 14600) |

**Important**: These tests run sequentially (`maxConcurrency: 1`) with 20-minute timeout per test. They spawn real server processes and need ports 14200-14600.

## 3. Porch E2E Tests (Vitest E2E, AI-powered)

**What**: End-to-end protocol tests that make real Claude API calls. Tests the full porch orchestration loop.

**Run**: `cd packages/codev && npm run test:e2e`

**Config**: `packages/codev/vitest.e2e.config.ts` (same as tower integration)

**Cost**: ~$4 per full run, ~40 minutes

### Scenarios

| File | What it tests |
|------|---------------|
| `e2e/scenarios/happy-path.test.ts` | Complete SPIR protocol: specify, plan, implement phases with real AI |
| `e2e/scenarios/feedback-loop.test.ts` | Consultation feedback, iteration on AI output |
| `e2e/scenarios/single-phase.test.ts` | Protocols with only one phase |
| `e2e/scenarios/benchmark.test.ts` | Performance tracking for porch operations |

These are the most expensive tests and are NOT run in CI.

## 4. BATS E2E Tests

**What**: Test the **published CLI** as an end user would experience it. Install from npm tarball, run real commands, verify output.

**Run**: `cd packages/codev && npm run test:e2e:bats`

**CI**: `.github/workflows/e2e.yml` (runs on PR, push to main, daily schedule)

**Platforms**: ubuntu-latest, macos-latest

### How it works

1. Build the package: `npm run build`
2. Create tarball: `npm pack`
3. Each test creates an isolated XDG-sandboxed environment
4. Install from tarball (not source)
5. Run CLI commands and assert output

### Test files

| File | What it tests |
|------|---------------|
| `tests/e2e/install.bats` | `npm install -g` from tarball, binary availability |
| `tests/e2e/init.bats` | `codev init` creates correct files and directories |
| `tests/e2e/adopt.bats` | `codev adopt` for existing projects |
| `tests/e2e/doctor.bats` | `codev doctor` diagnostics |
| `tests/e2e/af.bats` | `af` subcommands (status, help, etc.) |
| `tests/e2e/consult.bats` | `consult` subcommands |

### Legacy/framework tests

| File | Purpose |
|------|---------|
| `tests/00_framework.bats` | BATS framework smoke test |
| `tests/01_framework_validation.bats` | Validates test helpers work |
| `tests/02_runner_behavior.bats` | Test runner behavior |
| `tests/03_test_helpers.bats` | Helper function validation |
| `tests/10_fresh_spider.bats` | SPIDER protocol tests (pre-dates SPIR rename) |
| `tests/12_existing_claude_md.bats` | CLAUDE.md preservation during init |
| `tests/20_claude_execution.bats` | Claude CLI isolation |

### Helper infrastructure

- `tests/e2e/helpers.bash` — Setup/teardown, XDG sandboxing, install helpers
- `tests/lib/bats-core/` — BATS framework (vendored)
- `tests/lib/bats-support/` — BATS support library (vendored)
- `tests/lib/bats-assert/` — BATS assertion library (vendored)

### Post-release verification

`.github/workflows/post-release-e2e.yml` runs after npm publish to verify the published package works. Waits 120s for npm propagation then runs the same BATS suite.

## 5. Playwright Tests (Dashboard UI)

**What**: Browser-based tests for the Tower dashboard React app.

**Run**: `cd packages/codev && npx playwright test`

**Config**: `packages/codev/playwright.config.ts`

**Prerequisites**: Tower must be running (`af tower start` or `af dash start --no-browser`)

### Test files

| File | What it tests |
|------|---------------|
| `e2e/dashboard-terminals.test.ts` | Terminal tab creation, WebSocket connections, API state |
| `e2e/dashboard-bugs.test.ts` | UI-level regression tests for specific bugs |
| `e2e/dashboard-video.test.ts` | Video recording in terminal sessions |
| `e2e/tower-integration.test.ts` | Tower server integration from browser perspective |

### Limitations

- Requires manual tower startup (no `webServer` config active)
- Not run in CI (no headless browser setup in workflows)
- Tests assume localhost:4200

## CI/CD Workflows

| Workflow | Trigger | What runs | Platforms |
|----------|---------|-----------|-----------|
| `e2e.yml` | PR, push to main, daily 9am UTC | BATS e2e tests | ubuntu + macOS |
| `post-release-e2e.yml` | Release published, manual | BATS against published npm | ubuntu + macOS |

**Not in CI**: Vitest unit tests, tower integration, porch e2e, Playwright. All local-only.

## Running Tests

```bash
# Fast unit tests (daily development)
cd packages/codev && npm test

# Tower integration + porch e2e (after changes to server/protocol code)
cd packages/codev && npm run build && npm run test:e2e

# BATS CLI tests (before release)
cd packages/codev && npm run test:e2e:bats

# Playwright dashboard tests (after UI changes)
af tower start
cd packages/codev && npx playwright test

# Single test file
cd packages/codev && npx vitest run src/__tests__/init.test.ts

# GH Actions BATS
gh workflow run e2e.yml
```

## Known Issues

1. **bugfix-202 test misplaced**: `bugfix-202-stale-temp-projects.test.ts` spawns a real tower but isn't excluded from the default vitest config. Should be in the e2e exclusion list or moved to `e2e/`.

2. **BATS tests failing in CI**: Recent GH Actions runs fail. Likely missing BATS helper libs or test environment issues. Need investigation.

3. **No coverage tracking**: No `@vitest/coverage` configured. No coverage thresholds enforced.

4. **Playwright manual setup**: Tests require manually starting the tower before running. Not automated in CI.

5. **Legacy BATS tests**: `tests/10_fresh_spider.bats` references pre-rename "spider" protocol. Some framework tests (`00-03`) test BATS itself rather than Codev.

6. **Porch e2e cost**: ~$4 per run makes frequent execution impractical. No way to run a subset cheaply.
