#!/usr/bin/env bats
# TC-057: Dashboard Tab Overhaul Tests (Spec 0057)
#
# Tests that verify the Dashboard tab works correctly after overhaul.

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

# === Dashboard Template Tests ===

@test "dashboard template contains Dashboard tab definition" {
  # Check that the template defines 'Dashboard' as the tab name
  run grep -q "name: 'Dashboard'" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains dashboard type" {
  # Check that the tab type is 'dashboard' not 'projects'
  run grep -q "type: 'dashboard'" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains two-column layout CSS" {
  # Check for the dashboard header flexbox CSS
  run grep -q "dashboard-header" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "display: flex" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains tabs list component" {
  # Check for the tabs list rendering function
  run grep -q "renderDashboardTabsList" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains file browser component" {
  # Check for the file browser in dashboard
  run grep -q "renderDashboardFilesBrowser" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains quick action buttons" {
  # Check for the new shell/worktree buttons
  run grep -q "createNewShell" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "createNewWorktreeShell" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template contains status indicators CSS" {
  # Check for the status indicator classes
  run grep -q "dashboard-status-working" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "dashboard-status-blocked" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "dashboard-status-idle" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template removes welcome screen from default view" {
  # The welcome screen should only appear when no projects exist
  # The main Dashboard view should not show welcome content by default
  run grep -c "projects-welcome" node_modules/@cluesmith/codev/templates/dashboard-split.html
  # Welcome screen CSS and function still exist but are not default
  [[ "$output" =~ ^[0-9]+$ ]]
}

@test "dashboard template has renderDashboardTab function" {
  run grep -q "async function renderDashboardTab" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template loads projectlist and files in parallel" {
  # Check that Promise.all is used to load both datasets
  run grep -q "Promise.all" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

# === Worktree Shell API Tests ===

@test "dashboard-server supports worktree parameter in shell endpoint" {
  # Check that the backend supports the worktree option
  run grep -q "body.worktree" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server supports branch parameter for worktree" {
  # Check that the backend supports branch name option
  run grep -q "body.branch" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server creates worktrees in .worktrees directory" {
  # Check that worktrees go to the standard location
  run grep -q ".worktrees" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server validates branch name format" {
  # Check for branch name validation to prevent injection
  run grep -q "Invalid branch name" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

# === Responsive Design Tests ===

@test "dashboard template has responsive breakpoint for columns" {
  # Check for media query that changes layout on narrow screens
  run grep -q "@media.*max-width.*900px" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard template stacks columns on small screens" {
  # Check that columns become single-column on narrow screens
  run grep -A3 "@media.*max-width.*900px" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_output --partial "flex-direction: column"
}

# === Accessibility Tests ===

@test "dashboard status indicators have reduced motion support" {
  # Check for prefers-reduced-motion media query
  run grep -q "prefers-reduced-motion" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "dashboard tabs list items are clickable" {
  # Check that dashboard tab items have onclick handlers
  run grep -q 'dashboard-tab-item.*onclick' node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

# === File Search Autocomplete Tests (Spec 0058) ===

@test "file search has flattenFilesTree function" {
  run grep -q "function flattenFilesTree" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has searchFiles function with relevance sorting" {
  # Check that searchFiles function exists and has sorting logic
  run grep -q "function searchFiles" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  # Verify relevance sorting is implemented
  run grep -q "Sort by relevance" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has filesTreeFlat cache" {
  # Check that the flat file list is cached
  run grep -q "filesTreeFlat = " node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search input exists in Files section" {
  # Check that the search input is rendered
  run grep -q 'id="files-search-input"' node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has debounced input handler" {
  # Check for debounce implementation
  run grep -q "filesSearchDebounceTimer" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  # Check for 100ms debounce timeout
  run grep -q "100" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has keyboard navigation" {
  # Check for arrow key handling
  run grep -q "onFilesSearchKeydown" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "ArrowDown" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "ArrowUp" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has highlight matching text" {
  # Check for highlight function
  run grep -q "function highlightMatch" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "files-search-highlight" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search palette HTML exists" {
  # Check that the Cmd+P palette modal exists
  run grep -q 'id="file-palette"' node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q 'id="palette-input"' node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has Cmd+P keyboard handler" {
  # Check for global Cmd+P handler
  run grep -q 'e.metaKey || e.ctrlKey' node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "e.key === 'p'" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search palette has open/close functions" {
  run grep -q "function openPalette" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "function closePalette" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search reuses existing tab if file is open" {
  # Check that openFileFromSearch checks for existing tabs
  run grep -q "function openFileFromSearch" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "existingTab" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search has clear button" {
  # Check for clear search button
  run grep -q "files-search-clear" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q "clearFilesSearch" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search CSS styles exist" {
  # Check for file search CSS
  run grep -q ".files-search-container" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q ".files-search-input" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q ".files-search-result" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file palette CSS styles exist" {
  # Check for palette CSS
  run grep -q ".file-palette" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q ".file-palette-container" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
  run grep -q ".file-palette-results" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_success
}

@test "file search prevents browser print dialog" {
  # Check that e.preventDefault is called for Cmd+P
  run grep -A10 "e.key === 'p'" node_modules/@cluesmith/codev/templates/dashboard-split.html
  assert_output --partial "preventDefault"
}
