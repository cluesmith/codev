#!/usr/bin/env bats
# TC-006: consult Command Tests
#
# Tests that verify the consult CLI works correctly.
# Note: These tests only verify help output and CLI structure,
# not actual AI consultations (which require credentials).

load '../lib/bats-support/load'
load '../lib/bats-assert/load'
load '../lib/bats-file/load'
load 'helpers.bash'

setup() {
  setup_e2e_env
  cd "$TEST_DIR"
  install_codev
}

teardown() {
  teardown_e2e_env
}

# === Help and Version ===

@test "consult --help shows available commands" {
  run ./node_modules/.bin/consult --help
  assert_success
  assert_output --partial "pr"
  assert_output --partial "spec"
  assert_output --partial "plan"
  assert_output --partial "general"
}

@test "consult shows model options" {
  run ./node_modules/.bin/consult --help
  assert_success
  assert_output --partial "model"
}

# === Subcommand Help ===

@test "consult pr --help shows PR review options" {
  run ./node_modules/.bin/consult pr --help
  assert_success
}

@test "consult spec --help shows spec review options" {
  run ./node_modules/.bin/consult spec --help
  assert_success
}

@test "consult plan --help shows plan review options" {
  run ./node_modules/.bin/consult plan --help
  assert_success
}

@test "consult general --help shows general query options" {
  run ./node_modules/.bin/consult general --help
  assert_success
}

# === Error Handling ===

@test "consult without subcommand shows help" {
  run ./node_modules/.bin/consult
  # Should show help or error but not crash
  [[ "$status" -eq 0 ]] || [[ "$status" -eq 1 ]]
}

@test "consult with unknown subcommand fails gracefully" {
  run ./node_modules/.bin/consult unknown-subcommand
  assert_failure
}

@test "consult pr without number shows error" {
  run ./node_modules/.bin/consult pr
  # Should fail with helpful message
  assert_failure
}

@test "consult spec without number shows error" {
  run ./node_modules/.bin/consult spec
  # Should fail with helpful message
  assert_failure
}

# === Model Validation ===

@test "consult accepts --model gemini option" {
  run ./node_modules/.bin/consult --model gemini --help
  assert_success
}

@test "consult accepts --model codex option" {
  run ./node_modules/.bin/consult --model codex --help
  assert_success
}

@test "consult accepts --model claude option" {
  run ./node_modules/.bin/consult --model claude --help
  assert_success
}

# === Dry Run Mode ===

@test "consult supports --dry-run flag" {
  run ./node_modules/.bin/consult --help
  # Dry run should be documented in help
  assert_output --partial "dry"
}

# === Codex Configuration (Spec 0043) ===

@test "consult codex dry-run shows experimental_instructions_file config" {
  # Verify we use the official experimental_instructions_file instead of CODEX_SYSTEM_MESSAGE
  # The dry-run should show the -c experimental_instructions_file flag
  skip_if_no_codex
  run ./node_modules/.bin/consult --model codex general "test" --dry-run
  assert_success
  assert_output --partial "experimental_instructions_file"
}

@test "consult codex dry-run shows model_reasoning_effort=low" {
  # Verify we use low reasoning effort for faster responses
  skip_if_no_codex
  run ./node_modules/.bin/consult --model codex general "test" --dry-run
  assert_success
  assert_output --partial "model_reasoning_effort=low"
}

@test "consult codex dry-run cleans up temp file" {
  # Verify temp file created for experimental_instructions_file is cleaned up
  # The dry-run creates and then removes the temp file
  skip_if_no_codex

  # Count temp .md files before
  local before_count=$(ls /tmp/*.md 2>/dev/null | wc -l || echo 0)

  run ./node_modules/.bin/consult --model codex general "test" --dry-run
  assert_success

  # Count temp .md files after - should be same or less (cleanup happened)
  local after_count=$(ls /tmp/*.md 2>/dev/null | wc -l || echo 0)

  # After count should not be greater than before (temp file was cleaned up)
  [[ "$after_count" -le "$before_count" ]]
}

# === Custom Role Support ===

@test "consult --help shows --role option" {
  run ./node_modules/.bin/consult --help
  assert_success
  assert_output --partial "--role"
  assert_output --partial "codev/roles/"
}

@test "consult --role with valid name works in dry-run" {
  # The consultant role exists in skeleton, should work
  run ./node_modules/.bin/consult --model gemini --role consultant general "test" --dry-run
  assert_success
  assert_output --partial "Role: consultant"
}

@test "consult --role blocks directory traversal" {
  # Attempting path traversal should fail with validation error
  run ./node_modules/.bin/consult --model gemini --role "../../../etc/passwd" general "test" --dry-run
  assert_failure
  assert_output --partial "Invalid role name"
  assert_output --partial "letters, numbers, hyphens, and underscores"
}

@test "consult --role blocks path separators" {
  # Forward slashes should be rejected
  run ./node_modules/.bin/consult --model gemini --role "foo/bar" general "test" --dry-run
  assert_failure
  assert_output --partial "Invalid role name"
}

@test "consult --role with nonexistent role shows helpful error" {
  # Nonexistent role should fail and show helpful message
  run ./node_modules/.bin/consult --model gemini --role nonexistent-role-xyz general "test" --dry-run
  assert_failure
  assert_output --partial "not found"
  # Should show either available roles or "No custom roles found"
  [[ "$output" == *"Available roles"* ]] || [[ "$output" == *"No custom roles found"* ]]
}

@test "consult --role accepts hyphens and underscores" {
  # Valid characters: alphanumeric, hyphens, underscores
  # This will fail because the role doesn't exist, but it should NOT fail on validation
  run ./node_modules/.bin/consult --model gemini --role "my-custom_role123" general "test" --dry-run
  assert_failure
  # Should fail because role doesn't exist, NOT because of invalid name
  assert_output --partial "not found"
  refute_output --partial "Invalid role name"
}
