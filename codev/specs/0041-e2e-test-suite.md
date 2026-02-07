# Specification: E2E Test Suite for @cluesmith/codev

## Metadata
- **ID**: 0041
- **Title**: E2E Test Suite
- **Status**: draft
- **Created**: 2025-12-08
- **Protocol**: SPIR

## Problem Statement

The `@cluesmith/codev` npm package has 162 unit tests that test internal functions, but no automated end-to-end tests that verify the installed package works correctly from a user's perspective.

**Current gaps:**
1. No automated verification that the npm package installs correctly
2. No tests that run CLI commands as users would (`npm install`, then run commands)
3. No CI pipeline tests for the published package
4. Manual verification required after each release

**Risk:** A release could break the user experience even if all unit tests pass (e.g., bin paths misconfigured, templates missing from package, dependencies not bundled).

## Goals

1. Automated e2e tests that verify the npm package works after installation
2. Tests run in isolated environments (XDG sandboxing, no pollution from dev environment)
3. Tests cover critical user journeys AND error cases
4. Run in CI **before** npm publish (test the tarball)
5. Also run post-release to verify npm registry propagation
6. Fast enough to run on every PR (<3 minutes)

## Non-Goals

- Testing the AI CLI integrations (gemini, codex, claude) - these require credentials
- Testing the full agent-farm workflow with tmux sessions - too complex for e2e
- Load testing or performance benchmarks
- Testing upgrade paths between versions
- Windows support (lower priority - most devs on macOS/Linux)

## Proposed Solution

### Use Existing BATS Framework

Leverage the existing `tests/` BATS infrastructure instead of creating new raw shell scripts. This reuses:
- `tests/helpers/common.bash` - assertion helpers (`assert_file_exists`, `assert_output_contains`, etc.)
- XDG sandboxing patterns from spec 0001
- Established test isolation approach

**New test location:** `tests/e2e/` (alongside existing `tests/lib/`, `tests/install/`)

```
tests/
├── helpers/
│   └── common.bash          # Existing assertion helpers
├── e2e/
│   ├── setup_suite.bash     # One-time setup: npm pack, create tarball
│   ├── install.bats         # TC-001: Package installation
│   ├── init.bats            # TC-002: codev init
│   ├── adopt.bats           # TC-003: codev adopt
│   ├── doctor.bats          # TC-004: codev doctor
│   ├── af.bats              # TC-005: af commands
│   └── consult.bats         # TC-006: consult help
├── install/                 # Existing installation tests
└── lib/                     # Existing library tests
```

### Test Environment Isolation

Following spec 0001 patterns for hermetic tests:

```bash
setup() {
  # Create isolated test directory
  TEST_DIR="$(mktemp -d)"

  # XDG sandboxing - prevent touching real user config
  export XDG_CONFIG_HOME="$TEST_DIR/.xdg/config"
  export XDG_DATA_HOME="$TEST_DIR/.xdg/data"
  export XDG_CACHE_HOME="$TEST_DIR/.xdg/cache"
  export HOME="$TEST_DIR/home"
  mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

  # npm isolation
  export npm_config_prefix="$TEST_DIR/.npm-global"
  export npm_config_cache="$TEST_DIR/.npm-cache"
  mkdir -p "$npm_config_prefix" "$npm_config_cache"

  # Use pre-built tarball (set by setup_suite)
  export E2E_TARBALL="${E2E_TARBALL:-}"
}

teardown() {
  rm -rf "$TEST_DIR"
}
```

### Test Cases

#### TC-001: Package Installation (install.bats)

**Happy path:**
```bash
@test "npm install @cluesmith/codev from tarball" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  # Verify binaries are installed
  assert_file_exists "node_modules/.bin/codev"
  assert_file_exists "node_modules/.bin/af"
  assert_file_exists "node_modules/.bin/consult"
}

@test "codev --version returns expected version" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev --version
  assert_success
  assert_output --partial "1.1.0"
}

@test "af --version returns expected version" {
  # Similar pattern
}
```

**Error cases:**
```bash
@test "codev fails gracefully with unknown command" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev unknown-command
  assert_failure
  assert_output --partial "Unknown command"
}
```

#### TC-002: codev init (init.bats)

**Happy path:**
```bash
@test "codev init creates project structure" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev init my-project --yes
  assert_success

  # Verify structure
  assert_file_exists "my-project/codev/protocols/spir/protocol.md"
  assert_file_exists "my-project/codev/roles/architect.md"
  assert_file_exists "my-project/CLAUDE.md"
  assert_file_exists "my-project/AGENTS.md"
  assert_file_exists "my-project/.gitignore"

  # Verify git initialized
  assert_dir_exists "my-project/.git"
}

@test "codev init replaces PROJECT_NAME placeholder" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  ./node_modules/.bin/codev init my-custom-project --yes

  run cat my-custom-project/CLAUDE.md
  assert_output --partial "my-custom-project"
  refute_output --partial "{{PROJECT_NAME}}"
}
```

**Error cases:**
```bash
@test "codev init fails if directory exists" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"
  mkdir existing-dir

  run ./node_modules/.bin/codev init existing-dir --yes
  assert_failure
  assert_output --partial "already exists"
}

@test "codev init --yes requires project name" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev init --yes
  assert_failure
}
```

#### TC-003: codev adopt (adopt.bats)

**Happy path:**
```bash
@test "codev adopt adds codev to existing project" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  # Create existing project
  mkdir existing-project
  cd existing-project
  echo "# My Project" > README.md
  git init

  run ../node_modules/.bin/codev adopt --yes
  assert_success

  # Verify codev added
  assert_file_exists "codev/protocols/spir/protocol.md"
  assert_file_exists "CLAUDE.md"

  # Verify existing file preserved
  run cat README.md
  assert_output "# My Project"
}
```

**Error cases:**
```bash
@test "codev adopt is idempotent" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"
  mkdir project && cd project && git init

  ../node_modules/.bin/codev adopt --yes
  run ../node_modules/.bin/codev adopt --yes
  # Should warn but not fail
  assert_success
}
```

#### TC-004: codev doctor (doctor.bats)

```bash
@test "codev doctor checks dependencies" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev doctor
  # May exit non-zero if deps missing, but should not crash
  assert_output --partial "Node.js"
  assert_output --partial "git"
}

@test "codev doctor handles missing optional deps gracefully" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  # Remove tmux from PATH
  PATH="/usr/bin" run ./node_modules/.bin/codev doctor
  # Should still complete, just report missing
  assert_output --partial "tmux"
}
```

#### TC-005: af commands (af.bats)

```bash
@test "af --help shows available commands" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/af --help
  assert_success
  assert_output --partial "start"
  assert_output --partial "spawn"
  assert_output --partial "status"
}

@test "af status works without running dashboard" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"
  ./node_modules/.bin/codev init project --yes
  cd project

  run ../node_modules/.bin/af status
  # Should report no builders, not crash
  assert_success
  assert_output --partial "Architect"
}
```

#### TC-006: consult help (consult.bats)

```bash
@test "codev consult --help shows subcommands" {
  cd "$TEST_DIR"
  npm init -y
  npm install "$E2E_TARBALL"

  run ./node_modules/.bin/codev consult --help
  assert_success
  assert_output --partial "pr"
  assert_output --partial "spec"
  assert_output --partial "plan"
  assert_output --partial "general"
}
```

### CI Integration

**Test tarball BEFORE publish** (PR workflow):

```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  e2e:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install BATS
        run: |
          if [[ "$RUNNER_OS" == "Linux" ]]; then
            sudo apt-get update && sudo apt-get install -y bats
          else
            brew install bats-core
          fi

      - name: Build package
        working-directory: packages/codev
        run: |
          npm install
          npm run build

      - name: Create tarball
        working-directory: packages/codev
        run: npm pack

      - name: Run E2E tests
        env:
          E2E_TARBALL: ${{ github.workspace }}/packages/codev/cluesmith-codev-*.tgz
        run: bats tests/e2e/
```

**Post-release verification** (release workflow):

```yaml
# .github/workflows/post-release-e2e.yml
name: Post-Release E2E
on:
  release:
    types: [published]

jobs:
  verify:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Wait for npm propagation
        run: sleep 120

      - name: Verify package available
        run: |
          npm view @cluesmith/codev@${{ github.event.release.tag_name }}

      - name: Install BATS
        run: |
          if [[ "$RUNNER_OS" == "Linux" ]]; then
            sudo apt-get update && sudo apt-get install -y bats
          else
            brew install bats-core
          fi

      - name: Download published package
        run: |
          mkdir /tmp/e2e-verify
          cd /tmp/e2e-verify
          npm pack @cluesmith/codev@${{ github.event.release.tag_name }}
          echo "E2E_TARBALL=$(ls *.tgz)" >> $GITHUB_ENV

      - name: Run E2E tests
        env:
          E2E_TARBALL: /tmp/e2e-verify/${{ env.E2E_TARBALL }}
        run: bats tests/e2e/
```

### Local Testing

```bash
# Build and test locally
cd packages/codev
npm run build
npm pack
E2E_TARBALL=$(pwd)/cluesmith-codev-*.tgz bats ../../tests/e2e/

# Or run individual test file
E2E_TARBALL=$(pwd)/cluesmith-codev-*.tgz bats ../../tests/e2e/init.bats
```

## Success Criteria

1. All test cases pass on both macOS and Linux
2. Tests complete in <3 minutes
3. Tests can run against local tarball (PR workflow) or published package (post-release)
4. XDG sandboxing prevents pollution of dev environment
5. Clear error output when tests fail (BATS tap output)
6. Error cases covered, not just happy paths

## Implementation Notes

- Reuse `tests/helpers/common.bash` assertion helpers
- `setup_suite.bash` runs once to create tarball, `setup()` runs per test for isolation
- Tests must be independent (can run in any order)
- Use `npm install` not `npx` per user requirement - tests the actual install process

## Consultation Summary

**3-Way Review (2025-12-08):**
- Gemini: Use existing BATS framework; test tarball before publish
- Codex: Complete CI workflow; macOS coverage; XDG isolation; edge cases
- Claude: Assertion helpers; negative test cases; test independence

All feedback incorporated in this revision.

## Dependencies

- Depends on: 0039 (Codev CLI) - the package being tested
- Depends on: 0001 (Test Infrastructure) - BATS framework and patterns

## Risks

| Risk | Mitigation |
|------|------------|
| npm publish propagation delay | 120s wait + retry in post-release workflow |
| Flaky tests due to network | Primary workflow uses local tarball |
| Tests pass locally but fail in CI | Matrix testing on both macOS and Linux |
| BATS version differences | Pin BATS version in CI |
