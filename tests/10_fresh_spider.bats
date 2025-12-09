#!/usr/bin/env bats
# Test fresh Codev installation with SPIDER protocol

load 'lib/bats-support/load'
load 'lib/bats-assert/load'
load 'lib/bats-file/load'
load 'helpers/common.bash'
load 'helpers/mock_mcp.bash'

setup() {
  export PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export TEST_PROJECT
  TEST_PROJECT=$(setup_test_project)

  # Mock MCP as present for all tests
  mock_mcp_present
}

teardown() {
  # Clean up test project
  if [[ -n "${TEST_PROJECT:-}" ]]; then
    teardown_test_project "$TEST_PROJECT"
  fi

  # Restore original PATH
  restore_path
}

@test "fresh install creates SPIDER setup" {
  # Verify MCP is detected before install
  run is_mcp_available
  assert_success

  # Install Codev
  run install_from_local "$TEST_PROJECT"
  assert_success

  # Create CLAUDE.md with SPIDER protocol reference
  create_claude_md "$TEST_PROJECT" "# Project Instructions

## Codev Methodology

This project uses the Codev context-driven development methodology.

### Active Protocol
- Protocol: SPIDER
- Location: codev/protocols/spider/protocol.md

### Directory Structure
- Specifications: codev/specs/
- Plans: codev/plans/
- Reviews: codev/reviews/

See codev/protocols/spider/protocol.md for full protocol details."

  # Verify structure
  assert_codev_structure "$TEST_PROJECT"
  assert_spider_protocol "$TEST_PROJECT"

}

@test "SPIDER protocol has all required templates" {
  install_from_local "$TEST_PROJECT"

  # Check all SPIDER templates exist
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/templates/spec.md"
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/templates/plan.md"
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/templates/review.md"
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/templates/review.md"

  # Verify protocol.md exists and is not empty
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/protocol.md"
  run wc -l < "$TEST_PROJECT/codev/protocols/spider/protocol.md"
  assert [ "$output" -gt 50 ]  # Protocol should have meaningful content
}

@test "SPIDER protocol includes multi-agent consultation guidance" {
  install_from_local "$TEST_PROJECT"

  # Check that the SPIDER protocol itself contains multi-agent consultation guidance
  local protocol_file="$TEST_PROJECT/codev/protocols/spider/protocol.md"

  # Verify protocol mentions multi-agent consultation
  run file_contains "$protocol_file" "Expert Consultation"
  assert_success

  run file_contains "$protocol_file" "multi-agent consultation"
  assert_success

  # Check for model references (generic, not specific versions)
  run file_contains "$protocol_file" "Gemini"
  assert_success

  run file_contains "$protocol_file" "GPT"
  assert_success

  # Verify consultation is marked as default/mandatory
  run file_contains "$protocol_file" "DEFAULT - MANDATORY"
  assert_success
}

@test "all required codev directories are created" {
  install_from_local "$TEST_PROJECT"

  # Verify all core directories exist
  assert_dir_exist "$TEST_PROJECT/codev"
  assert_dir_exist "$TEST_PROJECT/codev/specs"
  assert_dir_exist "$TEST_PROJECT/codev/plans"
  assert_dir_exist "$TEST_PROJECT/codev/reviews"
  assert_dir_exist "$TEST_PROJECT/codev/protocols"
  assert_dir_exist "$TEST_PROJECT/codev/resources"

  # Verify protocols subdirectories
  assert_dir_exist "$TEST_PROJECT/codev/protocols/spider"
}

@test "SPIDER protocol.md contains required phases" {
  install_from_local "$TEST_PROJECT"

  local protocol_file="$TEST_PROJECT/codev/protocols/spider/protocol.md"

  # Check for all SPIDER phases
  run file_contains "$protocol_file" "## S - Specify"
  assert_success

  run file_contains "$protocol_file" "## P - Plan"
  assert_success

  run file_contains "$protocol_file" "### (IDE) - Implementation Loop"
  assert_success

  run file_contains "$protocol_file" "#### I - Implement"
  assert_success

  run file_contains "$protocol_file" "#### D - Defend"
  assert_success

  run file_contains "$protocol_file" "#### E - Evaluate"
  assert_success

  run file_contains "$protocol_file" "## R - Review"
  assert_success
}

@test "SPIDER includes git commit requirements" {
  install_from_local "$TEST_PROJECT"

  local protocol_file="$TEST_PROJECT/codev/protocols/spider/protocol.md"

  # Check for commit requirements
  run file_contains "$protocol_file" "Phase Commit"
  assert_success

  run file_contains "$protocol_file" "MANDATORY"
  assert_success

  run file_contains "$protocol_file" "Previous phase must be committed"
  assert_success
}

@test "specs directory is created and ready" {
  install_from_local "$TEST_PROJECT"

  # Check specs directory exists
  assert_dir_exist "$TEST_PROJECT/codev/specs"

  # Should have gitkeep to ensure directory is tracked
  assert_file_exist "$TEST_PROJECT/codev/specs/.gitkeep"
}

@test "resources directory is created and ready" {
  install_from_local "$TEST_PROJECT"

  # Check for resources directory
  assert_dir_exist "$TEST_PROJECT/codev/resources"

  # Resources directory should exist (llms.txt removed from skeleton)
  # Users can add their own resources here
}

@test "SPIDER protocol is installed" {
  install_from_local "$TEST_PROJECT"

  # SPIDER protocol should be present
  assert_spider_protocol "$TEST_PROJECT"

  # User can reference the protocol via CLAUDE.md
  create_claude_md "$TEST_PROJECT" "Protocol: SPIDER"
  run file_contains "$TEST_PROJECT/CLAUDE.md" "Protocol: SPIDER"
  assert_success
}

@test "installation preserves file attributes and permissions" {
  # Installation should preserve modes with cp -a
  install_from_local "$TEST_PROJECT"

  # Verify regular files are copied
  assert_file_exist "$TEST_PROJECT/codev/protocols/spider/protocol.md"
  assert_file_exist "$TEST_PROJECT/codev/specs/.gitkeep"

  # Check that directories have expected permissions (readable and executable)
  # Use platform-specific stat command
  if [[ "$OSTYPE" == "darwin"* ]]; then
    run stat -f "%Lp" "$TEST_PROJECT/codev"
  else
    run stat -c "%a" "$TEST_PROJECT/codev"
  fi
  # Should be 7xx (owner has rwx)
  assert [ "${output:0:1}" = "7" ]

  # Verify subdirectories are accessible
  run ls -d "$TEST_PROJECT/codev/protocols"
  assert_success

  # Test that we can create dotfiles in the installed structure
  # (This validates the directory is writable as expected)
  echo "test" > "$TEST_PROJECT/codev/.test"
  assert_file_exist "$TEST_PROJECT/codev/.test"
  rm "$TEST_PROJECT/codev/.test"
}