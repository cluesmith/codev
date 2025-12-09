#!/usr/bin/env bash
# Mock MCP helper for testing (used for test isolation)

# Mock mcp command - simulates MCP being present
# Usage: mock_mcp_present
mock_mcp_present() {
  # Create a mock mcp executable in a temporary directory
  export MOCK_MCP_DIR="${MOCK_MCP_DIR:-$(mktemp -d)}"

  cat > "$MOCK_MCP_DIR/mcp" << 'EOF'
#!/usr/bin/env bash
# Mock mcp command
if [[ "$1" == "list" ]]; then
  echo "Available MCP servers:"
  echo "  - @example/other"
elif [[ "$1" == "--version" ]]; then
  echo "mcp version 1.0.0-mock"
else
  echo "Mock MCP command"
fi
exit 0
EOF

  chmod +x "$MOCK_MCP_DIR/mcp"

  # Add mock to PATH (only set ORIGINAL_PATH if not already set)
  if [[ -z "${ORIGINAL_PATH:-}" ]]; then
    export ORIGINAL_PATH="${PATH}"
  fi
  export PATH="${MOCK_MCP_DIR}:${PATH}"

  return 0
}

# Mock mcp command - simulates MCP being absent
# Usage: mock_mcp_absent
mock_mcp_absent() {
  # Create a mock mcp executable that returns no servers
  export MOCK_MCP_DIR="${MOCK_MCP_DIR:-$(mktemp -d)}"

  cat > "$MOCK_MCP_DIR/mcp" << 'EOF'
#!/usr/bin/env bash
# Mock mcp command with no servers
if [[ "$1" == "list" ]]; then
  echo "Available MCP servers:"
  echo "  (none)"
elif [[ "$1" == "--version" ]]; then
  echo "mcp version 1.0.0-mock"
else
  echo "Mock MCP command"
fi
exit 0
EOF

  chmod +x "$MOCK_MCP_DIR/mcp"

  # Add mock to PATH (only set ORIGINAL_PATH if not already set)
  if [[ -z "${ORIGINAL_PATH:-}" ]]; then
    export ORIGINAL_PATH="${PATH}"
  fi
  export PATH="${MOCK_MCP_DIR}:${PATH}"

  return 0
}

# Remove mcp from PATH entirely
# Usage: remove_mcp_from_path
remove_mcp_from_path() {
  # Save original PATH if not already saved
  if [[ -z "${ORIGINAL_PATH:-}" ]]; then
    export ORIGINAL_PATH="${PATH}"
  fi

  # Remove only our mock directory if it exists
  if [[ -n "${MOCK_MCP_DIR:-}" ]]; then
    # Remove MOCK_MCP_DIR from PATH
    local new_path=""
    local IFS=':'
    for dir in $PATH; do
      if [[ "$dir" != "$MOCK_MCP_DIR" ]]; then
        if [[ -z "$new_path" ]]; then
          new_path="$dir"
        else
          new_path="$new_path:$dir"
        fi
      fi
    done
    export PATH="$new_path"
  fi

  # Create a shim that fails for mcp to mask any system mcp
  export MOCK_MCP_DIR="${MOCK_MCP_DIR:-$(mktemp -d)}"
  cat > "$MOCK_MCP_DIR/mcp" << 'EOF'
#!/usr/bin/env bash
# Shim to mask mcp
exit 127
EOF
  chmod +x "$MOCK_MCP_DIR/mcp"
  export PATH="${MOCK_MCP_DIR}:${PATH}"

  return 0
}

# Restore original PATH
# Usage: restore_path
restore_path() {
  if [[ -n "${ORIGINAL_PATH:-}" ]]; then
    export PATH="${ORIGINAL_PATH}"
    unset ORIGINAL_PATH
  fi

  # Clean up mock directory if it exists
  if [[ -n "${MOCK_MCP_DIR:-}" && -d "${MOCK_MCP_DIR}" ]]; then
    rm -rf "${MOCK_MCP_DIR}"
    unset MOCK_MCP_DIR
  fi

  return 0
}

# Check if MCP is available (for verification)
# Usage: is_mcp_available
is_mcp_available() {
  if ! command -v mcp >/dev/null 2>&1; then
    return 1
  fi

  # Check if mcp command works and has servers (not just "(none)")
  local output
  output=$(mcp list 2>/dev/null)
  local exit_code=$?

  # Return failure if mcp command failed
  if [[ $exit_code -ne 0 ]]; then
    return 1
  fi

  # Return failure if output contains "(none)"
  if echo "$output" | grep -q "(none)"; then
    return 1
  fi

  return 0
}

# Legacy alias for backwards compatibility
is_zen_available() {
  is_mcp_available
}

# Simulate installing Codev with mocked MCP state
# Usage: install_with_mcp_state <target_dir> <mcp_state>
# Where mcp_state is one of: present, absent, none
install_with_mcp_state() {
  local target_dir="$1"
  local mcp_state="$2"

  case "$mcp_state" in
    present)
      mock_mcp_present
      ;;
    absent)
      mock_mcp_absent
      ;;
    none)
      remove_mcp_from_path
      ;;
    *)
      echo "Error: Invalid mcp_state: $mcp_state" >&2
      return 1
      ;;
  esac

  # Run the installation
  install_from_local "$target_dir"
  local result=$?

  # Restore PATH
  restore_path

  return $result
}