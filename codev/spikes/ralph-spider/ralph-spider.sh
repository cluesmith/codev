#!/bin/bash
#
# Ralph-SPIDER Loop Orchestrator (Prototype)
#
# This script demonstrates the core Ralph-inspired SPIDER loop where:
# - Builder owns entire lifecycle (S→P→I→D→E→R)
# - Human approval gates are backpressure points
# - Fresh context per iteration
# - State lives in files, not AI memory
#
# Usage: ./ralph-spider.sh <project-id> [--dry-run]
#

set -euo pipefail

# Configuration
PROJECT_ID="${1:-}"
DRY_RUN="${2:-}"
MAX_ITERATIONS=100
POLL_INTERVAL=30
STATUS_DIR="codev/status"
SPECS_DIR="codev/specs"
PLANS_DIR="codev/plans"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[ralph]${NC} $1"; }
success() { echo -e "${GREEN}[ralph]${NC} $1"; }
warn() { echo -e "${YELLOW}[ralph]${NC} $1"; }
error() { echo -e "${RED}[ralph]${NC} $1"; }

# Validate arguments
if [[ -z "$PROJECT_ID" ]]; then
    error "Usage: $0 <project-id> [--dry-run]"
    exit 1
fi

STATUS_FILE="${STATUS_DIR}/${PROJECT_ID}-*.md"
STATUS_FILE=$(ls $STATUS_FILE 2>/dev/null | head -1 || echo "")

# Initialize status file if it doesn't exist
init_status() {
    local project_name="${1:-test-project}"
    local status_file="${STATUS_DIR}/${PROJECT_ID}-${project_name}.md"

    mkdir -p "$STATUS_DIR"

    cat > "$status_file" << EOF
---
id: "${PROJECT_ID}"
title: "${project_name}"
protocol: ralph-spider
current_state: specify:draft

gates:
  specify_approval:
    human: { status: pending }
  plan_approval:
    human: { status: pending }
  defend_gate:
    tests_pass: { status: pending }
    build_pass: { status: pending }
---

## Log

- $(date '+%Y-%m-%d %H:%M'): Initialized Ralph-SPIDER loop
EOF

    echo "$status_file"
}

# Parse current state from status file
get_state() {
    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        echo "not_initialized"
        return
    fi

    # Extract current_state from YAML frontmatter
    grep -E "^current_state:" "$STATUS_FILE" | sed 's/current_state: *//' | tr -d '"'
}

# Update state in status file
set_state() {
    local new_state="$1"

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        error "Status file not found"
        return 1
    fi

    # Update current_state in YAML
    sed -i '' "s/^current_state:.*/current_state: ${new_state}/" "$STATUS_FILE"

    # Append to log
    echo "- $(date '+%Y-%m-%d %H:%M'): State changed to ${new_state}" >> "$STATUS_FILE"

    success "State → ${new_state}"
}

# Check if a gate is approved
check_gate() {
    local gate="$1"

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        return 1
    fi

    # Look for gate approval in YAML
    if grep -q "${gate}.*status: passed" "$STATUS_FILE"; then
        return 0
    else
        return 1
    fi
}

# Mark a gate as passed
pass_gate() {
    local gate="$1"
    local by="${2:-system}"

    if [[ -z "$STATUS_FILE" || ! -f "$STATUS_FILE" ]]; then
        error "Status file not found"
        return 1
    fi

    # This is simplified - real implementation would use proper YAML parsing
    local timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    # Append to log
    echo "- $(date '+%Y-%m-%d %H:%M'): Gate '${gate}' passed by ${by}" >> "$STATUS_FILE"

    success "Gate '${gate}' passed"
}

# Invoke Claude for a specific phase
invoke_claude() {
    local phase="$1"
    local prompt="$2"

    if [[ "$DRY_RUN" == "--dry-run" ]]; then
        log "[DRY RUN] Would invoke Claude for phase: ${phase}"
        log "[DRY RUN] Prompt: ${prompt}"
        return 0
    fi

    log "Invoking Claude for phase: ${phase}"

    # Real implementation would call claude CLI here
    # claude --print -p "${prompt}"

    # For prototype, just simulate
    sleep 2
    success "Claude completed phase: ${phase}"
}

# Check if spec file exists
spec_exists() {
    ls ${SPECS_DIR}/${PROJECT_ID}-*.md &>/dev/null
}

# Check if plan file exists
plan_exists() {
    ls ${PLANS_DIR}/${PROJECT_ID}-*.md &>/dev/null
}

# Check if tests pass
tests_pass() {
    if [[ "$DRY_RUN" == "--dry-run" ]]; then
        log "[DRY RUN] Would run tests"
        return 0
    fi

    # Real implementation would run: npm test or similar
    log "Running tests..."
    return 0
}

# Check if build passes
build_passes() {
    if [[ "$DRY_RUN" == "--dry-run" ]]; then
        log "[DRY RUN] Would run build"
        return 0
    fi

    # Real implementation would run: npm run build or similar
    log "Running build..."
    return 0
}

# Main loop
main() {
    log "Starting Ralph-SPIDER loop for project ${PROJECT_ID}"

    local iteration=0

    while [[ $iteration -lt $MAX_ITERATIONS ]]; do
        iteration=$((iteration + 1))
        log "━━━ Iteration ${iteration} ━━━"

        local state=$(get_state)
        log "Current state: ${state}"

        case "$state" in
            "not_initialized")
                warn "Project not initialized. Creating status file..."
                STATUS_FILE=$(init_status "test-project")
                ;;

            "specify:draft")
                log "Phase: SPECIFY (draft)"
                invoke_claude "specify" "Write a specification for project ${PROJECT_ID}. Read the project description and create a detailed spec following the SPIDER template."
                set_state "specify:review"
                ;;

            "specify:review")
                log "Phase: SPECIFY (review) - BLOCKED waiting for human approval"
                if check_gate "specify_approval.human"; then
                    success "Spec approved! Proceeding to Plan."
                    set_state "plan:draft"
                else
                    warn "Waiting for human approval of spec..."
                    warn "To approve: Edit ${STATUS_FILE} and set specify_approval.human.status to 'passed'"
                    sleep $POLL_INTERVAL
                fi
                ;;

            "plan:draft")
                log "Phase: PLAN (draft)"
                if ! spec_exists; then
                    error "Spec file not found! Cannot proceed."
                    exit 1
                fi
                invoke_claude "plan" "Write an implementation plan based on the approved spec at ${SPECS_DIR}/${PROJECT_ID}-*.md"
                set_state "plan:review"
                ;;

            "plan:review")
                log "Phase: PLAN (review) - BLOCKED waiting for human approval"
                if check_gate "plan_approval.human"; then
                    success "Plan approved! Proceeding to Implement."
                    set_state "implement"
                else
                    warn "Waiting for human approval of plan..."
                    warn "To approve: Edit ${STATUS_FILE} and set plan_approval.human.status to 'passed'"
                    sleep $POLL_INTERVAL
                fi
                ;;

            "implement")
                log "Phase: IMPLEMENT"
                if ! plan_exists; then
                    error "Plan file not found! Cannot proceed."
                    exit 1
                fi
                invoke_claude "implement" "Implement the code according to the plan at ${PLANS_DIR}/${PROJECT_ID}-*.md"

                if build_passes; then
                    set_state "defend"
                else
                    warn "Build failed. Re-running implement..."
                fi
                ;;

            "defend")
                log "Phase: DEFEND"
                invoke_claude "defend" "Write tests for the implementation. Ensure all acceptance criteria from the spec are covered."

                if tests_pass; then
                    pass_gate "defend_gate.tests_pass"
                    pass_gate "defend_gate.build_pass"
                    set_state "evaluate"
                else
                    warn "Tests failed. Re-running defend..."
                fi
                ;;

            "evaluate")
                log "Phase: EVALUATE"
                invoke_claude "evaluate" "Verify all acceptance criteria from the spec are met. List each criterion and its status."
                set_state "review"
                ;;

            "review")
                log "Phase: REVIEW"
                invoke_claude "review" "Create a PR and write a review document summarizing what was built and lessons learned."
                set_state "complete"
                ;;

            "complete")
                success "━━━ Ralph-SPIDER loop COMPLETE ━━━"
                success "Project ${PROJECT_ID} has completed all phases."
                exit 0
                ;;

            *)
                error "Unknown state: ${state}"
                exit 1
                ;;
        esac

        # Small delay between iterations
        sleep 1
    done

    error "Max iterations (${MAX_ITERATIONS}) reached!"
    exit 1
}

# Run main
main
