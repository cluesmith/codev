#!/bin/bash
#
# Protocol Orchestrator - Generic loop orchestrator for any protocol
#
# Reads protocol definitions from JSON files and executes them.
#
# Usage:
#   ./protocol-orchestrator.sh run <protocol> <project-id>
#   ./protocol-orchestrator.sh init <protocol> <project-id> <project-name>
#   ./protocol-orchestrator.sh approve <project-id> <gate-id>
#   ./protocol-orchestrator.sh status <project-id>
#   ./protocol-orchestrator.sh list-protocols
#
# Environment:
#   ORCHESTRATOR_POLL_INTERVAL  - Seconds between approval checks (default: from protocol)
#   ORCHESTRATOR_DRY_RUN        - Set to "1" for dry run mode
#   ORCHESTRATOR_NO_CLAUDE      - Set to "1" to skip Claude invocations
#

set -euo pipefail

# Get script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOCOLS_DIR="${SCRIPT_DIR}/protocols"
PROMPTS_DIR="${SCRIPT_DIR}/prompts"

# Configuration
STATUS_DIR="codev/status"
DRY_RUN="${ORCHESTRATOR_DRY_RUN:-}"
NO_CLAUDE="${ORCHESTRATOR_NO_CLAUDE:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[orchestrator]${NC} $1"; }
success() { echo -e "${GREEN}[orchestrator]${NC} $1"; }
warn() { echo -e "${YELLOW}[orchestrator]${NC} $1"; }
error() { echo -e "${RED}[orchestrator]${NC} $1"; }
phase_log() { echo -e "${CYAN}[phase]${NC} $1"; }

# Global variables
PROTOCOL_NAME=""
PROTOCOL_FILE=""
PROJECT_ID=""
STATUS_FILE=""

# ============================================================================
# JSON Parsing Helpers (using jq)
# ============================================================================

check_jq() {
    if ! command -v jq &> /dev/null; then
        error "jq is required but not installed. Install with: brew install jq"
        exit 1
    fi
}

get_protocol_value() {
    local key="$1"
    jq -r "$key" "$PROTOCOL_FILE"
}

get_phase_by_id() {
    local phase_id="$1"
    jq -r ".phases[] | select(.id == \"$phase_id\")" "$PROTOCOL_FILE"
}

get_phase_prompt() {
    local phase_id="$1"
    local prompt_file
    prompt_file=$(jq -r ".phases[] | select(.id == \"$phase_id\") | .prompt // empty" "$PROTOCOL_FILE")
    if [[ -n "$prompt_file" ]]; then
        echo "${PROMPTS_DIR}/${prompt_file}"
    fi
}

get_phase_signals() {
    local phase_id="$1"
    jq -r ".phases[] | select(.id == \"$phase_id\") | .signals // {}" "$PROTOCOL_FILE"
}

get_signal_next_state() {
    local phase_id="$1"
    local signal="$2"
    jq -r ".phases[] | select(.id == \"$phase_id\") | .signals[\"$signal\"] // empty" "$PROTOCOL_FILE"
}

is_terminal_phase() {
    local phase_id="$1"
    local result
    result=$(jq -r ".phases[] | select(.id == \"$phase_id\") | .terminal // false" "$PROTOCOL_FILE")
    [[ "$result" == "true" ]]
}

get_gate_for_state() {
    local state="$1"
    jq -r ".gates[] | select(.after_state == \"$state\") | .id // empty" "$PROTOCOL_FILE"
}

get_gate_next_state() {
    local gate_id="$1"
    jq -r ".gates[] | select(.id == \"$gate_id\") | .next_state" "$PROTOCOL_FILE"
}

get_transition() {
    local state="$1"
    jq -r ".transitions[\"$state\"] // {}" "$PROTOCOL_FILE"
}

get_default_transition() {
    local state="$1"
    jq -r ".transitions[\"$state\"].default // empty" "$PROTOCOL_FILE"
}

get_config_value() {
    local key="$1"
    local default="$2"
    local value
    value=$(jq -r ".config.$key // empty" "$PROTOCOL_FILE")
    echo "${value:-$default}"
}

# ============================================================================
# State Management
# ============================================================================

get_state() {
    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        echo "not_initialized"
        return
    fi
    grep -E "^current_state:" "$STATUS_FILE" | sed 's/current_state: *//' | tr -d '"'
}

set_state() {
    local new_state="$1"

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        error "Status file not found"
        return 1
    fi

    # Update current_state in YAML
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/^current_state:.*/current_state: \"${new_state}\"/" "$STATUS_FILE"
    else
        sed -i "s/^current_state:.*/current_state: \"${new_state}\"/" "$STATUS_FILE"
    fi

    # Append to log
    echo "- $(date '+%Y-%m-%d %H:%M'): State changed to ${new_state}" >> "$STATUS_FILE"

    success "State → ${new_state}"
}

check_gate() {
    local gate_id="$1"

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        return 1
    fi

    # Look for gate approval in YAML (multi-line format)
    if grep -A1 "${gate_id}:" "$STATUS_FILE" | grep -q "status: passed"; then
        return 0
    else
        return 1
    fi
}

# ============================================================================
# Claude Invocation
# ============================================================================

invoke_claude() {
    local phase_id="$1"
    local context_prompt="$2"

    # Get prompt file for this phase
    local prompt_file
    prompt_file=$(get_phase_prompt "$phase_id")

    if [[ -z "$prompt_file" || ! -f "$prompt_file" ]]; then
        warn "No prompt file for phase: ${phase_id}"
        return 0
    fi

    if [[ -n "$DRY_RUN" ]]; then
        log "[DRY RUN] Would invoke Claude for phase: ${phase_id}"
        log "[DRY RUN] Prompt file: ${prompt_file}"
        return 0
    fi

    if [[ -n "$NO_CLAUDE" ]]; then
        log "[NO_CLAUDE] Simulating phase: ${phase_id}"
        sleep 1
        success "Simulated completion of phase: ${phase_id}"
        return 0
    fi

    phase_log "Invoking Claude for phase: ${phase_id}"

    # Read the phase prompt
    local phase_prompt
    phase_prompt=$(cat "$prompt_file")

    # Build the full prompt
    local full_prompt="## Protocol: ${PROTOCOL_NAME}
## Phase: ${phase_id}

## Current Status
\`\`\`yaml
$(cat "$STATUS_FILE")
\`\`\`

## Task
${context_prompt}

## Phase Instructions
${phase_prompt}

## Important
- Project ID: ${PROJECT_ID}
- Protocol: ${PROTOCOL_NAME}
- Follow the instructions above precisely
- Output <signal>...</signal> tags when you reach completion points
"

    # Invoke Claude CLI
    local output
    local exit_code=0
    output=$(claude --print -p "$full_prompt" --dangerously-skip-permissions 2>&1) || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        error "Claude invocation failed (exit code: $exit_code)"
        echo "$output"
        return 1
    fi

    echo "$output"
    return 0
}

extract_signal() {
    local output="$1"
    echo "$output" | grep -oE '<signal>[^<]+</signal>' | head -1 | sed 's/<signal>//;s/<\/signal>//' || echo ""
}

# ============================================================================
# Protocol Initialization
# ============================================================================

init_project() {
    local protocol="$1"
    local project_id="$2"
    local project_name="$3"

    PROTOCOL_NAME="$protocol"
    PROTOCOL_FILE="${PROTOCOLS_DIR}/${protocol}.json"
    PROJECT_ID="$project_id"

    if [[ ! -f "$PROTOCOL_FILE" ]]; then
        error "Protocol not found: ${PROTOCOL_FILE}"
        error "Available protocols: $(list_protocols)"
        exit 1
    fi

    local status_file="${STATUS_DIR}/${project_id}-${project_name}.md"
    mkdir -p "$STATUS_DIR"

    # Get initial state and config from protocol
    local initial_state
    initial_state=$(get_protocol_value '.initial_state')

    # Build gates YAML
    local gates_yaml=""
    local gate_ids
    gate_ids=$(jq -r '.gates[].id' "$PROTOCOL_FILE" 2>/dev/null || echo "")

    if [[ -n "$gate_ids" ]]; then
        gates_yaml="gates:"
        while IFS= read -r gate_id; do
            if [[ -n "$gate_id" ]]; then
                gates_yaml="${gates_yaml}
  ${gate_id}:
    human: { status: pending }"
            fi
        done <<< "$gate_ids"
    else
        gates_yaml="gates: {}"
    fi

    cat > "$status_file" << EOF
---
# Protocol Orchestrator Status File
# Protocol: ${protocol}
# Project: ${project_id} - ${project_name}
# Created: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

id: "${project_id}"
title: "${project_name}"
protocol: "${protocol}"
current_state: "${initial_state}"
current_phase: ""

# Human approval gates
${gates_yaml}

# Backpressure gates
backpressure:
  tests_pass: { status: pending }
  build_pass: { status: pending }

# Implementation phase tracking
phases: {}
---

## Project Description

<!-- Add a brief description of what this project will build -->

## Log

- $(date '+%Y-%m-%d %H:%M'): Initialized ${protocol} protocol
EOF

    STATUS_FILE="$status_file"
    success "Initialized project ${project_id} with protocol ${protocol}"
    log "Status file: ${status_file}"
    log "Initial state: ${initial_state}"
}

# ============================================================================
# Main Loop
# ============================================================================

run_loop() {
    local protocol="$1"
    local project_id="$2"

    PROTOCOL_NAME="$protocol"
    PROTOCOL_FILE="${PROTOCOLS_DIR}/${protocol}.json"
    PROJECT_ID="$project_id"

    if [[ ! -f "$PROTOCOL_FILE" ]]; then
        error "Protocol not found: ${PROTOCOL_FILE}"
        exit 1
    fi

    # Find status file
    STATUS_FILE="${STATUS_DIR}/${project_id}-*.md"
    STATUS_FILE=$(ls $STATUS_FILE 2>/dev/null | head -1 || echo "")

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        error "Status file not found for project: ${project_id}"
        error "Run: $0 init ${protocol} ${project_id} <project-name>"
        exit 1
    fi

    # Get config
    local poll_interval
    poll_interval=$(get_config_value "poll_interval" "30")
    poll_interval="${ORCHESTRATOR_POLL_INTERVAL:-$poll_interval}"

    local max_iterations
    max_iterations=$(get_config_value "max_iterations" "100")

    log "Starting ${protocol} loop for project ${project_id}"
    log "Status file: ${STATUS_FILE}"
    log "Poll interval: ${poll_interval}s"

    local iteration=0
    local output=""
    local signal=""

    while [[ $iteration -lt $max_iterations ]]; do
        iteration=$((iteration + 1))
        log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log "Iteration ${iteration}"
        log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # Fresh read of state each iteration
        local state
        state=$(get_state)
        log "Current state: ${state}"

        # Parse state into phase and substate
        local phase_id="${state%%:*}"
        local substate="${state#*:}"
        if [[ "$substate" == "$state" ]]; then
            substate=""
        fi

        # Check if terminal phase
        if is_terminal_phase "$phase_id"; then
            success "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            success "${protocol} loop COMPLETE"
            success "Project ${project_id} finished all phases"
            success "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            exit 0
        fi

        # Check for gate blocking
        local gate_id
        gate_id=$(get_gate_for_state "$state")

        if [[ -n "$gate_id" ]]; then
            phase_log "Phase: ${phase_id} (waiting for gate: ${gate_id})"
            if check_gate "$gate_id"; then
                local next_state
                next_state=$(get_gate_next_state "$gate_id")
                success "Gate ${gate_id} passed! Proceeding to ${next_state}"
                set_state "$next_state"
            else
                warn "BLOCKED - Waiting for gate: ${gate_id}"
                warn "To approve: $0 approve ${project_id} ${gate_id}"
                sleep "$poll_interval"
            fi
            continue
        fi

        # Execute phase
        phase_log "Phase: ${phase_id}"
        output=$(invoke_claude "$phase_id" "Execute the ${phase_id} phase for project ${project_id}")
        signal=$(extract_signal "$output")

        if [[ -n "$signal" ]]; then
            success "Signal received: ${signal}"

            # Get next state from signal
            local next_state
            next_state=$(get_signal_next_state "$phase_id" "$signal")

            if [[ -n "$next_state" ]]; then
                set_state "$next_state"
            else
                # Use default transition
                local default_next
                default_next=$(get_default_transition "$state")
                if [[ -n "$default_next" ]]; then
                    set_state "$default_next"
                else
                    warn "No transition defined for signal: ${signal}"
                fi
            fi
        else
            # No signal - use default transition
            local default_next
            default_next=$(get_default_transition "$state")
            if [[ -n "$default_next" ]]; then
                set_state "$default_next"
            fi
        fi

        sleep 2
    done

    error "Max iterations (${max_iterations}) reached!"
    exit 1
}

# ============================================================================
# Approval
# ============================================================================

approve_gate() {
    local project_id="$1"
    local gate_id="$2"

    # Find status file
    local status_file="${STATUS_DIR}/${project_id}-*.md"
    status_file=$(ls $status_file 2>/dev/null | head -1 || echo "")

    if [[ -z "$status_file" || ! -f "$status_file" ]]; then
        error "Status file not found for project: ${project_id}"
        exit 1
    fi

    # Use awk to update the gate status
    awk -v gate="$gate_id" '
        $0 ~ "^  " gate ":" { in_gate = 1 }
        in_gate && /human:.*status: pending/ {
            sub(/status: pending/, "status: passed")
            in_gate = 0
        }
        { print }
    ' "$status_file" > "${status_file}.tmp" && mv "${status_file}.tmp" "$status_file"

    echo "- $(date '+%Y-%m-%d %H:%M'): Gate ${gate_id} approved" >> "$status_file"
    success "Approved: ${gate_id}"
}

# ============================================================================
# Utilities
# ============================================================================

list_protocols() {
    local protocols=""
    for f in "${PROTOCOLS_DIR}"/*.json; do
        if [[ -f "$f" ]]; then
            local name
            name=$(basename "$f" .json)
            protocols="${protocols} ${name}"
        fi
    done
    echo "$protocols" | xargs
}

show_status() {
    local project_id="$1"
    local status_file="${STATUS_DIR}/${project_id}-*.md"
    status_file=$(ls $status_file 2>/dev/null | head -1 || echo "")

    if [[ -z "$status_file" || ! -f "$status_file" ]]; then
        error "Status file not found for project: ${project_id}"
        exit 1
    fi

    log "Status for project ${project_id}:"
    echo ""
    cat "$status_file"
}

show_protocol() {
    local protocol="$1"
    local protocol_file="${PROTOCOLS_DIR}/${protocol}.json"

    if [[ ! -f "$protocol_file" ]]; then
        error "Protocol not found: ${protocol}"
        error "Available protocols: $(list_protocols)"
        exit 1
    fi

    log "Protocol: ${protocol}"
    echo ""
    jq '.' "$protocol_file"
}

show_usage() {
    cat << 'EOF'
Protocol Orchestrator - Generic loop orchestrator for any protocol

Usage:
  protocol-orchestrator.sh run <protocol> <project-id>
  protocol-orchestrator.sh init <protocol> <project-id> <name>
  protocol-orchestrator.sh approve <project-id> <gate-id>
  protocol-orchestrator.sh status <project-id>
  protocol-orchestrator.sh list-protocols
  protocol-orchestrator.sh show-protocol <protocol>
  protocol-orchestrator.sh help

Commands:
  run             Run the protocol loop for a project
  init            Initialize a new project with a protocol
  approve         Approve a gate (e.g., specify_approval)
  status          Show current project status
  list-protocols  List available protocol definitions
  show-protocol   Show protocol definition JSON

Environment Variables:
  ORCHESTRATOR_POLL_INTERVAL   Override poll interval (seconds)
  ORCHESTRATOR_DRY_RUN         Set to '1' for dry run mode
  ORCHESTRATOR_NO_CLAUDE       Set to '1' to skip Claude invocations

Examples:
  # List available protocols
  ./protocol-orchestrator.sh list-protocols

  # Initialize a SPIDER project
  ./protocol-orchestrator.sh init spider 0073 user-auth

  # Run the loop
  ./protocol-orchestrator.sh run spider 0073

  # Approve the spec
  ./protocol-orchestrator.sh approve 0073 specify_approval

  # Initialize a TICK project (no gates)
  ./protocol-orchestrator.sh init tick 0074 small-fix
  ./protocol-orchestrator.sh run tick 0074

EOF
}

# ============================================================================
# Main Entry Point
# ============================================================================

main() {
    check_jq

    local cmd="${1:-}"

    case "$cmd" in
        "run")
            if [[ $# -lt 3 ]]; then
                error "Usage: $0 run <protocol> <project-id>"
                exit 1
            fi
            run_loop "$2" "$3"
            ;;
        "init")
            if [[ $# -lt 4 ]]; then
                error "Usage: $0 init <protocol> <project-id> <project-name>"
                exit 1
            fi
            init_project "$2" "$3" "$4"
            ;;
        "approve")
            if [[ $# -lt 3 ]]; then
                error "Usage: $0 approve <project-id> <gate-id>"
                exit 1
            fi
            approve_gate "$2" "$3"
            ;;
        "status")
            if [[ $# -lt 2 ]]; then
                error "Usage: $0 status <project-id>"
                exit 1
            fi
            show_status "$2"
            ;;
        "list-protocols"|"list")
            log "Available protocols:"
            for p in $(list_protocols); do
                local desc
                desc=$(jq -r '.description' "${PROTOCOLS_DIR}/${p}.json" 2>/dev/null || echo "")
                echo "  - ${p}: ${desc}"
            done
            ;;
        "show-protocol"|"show")
            if [[ $# -lt 2 ]]; then
                error "Usage: $0 show-protocol <protocol>"
                exit 1
            fi
            show_protocol "$2"
            ;;
        "help"|"-h"|"--help")
            show_usage
            ;;
        "")
            show_usage
            ;;
        *)
            error "Unknown command: ${cmd}"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
