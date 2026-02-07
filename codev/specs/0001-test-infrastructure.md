# Specification: Codev Installation Test Infrastructure

## Metadata
- **ID**: 0001-test-infrastructure
- **Status**: draft
- **Created**: 2025-01-20
- **Multi-Agent**: true (GPT-5 and Gemini Pro)

## Problem Statement
Currently, there is no automated way to verify that the Codev installation process works correctly. The installation involves multiple steps including downloading files, creating directories, and potentially interacting with AI agents. We need a test infrastructure that can verify the installation process works as expected across different scenarios.

## Current State
- Installation instructions exist in INSTALL.md
- The process is manual and untested
- No way to verify that installations complete successfully
- No regression testing when we make changes to the installation process
- Installation involves both shell commands and AI agent interactions

## Desired State
- Automated test suite that validates the installation process
- Tests for different installation scenarios (with/without Zen MCP, existing vs new CLAUDE.md)
- Verification that all files are created in the correct locations
- Validation that the installed structure matches expectations
- Clear test reports showing what passed/failed
- Ability to run tests locally and in CI/CD

## Stakeholders
- **Primary Users**: Codev maintainers who need to ensure installation works
- **Secondary Users**: Contributors who want to verify their changes don't break installation
- **End Users**: Developers installing Codev who benefit from a reliable installation process

## Success Criteria
- [ ] Test suite can simulate a fresh installation
- [ ] Tests verify all files are created in correct locations
- [ ] Tests validate file contents match expected templates
- [ ] Tests handle both SPIR and SPIR-SOLO installation paths
- [ ] Tests can simulate presence/absence of Zen MCP server
- [ ] Tests can verify CLAUDE.md updates (both new and existing files)
- [ ] Test suite can be run with a single command
- [ ] All tests pass with >90% coverage of installation scenarios
- [ ] Clear documentation on how to run and extend tests

## Constraints
### Technical Constraints
- Must work without actually installing Zen MCP server
- Should not require network access for basic tests (mock the GitHub download)
- Must handle testing AI agent interactions (which are text-based instructions)
- Should work on common development platforms (macOS, Linux)
- Cannot directly test Claude's execution of instructions (test outcomes instead)

### Business Constraints
- Should be simple enough for contributors to understand and modify
- Must not add heavy dependencies to the project
- Should complete in under 30 seconds for full test suite

## Assumptions
- Python is available for test infrastructure (common for development)
- We can mock or simulate the curl/tar download process
- We can test the file system outcomes even if we can't test the AI interaction directly
- Contributors will run tests before submitting PRs

## Solution Approaches

### Approach 1: Shell Script Test Suite (SELECTED)
**Description**: Create a bash-based test suite that runs installation commands and verifies outcomes

**Pros**:
- No additional language dependencies
- Directly tests the actual shell commands from INSTALL.md
- Simple to understand for shell-savvy developers
- Can easily test file system operations
- Maintains simplicity without additional install.sh script

**Cons**:
- Limited testing framework capabilities
- Harder to mock external dependencies
- Less structured test reporting
- Difficult to test edge cases cleanly

**User Decision**: Selected for its simplicity and to avoid creating an install.sh script

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Python + Canonical install.sh
**Description**: Create a canonical `install.sh` script as the single source of truth, then use pytest to test it

**Pros**:
- Single authoritative installer script
- Tests the actual shell script (catches quoting, PATH issues)
- Rich testing ecosystem (pytest, mocking, fixtures)
- Easy to mock external dependencies (mcp command, network)
- Structured test reports and coverage metrics
- Can simulate different installation scenarios cleanly
- Easy to integrate with CI/CD
- Offline mode for fast, reliable tests

**Cons**:
- Adds Python as a test dependency (acceptable for testing)
- Need to maintain both install.sh and INSTALL.md in sync

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 3: Docker-Based Integration Tests
**Description**: Use Docker containers to test actual installations in isolated environments

**Pros**:
- Tests real installation in clean environment
- Can test across different OS configurations
- Completely isolated from host system
- Most realistic testing scenario

**Cons**:
- Requires Docker
- Slower test execution
- More complex setup
- Harder to debug failures
- Overkill for basic validation

**Estimated Complexity**: High
**Risk Level**: Medium (defer to v2)

## Open Questions

### Critical (Blocks Progress)
- [x] How do we test the AI agent instruction portions of installation?
  - **Answer**: Create safe temporary directories and test file outcomes
  - **Update**: Can run Claude in isolation with `--strict-mcp-config` and `--settings` flags
- [x] Should we test the actual GitHub download or always mock it?
  - **Answer**: Use the local codev-skeleton directory

### Important (Affects Design)
- [x] Do we need to test on Windows or just Unix-like systems?
  - **Answer**: Unix-like systems only
- [x] Should tests be able to run without any network access?
  - **Answer**: Not a requirement, but will use local skeleton anyway
- [x] How do we handle testing the Zen MCP detection?
  - **Answer**: Mock it

### Nice-to-Know (Optimization)
- [ ] Could we generate test cases from the INSTALL.md automatically?
  - **Deferred**: Not required for v1
- [ ] Should we test upgrade scenarios (existing Codev to new version)?
  - **Deferred**: Not for v1

## Performance Requirements
- **Test Execution Time**: < 30 seconds for full suite
- **Individual Test**: < 2 seconds per test
- **Resource Usage**: Minimal CPU/memory usage (desirable)
- **Parallelization**: Tests should be parallelizable where possible (desirable)

## Security Considerations
- Tests should not require elevated privileges
- Should not modify system files outside of test directories
- Must clean up all test artifacts after completion
- Should not expose any sensitive information in test logs


## Test Scenarios
### Functional Tests
1. Fresh installation with no existing files
2. Installation with existing CLAUDE.md file
3. Installation with Zen MCP server available
4. Installation without Zen MCP server (falls back to SPIR-SOLO)
5. Verify all directories are created (specs/, plans/, reviews/, resources/, protocols/)
6. Verify protocol files are copied correctly
7. Verify llms.txt is created in resources/
8. Test cleanup of temporary installation directory
9. **Claude execution test** (optional):
   - Run `claude --strict-mcp-config --mcp-config '[]'` in test directory
   - Provide INSTALL.md instructions as input
   - Verify Claude can execute installation without user settings interference

### Edge Cases (Deferred to V2)
Edge case testing deferred per user feedback - focusing on happy path for v1.

## Dependencies
- **External Services**: GitHub - will use local codev-skeleton directory instead

- **Internal Systems**: File system operations, shell commands
- **Libraries/Frameworks**: Shell-based testing (potentially using bash test frameworks like bats if available)
## References
- [INSTALL.md](/INSTALL.md)
- [codev-skeleton structure](/codev-skeleton/)
- Standard software testing best practices

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Can't test AI interactions directly | High | Medium | Test file system outcomes instead |
| Tests become outdated | Medium | High | Run tests in CI/CD, keep simple |
| Platform-specific issues | Medium | Medium | Focus on Unix-like systems initially |
| Mocking adds complexity | Low | Medium | Start with simple file-based tests |

## V1 Scope Definition (Based on User Feedback)

### In Scope for V1
1. **Shell-based test suite** that:
   - Runs installation commands directly from INSTALL.md
   - Uses local codev-skeleton directory (no network access needed)
   - Creates safe temporary directories for testing
   - Mocks Zen MCP detection
   - Tests on Unix-like systems only

2. **Core "happy path" tests**:
   - Fresh installation with SPIR protocol (Zen present)
   - Fresh installation with SPIR-SOLO (Zen absent)
   - Basic file structure validation
   - CLAUDE.md creation verification
   - **Existing CLAUDE.md updates** (common case, per user feedback)
   - **Optional: Claude execution test** - Run actual claude command with isolation flags

3. **Test infrastructure**:
   - Shell-based test framework
   - Mock mcp command for Zen detection
   - Use local codev-skeleton (no downloads)
   - Temporary directory isolation for each test

### Out of Scope for V1 (Defer to V2)
- Idempotence and re-run safety
- Existing codev/ directory handling
- Complex edge cases (read-only dirs, network failures)
- Windows support
- Docker-based testing
- Upgrade/migration scenarios

## Expert Consultation
**Date**: 2025-01-20
**Models**: GPT-5 and Gemini Pro

### Initial Consultation (Pre-User Feedback)
#### GPT-5 Key Feedback:
- Create canonical install.sh as single source of truth
- Fix tar flag bug (`--strip=1` should be `--strip-components=1`)
- Add non-interactive mode for automation
- Implement offline/local skeleton support
- Use pytest calling install.sh via subprocess (not reimplementing)
- Add markers to CLAUDE.md for safe updates
- Remove tree dependency (not standard on macOS)
- Standardize Zen MCP detection approach

#### Gemini Pro Key Feedback:
- Start with "golden path" testing for v1
- Focus on fresh installations only initially
- Create "sync linter" test to prevent drift between install.sh and INSTALL.md
- Mock mcp by adding fake executable to PATH
- Defer idempotence to v2 (complex to get right)
- Keep v1 simple: two scenarios, one command to run tests

### Second Consultation (Post-User Feedback)
#### GPT-5 Key Feedback on Shell Approach:
- **Recommended framework**: bats-core with bats-support, bats-assert, bats-file
- **Critical fixes needed**:
  - Use `cp -a` instead of `cp -r` to copy dotfiles
  - Fix tar flag to `--strip-components=1`
  - Remove tree dependency (use find instead)
- **Test structure**:
  - Vendor bats libraries under tests/lib/
  - Create helper scripts for mocking mcp
  - Use mktemp for isolated test directories
- **Viable approach**: Shell-based testing is appropriate for v1 goals
- **Key insight**: Focus on outcome assertions rather than scripting every command

## Approval
- [x] Technical Lead Review (User feedback incorporated)
- [x] Multi-Agent Consultation Complete
- [x] Stakeholder Sign-off (User has provided direction)

## Implementation Recommendations (From Consultations)

### Test Framework: bats-core
- Vendor bats-core and helper libraries under `tests/lib/`
- Provides TAP output, clean assertions, file helpers
- Works on macOS and Linux without system installation

### Test Structure
```
tests/
├── lib/              # Vendored bats libraries
│   ├── bats-support/
│   ├── bats-assert/
│   └── bats-file/
├── helpers/          # Test utilities
│   ├── common.bash   # mktemp, cleanup, paths
│   └── mock_mcp.bash # Fake mcp for Zen detection
├── 01_fresh_spider.bats
├── 02_fresh_spider_solo.bats
└── 03_existing_claude.bats
```

### Critical Implementation Details
1. Use `cp -a codev-skeleton/. codev/` to copy dotfiles
2. Mock mcp by adding fake executable to PATH
3. Use mktemp -d for test isolation
4. Focus on outcome assertions (files exist, content present)
5. Avoid interactive prompts in tests
6. Run Claude in isolation using:
   - `--strict-mcp-config --mcp-config '[]'` for no MCP servers
   - `--settings '{}'` for minimal settings
   - Custom test settings JSON for controlled environment

## Notes
This test infrastructure will be critical for maintaining Codev's reliability as it grows. Starting simple with file system validation and expanding to more complex scenarios over time is the recommended approach.