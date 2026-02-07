# Plan: Codev Installation Test Infrastructure

## Metadata
- **ID**: 0001-test-infrastructure
- **Specification**: [codev/specs/0001-test-infrastructure.md](/codev/specs/0001-test-infrastructure.md)
- **Status**: completed
- **Author**: Claude (with Waleed)
- **Created**: 2025-01-20
- **Completed**: 2025-01-20

## Overview
This plan implements a shell-based test suite for validating the Codev installation process. Based on the approved specification, we'll use the bats-core framework to create structured tests that verify installation outcomes without requiring network access or complex dependencies.

## Success Metrics
- [x] All three core test scenarios pass
- [x] Fast tests (non-Claude) run in under 30 seconds via `run-tests.sh`
- [x] Integration tests (Claude) run separately via `run-all-tests.sh`
- [x] No network access required for core tests
- [x] Tests can run on macOS and Linux
- [x] Clear pass/fail reporting with bats TAP output

## Phase Breakdown

### Phase 1: Set Up Test Framework and Structure [COMPLETED]
**Objective**: Establish the test infrastructure foundation with bats-core

**Dependencies**: None

**Tasks**:
1. Create `tests/` directory structure
2. Vendor bats-core and explicitly vendor:
   - bats-support (load helper functions)
   - bats-assert (assertion helpers)
   - bats-file (file assertion helpers)
3. Create run-tests.sh entry point script (fast tests only)
4. Create run-integration-tests.sh script (Claude tests)
5. Set up basic test helpers with teardown for guaranteed cleanup
6. Verify bats runs successfully

**Deliverables**:
- Working bats-core installation in tests/lib/
- Basic test structure created
- run-tests.sh script functional

**Success Criteria**:
- Can run `./scripts/run-tests.sh` without errors
- Bats framework loads and reports version
- Test directory structure matches specification

---

### Phase 2: [COMPLETED] Implement Core Test Helpers
**Objective**: Create reusable test utilities for mocking and setup

**Dependencies**: Phase 1 (Test framework set up)

**Tasks**:
1. Create mock_mcp helper for Zen detection
2. Create setup_test_project helper using mktemp
3. Implement teardown function for guaranteed cleanup (even on test failure)
4. Create install_from_local helper to copy codev-skeleton
5. Create assertion helpers for directory structure
6. Fix INSTALL.md issues (tar flag, cp command)

**Deliverables**:
- tests/helpers/common.bash with project setup
- tests/helpers/mock_mcp.bash for Zen simulation
- Updated INSTALL.md with fixes

**Success Criteria**:
- Helpers can create isolated test directories
- Mock mcp can simulate present/absent states
- Local skeleton copy works with dotfiles

---

### Phase 3: [COMPLETED] Implement SPIR Test (Zen Present)
**Objective**: Test fresh installation when Zen MCP is available

**Dependencies**: Phase 2 (Helpers ready)

**Tasks**:
1. Create 01_fresh_spider.bats test file
2. Mock Zen MCP as present
3. Copy local skeleton to test directory
4. Create CLAUDE.md with SPIR protocol
5. Assert directory structure and file contents

**Deliverables**:
- Working test for SPIR installation
- Verifies correct protocol selection
- Validates all directories created

**Success Criteria**:
- Test passes consistently
- Correctly detects SPIR protocol in CLAUDE.md
- All required directories exist

---

### Phase 4: [COMPLETED] Implement SPIR-SOLO Test (Zen Absent)
**Objective**: Test fresh installation when Zen MCP is not available

**Dependencies**: Phase 2 (Helpers ready)

**Tasks**:
1. Create 02_fresh_spider_solo.bats test file
2. Ensure no mcp in PATH
3. Copy local skeleton to test directory
4. Create CLAUDE.md with SPIR-SOLO protocol
5. Assert correct protocol selection

**Deliverables**:
- Working test for SPIR-SOLO installation
- Verifies fallback behavior
- Validates directory structure

**Success Criteria**:
- Test passes consistently
- Correctly selects SPIR-SOLO when Zen absent
- All required directories exist

---

### Phase 5: [COMPLETED] Implement Existing CLAUDE.md Update Test
**Objective**: Test updating an existing CLAUDE.md file

**Dependencies**: Phase 2 (Helpers ready)

**Tasks**:
1. Create 03_existing_claude.bats test file
2. Pre-create CLAUDE.md with existing content
3. Run installation process
4. Verify Codev section appended
5. Assert original content preserved

**Deliverables**:
- Working test for existing file updates
- Validates non-destructive updates
- Ensures content preservation

**Success Criteria**:
- Original CLAUDE.md content preserved
- Codev section properly appended
- No duplicate sections added

---

### Phase 6: [COMPLETED] Claude Execution Tests
**Objective**: Test actual Claude command execution with isolation flags

**Dependencies**: Phases 3-5 complete

**Tasks**:
1. Create 04_claude_execution.bats for real Claude testing
2. Use comprehensive Claude isolation flags:
   - `--strict-mcp-config --mcp-config '[]'` (no MCP servers)
   - `--settings '{}'` (no user settings)
3. Test Claude executing actual installation instructions
4. Assert final file system state matches "golden state" from Phase 3/4 tests
5. Tests skip gracefully if Claude not available (for contributors without Claude)
6. Run via separate `run-integration-tests.sh` script (slower tests)

**Deliverables**:
- Integration tests with real Claude
- Validates actual AI execution of instructions
- Local testing only (not for CI/CD due to API keys)

**Success Criteria**:
- Claude executes installation in fully isolated environment
- Final file system state matches "golden state" from shell tests
- Tests work locally for developers with Claude installed
- Graceful skip for environments without Claude
- Integration tests separated from fast feedback loop

---

### Phase 7: [COMPLETED] Documentation
**Objective**: Document test usage for local development

**Dependencies**: All tests implemented

**Tasks**:
1. Create tests/README.md with usage instructions
2. Document how to run tests locally with Claude
3. Document test behavior without Claude (graceful skip)
4. Document how to add new tests
5. Create troubleshooting guide

**Deliverables**:
- Complete test documentation
- Local development testing guide
- Instructions for extending test suite

**Success Criteria**:
- Clear documentation for running tests locally
- Instructions for debugging failures
- Guide for adding new test cases
- Note: CI/CD deferred due to Claude API key requirements

---

## Risk Mitigation

| Risk | Mitigation Strategy |
|------|-------------------|
| Bats not available on all systems | Vendor it locally, no system install needed |
| Tests affecting host system | Use mktemp and cleanup traps |
| Claude not installed | Make execution tests optional with skip |
| Platform differences | Focus on POSIX-compliant shell |
| Test flakiness | Avoid network, use deterministic mocks |

## Rollback Plan
If any phase fails:
1. Tests are isolated and can be removed without impact
2. INSTALL.md fixes can be reverted if issues found
3. Each phase can be re-attempted independently

## Dependencies
- Local codev-skeleton directory
- Bash shell (POSIX-compliant)
- Basic Unix utilities (cp, mkdir, grep, etc.)
- Optional: Claude CLI for execution tests


## Notes
- Phases 3, 4, and 5 can be developed in parallel once Phase 2 is complete
- Phase 6 tests with real Claude using isolation flags (local only, not CI/CD)
- Claude API keys prevent CI/CD integration - tests are for local development
- Tests should work WITH Claude (full testing) or WITHOUT (graceful skip)
- Focus on outcome testing rather than testing every shell command
- Keep tests simple and maintainable for v1