#!/usr/bin/env bats
# TC-057: Dashboard Tab Overhaul Tests (Spec 0057)
# TC-060: Dashboard Modularization Tests (Spec 0060)
#
# Tests that verify the modular Dashboard works correctly.
# Dashboard is now split into multiple files in templates/dashboard/

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

# Helper to get the dashboard directory
DASHBOARD_DIR="node_modules/@cluesmith/codev/templates/dashboard"

# === Dashboard Structure Tests ===

@test "dashboard modular structure exists" {
  assert_dir_exist "$DASHBOARD_DIR"
  assert_file_exist "$DASHBOARD_DIR/index.html"
  assert_dir_exist "$DASHBOARD_DIR/js"
  assert_dir_exist "$DASHBOARD_DIR/css"
}

@test "dashboard has required JS modules" {
  assert_file_exist "$DASHBOARD_DIR/js/main.js"
  assert_file_exist "$DASHBOARD_DIR/js/tabs.js"
  assert_file_exist "$DASHBOARD_DIR/js/projects.js"
  assert_file_exist "$DASHBOARD_DIR/js/files.js"
  assert_file_exist "$DASHBOARD_DIR/js/state.js"
  assert_file_exist "$DASHBOARD_DIR/js/utils.js"
  assert_file_exist "$DASHBOARD_DIR/js/dialogs.js"
}

@test "dashboard has required CSS modules" {
  assert_file_exist "$DASHBOARD_DIR/css/variables.css"
  assert_file_exist "$DASHBOARD_DIR/css/layout.css"
  assert_file_exist "$DASHBOARD_DIR/css/tabs.css"
  assert_file_exist "$DASHBOARD_DIR/css/files.css"
  assert_file_exist "$DASHBOARD_DIR/css/projects.css"
}

# === Dashboard Template Tests ===

@test "dashboard template contains Dashboard tab definition" {
  # Dashboard tab is identified by 'dashboard' ID in projects.js
  run grep -q "dashboard" "$DASHBOARD_DIR/js/projects.js"
  assert_success
}

@test "dashboard template contains dashboard type" {
  # Dashboard content is rendered via renderDashboardTabContent
  run grep -q "renderDashboardTabContent\|activeTabId.*dashboard" "$DASHBOARD_DIR/js/projects.js"
  assert_success
}

@test "dashboard template contains two-column layout CSS" {
  run grep -q "display:" "$DASHBOARD_DIR/css/layout.css"
  assert_success
  run grep -q "flex" "$DASHBOARD_DIR/css/layout.css"
  assert_success
}

@test "dashboard template contains tabs list component" {
  # Tabs list rendering is in projects.js
  run grep -q "renderDashboard\|ProjectsSection" "$DASHBOARD_DIR/js/projects.js"
  assert_success
}

@test "dashboard template contains file browser component" {
  run grep -q "renderDashboardFilesBrowser\|renderFilesSection" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "dashboard template contains quick action buttons" {
  # Shell creation is in dialogs.js
  run grep -q "createNewShell" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "dashboard template contains status indicators CSS" {
  run grep -q "status" "$DASHBOARD_DIR/css/projects.css"
  assert_success
}

# === Worktree Shell API Tests ===

@test "dashboard-server supports worktree parameter in shell endpoint" {
  run grep -q "body.worktree" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server supports branch parameter for worktree" {
  run grep -q "body.branch" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server creates worktrees in .worktrees directory" {
  run grep -q ".worktrees" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "dashboard-server validates branch name format" {
  run grep -q "Invalid branch name" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

# === Responsive Design Tests ===

@test "dashboard template has responsive breakpoint for columns" {
  # Responsive breakpoints are in files.css
  run grep -q "@media" "$DASHBOARD_DIR/css/files.css"
  assert_success
}

@test "dashboard template stacks columns on small screens" {
  # Media query at 900px for responsive layout
  run grep -q "max-width.*900px" "$DASHBOARD_DIR/css/files.css"
  assert_success
}

# === Accessibility Tests ===

@test "dashboard status indicators have reduced motion support" {
  run grep -rq "prefers-reduced-motion" "$DASHBOARD_DIR/css/"
  assert_success
}

@test "dashboard tabs list items are clickable" {
  run grep -q "onclick\|addEventListener" "$DASHBOARD_DIR/js/tabs.js"
  assert_success
}

# === File Search Autocomplete Tests (Spec 0058) ===

@test "file search has flattenFilesTree function" {
  run grep -q "flattenFilesTree\|flattenTree" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search has searchFiles function with relevance sorting" {
  run grep -q "searchFiles\|filterFiles" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search has filesTreeFlat cache" {
  run grep -q "filesTreeFlat\|flatCache\|cachedFlat" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search input exists in Files section" {
  run grep -q 'files-search\|search.*input' "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search has debounced input handler" {
  run grep -q "debounce\|setTimeout" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search has keyboard navigation" {
  run grep -q "ArrowDown\|ArrowUp\|keydown" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search has highlight matching text" {
  run grep -q "highlight" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search palette HTML exists" {
  run grep -q 'file-palette\|palette' "$DASHBOARD_DIR/index.html"
  assert_success
}

@test "file search has Cmd+P keyboard handler" {
  run grep -rq "metaKey\|ctrlKey" "$DASHBOARD_DIR/js/"
  assert_success
}

@test "file search palette has open/close functions" {
  run grep -q "openPalette\|closePalette" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search reuses existing tab if file is open" {
  run grep -q "existingTab\|findTab\|getTab" "$DASHBOARD_DIR/js/tabs.js"
  assert_success
}

@test "file search has clear button" {
  run grep -rq "clear.*search\|search.*clear" "$DASHBOARD_DIR/js/files.js"
  assert_success
}

@test "file search CSS styles exist" {
  run grep -q "files-search\|search" "$DASHBOARD_DIR/css/files.css"
  assert_success
}

@test "file palette CSS styles exist" {
  run grep -q "file-palette\|palette" "$DASHBOARD_DIR/css/files.css"
  assert_success
}

@test "file search prevents browser print dialog" {
  run grep -rq "preventDefault" "$DASHBOARD_DIR/js/"
  assert_success
}

# === Create File Dialog Tests (Bugfix #131) ===

@test "create file dialog exists in dashboard HTML" {
  run grep -q "create-file-dialog" "$DASHBOARD_DIR/index.html"
  assert_success
}

@test "create file dialog has input field" {
  run grep -q "create-file-path-input" "$DASHBOARD_DIR/index.html"
  assert_success
}

@test "create file has showCreateFileDialog function" {
  run grep -q "showCreateFileDialog" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "create file has hideCreateFileDialog function" {
  run grep -q "hideCreateFileDialog" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "create file has createFile function" {
  run grep -q "function createFile\|async function createFile" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "create file calls POST /api/files" {
  run grep -q "/api/files" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "files section header has create file button" {
  run grep -q "showCreateFileDialog" "$DASHBOARD_DIR/js/main.js"
  assert_success
}

@test "dashboard-server has POST /api/files endpoint" {
  run grep -q "req.method === 'POST' && url.pathname === '/api/files'" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "create file API validates path traversal" {
  run grep -q "validatePathWithinProject" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "create file API creates parent directories" {
  run grep -q "recursive.*true" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "create file API validates parent symlinks" {
  run grep -q "realpathSync" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

# === Tab Running Status API Tests (Bugfix #132) ===

@test "dashboard-server has GET /api/tabs/:tabId/running endpoint" {
  # Check for the comment marker and the regex pattern (escaped slashes in compiled regex)
  run grep -q "Check if tab process is running" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "running endpoint checks shell process status" {
  run grep -q "isProcessRunning" node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "running endpoint returns JSON with running field" {
  run grep -q 'JSON.stringify({ running' node_modules/@cluesmith/codev/dist/agent-farm/servers/dashboard-server.js
  assert_success
}

@test "closeTab function checks running status before confirmation" {
  run grep -q "/running" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}

@test "closeTab skips confirmation for exited processes" {
  # Check that closeTab closes without confirmation when not running
  run grep -q "!running" "$DASHBOARD_DIR/js/dialogs.js"
  assert_success
}
