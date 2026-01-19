# Plan: Porch - Protocol Orchestrator

## Metadata
- **ID**: 0073
- **Status**: draft
- **Specification**: codev/specs/0073-porch-protocol-orchestrator.md
- **Created**: 2026-01-19

## Executive Summary

This plan implements Porch as a standalone CLI that orchestrates development protocols (SPIDER, TICK, BUGFIX) with state machine enforcement, human approval gates, and multi-agent consultation loops. Building on the spike implementation at `packages/codev/src/commands/porch/`, we will:

1. Extract porch to a standalone binary (`porch` not `codev porch`)
2. Implement the new project structure (`codev/projects/<id>/` and `worktrees/`)
3. Add phased IDE loop (implement → defend → evaluate per plan phase)
4. Add multi-agent consultation with approval loop
5. Update `af` to use `kickoff` command and integrate with porch

## Success Metrics

### Functional
- [ ] All specification criteria met
- [ ] `porch` runs as standalone command
- [ ] Protocols defined in JSON with protocol.md maintained alongside
- [ ] IDE phases loop over plan phases correctly
- [ ] Multi-agent consultation loops until all approve or max rounds
- [ ] Human gates block and notify
- [ ] `af kickoff` creates worktree and runs porch
- [ ] State survives porch restart

### Testing
- [ ] Unit test coverage >80% for core state machine
- [ ] E2E tests for SPIDER, TICK, BUGFIX protocols pass
- [ ] `--dry-run` mode shows accurate execution plan
- [ ] `--no-claude` mode runs full state machine with mocks
- [ ] CI pipeline passes all tests before merge
- [ ] Tests run in reasonable time (<30s unit, <2m E2E)

### Documentation
- [ ] CLAUDE.md updated with porch and af kickoff
- [ ] Command reference complete (codev/resources/commands/porch.md)
- [ ] Test fixtures documented for contributors

## Implementation Phases

### Phase 1: Project Structure Reorganization

**Dependencies**: None

#### Objectives
- Create new directory structure for projects and executions
- Update status file location from `codev/status/` to `codev/projects/<id>/status.yaml`
- Pure YAML format (not markdown with frontmatter)

#### Deliverables
- [ ] `codev/projects/` directory structure
- [ ] `codev/executions/` for TICK/BUGFIX state
- [ ] Updated status file format (pure YAML)
- [ ] Migration helpers for existing status files

#### Implementation Details

**New structure (in codev-skeleton, then import to our project):**
```
codev-skeleton/
├── projects/              # SPIDER projects (empty template)
├── executions/            # TICK/BUGFIX state (empty template)

# After import, a project looks like:
codev/
├── projects/              # SPIDER projects
│   └── 0073-user-auth/
│       ├── spec.md
│       ├── plan.md
│       ├── status.yaml
│       └── review.md
├── executions/            # TICK/BUGFIX state
│   ├── tick_0073_add-feature/
│   │   └── status.yaml
│   └── bugfix_142/
│       └── status.yaml
```

**Note**: After implementing this in codev-skeleton, run `codev import` on our own project to adopt the new structure.

**Status.yaml format (pure YAML):**
```yaml
id: "0073"
title: "user-auth"
protocol: "spider"
state: "specify:review"
worktree: "worktrees/spider_0073_user-auth"

gates:
  specify_approval: { status: pending }
  plan_approval: { status: pending }

phases:
  phase_1: { status: complete }
  phase_2: { status: in_progress }

iteration: 5
started_at: "2026-01-19T10:00:00Z"
last_updated: "2026-01-19T10:15:00Z"

log:
  - ts: "2026-01-19T10:00:00Z"
    event: "state_change"
    to: "specify:draft"
```

**Files to modify:**
- `packages/codev/src/commands/porch/index.ts` - Update state management
- Create `packages/codev/src/commands/porch/state.ts` - Dedicated state module

**File locking and concurrency:**
- Implement `flock()` advisory locking on status.yaml during writes
- Detect and reject concurrent `porch run` on same project
- Safe concurrent reads via shared lock

**Crash recovery:**
- Check for `.tmp` file on startup → use if valid, delete if corrupt
- Re-run current phase on resume (idempotent design)
- Log recovery actions to status.yaml log

#### Acceptance Criteria
- [ ] Status files use pure YAML format
- [ ] Projects stored in `codev/projects/<id>/`
- [ ] TICK/BUGFIX state in `codev/executions/`
- [ ] Atomic writes (tmp file + fsync + rename)
- [ ] File locking prevents concurrent writes
- [ ] Crash recovery works correctly

#### Test Plan
- **Unit Tests**: State file parsing, atomic write operations
- **Integration Tests**: Project initialization creates correct structure

---

### Phase 2: Standalone Porch Binary

**Dependencies**: Phase 1

#### Objectives
- Extract porch to standalone command (not `codev porch`)
- Add `bin/porch.js` entry point
- Update package.json

#### Deliverables
- [ ] `bin/porch.js` entry point
- [ ] Updated package.json with `porch` binary
- [ ] CLI argument parsing for porch commands

#### Implementation Details

**New binary in package.json:**
```json
{
  "bin": {
    "codev": "./bin/codev.js",
    "porch": "./bin/porch.js",  // NEW
    "af": "./bin/af.js",
    "consult": "./bin/consult.js"
  }
}
```

**CLI commands:**
```bash
# Protocol discovery
porch list-protocols              # List available protocols
porch show-protocol spider        # Show protocol definition

# Project management
porch list-projects               # List all projects and their states
porch init --protocol=spider --project-id=0073   # Initialize project
porch status 0073                 # Show specific project status

# Execution (REPL mode)
porch run 0073                    # Start protocol REPL for project
                                  # (protocol determined from status.yaml)
                                  # User can Ctrl+C to pause, resumes on next run

# Dry-run mode (for testing)
porch run 0073 --dry-run          # Show what would execute without running
porch run 0073 --no-claude        # Skip Claude invocations (mock mode)

# Gate management
porch approve 0073 specify_approval   # Approve a gate
porch reject 0073 specify_approval    # Reject with feedback prompt
```

**REPL behavior:**
- `porch run` starts an interactive loop
- State is checkpointed after each phase transition
- User can press Escape or Ctrl+C to pause
- Re-running `porch run 0073` resumes from last checkpoint
- `--dry-run` shows state machine transitions without executing

**Files to create:**
- `bin/porch.js` - Entry point
- `packages/codev/src/porch-cli.ts` - Standalone CLI

#### Acceptance Criteria
- [ ] `porch` command works after npm install
- [ ] All subcommands functional
- [ ] Proper error messages and help text

#### Test Plan
- **Unit Tests**: CLI argument parsing
- **Integration Tests**: Full command execution

---

### Phase 3: Plan Phase Extraction, IDE Loop, and Checks

**Dependencies**: Phase 1

#### Objectives
- Parse plan markdown to extract phases
- Implement IDE loop (implement → defend → evaluate per phase)
- Track phase completion in status
- Implement signal parsing and timeout handling
- Add defense checks (build/test commands)

#### Deliverables
- [ ] Plan parser for `### Phase N: <title>` headers
- [ ] IDE loop implementation
- [ ] Phase tracking in status.yaml
- [ ] Signal parser for `<signal>...</signal>` tags
- [ ] Timeout handling for Claude invocations
- [ ] Defense checks (build/test) with retry logic

#### Implementation Details

**Plan parsing rules:**
1. Find `## Implementation Phases` or `## Phases` heading
2. Extract `### Phase N: <title>` headers
3. Store phase list in status.yaml

**State transitions for phased phases:**
```
implement:phase_1 → defend:phase_1 → evaluate:phase_1 →
implement:phase_2 → defend:phase_2 → evaluate:phase_2 →
...
review
```

**Files to create:**
- `packages/codev/src/commands/porch/plan-parser.ts`
- `packages/codev/src/commands/porch/signal-parser.ts`
- `packages/codev/src/commands/porch/checks.ts`

**Files to modify:**
- `packages/codev/src/commands/porch/index.ts` - Add IDE loop logic

**Signal parsing:**
```typescript
// signal-parser.ts
export function extractSignal(output: string): string | null {
  // Scan for <signal>...</signal> pattern
  // Return LAST signal found (multiple signals → last wins)
  // Return null if no signal found
}

export function validateSignal(signal: string, phase: string, protocol: Protocol): boolean {
  // Check if signal is valid for the current phase
  // Return false for unknown signals (log warning)
}
```

**Timeout handling:**
```typescript
// In index.ts
const claudeProcess = spawn('claude', args, { timeout: config.claude_timeout });
claudeProcess.on('timeout', () => {
  // Kill process
  // Retry with exponential backoff
  // After max_retries → escalate to human
});
```

**Defense checks:**
```typescript
// checks.ts
export async function runChecks(phase: Phase, projectRoot: string): Promise<CheckResult> {
  for (const [name, check] of Object.entries(phase.checks || {})) {
    const result = await runCommand(check.command, { cwd: projectRoot });
    if (!result.success) {
      if (check.on_fail === 'retry') {
        // Retry up to max_retries with delay
      } else {
        // Return to specified phase
        return { success: false, returnTo: check.on_fail };
      }
    }
  }
  return { success: true };
}
```

#### Acceptance Criteria
- [ ] Plan phases correctly extracted
- [ ] IDE loop runs for each phase
- [ ] Phase status tracked in status.yaml
- [ ] Fallback to single phase if no structured phases found
- [ ] Signals correctly parsed from Claude output
- [ ] Timeout triggers retry with backoff
- [ ] Defense checks run after implement/defend phases
- [ ] Failed checks trigger retry or phase return

#### Test Plan
- **Unit Tests**: Plan parsing, phase extraction, signal parsing, timeout handling
- **Integration Tests**: Full IDE loop execution (with --no-claude), defense checks

---

### Phase 4: Multi-Agent Consultation Loop

**Dependencies**: Phase 2, Phase 3

#### Objectives
- Implement 3-way parallel consultation
- Feedback collection into consultation-*.md files
- Revision loop until all approve or max rounds

#### Deliverables
- [ ] Consultation orchestration code
- [ ] Feedback file generation
- [ ] Revision loop logic

#### Implementation Details

**Consultation flow:**
1. Claude drafts → signals `SPEC_DRAFTED`
2. State becomes `specify:consult`
3. Porch runs 3-way parallel: `consult --model gemini/codex/claude`
4. Collect feedback into `consultation-specify-round-N.md`
5. If all APPROVE → proceed to human gate
6. If any REQUEST_CHANGES:
   - Pass feedback to Claude for revision
   - Re-run consultation (round N+1)
   - Repeat until all APPROVE or max_consultation_rounds

**Protocol schema extension (already in spec):**
```json
{
  "consultation": {
    "on": "consult",
    "models": ["gemini", "codex", "claude"],
    "type": "spec-review",
    "parallel": true,
    "max_rounds": 3,
    "next": "specify:revise"
  }
}
```

**Files to create:**
- `packages/codev/src/commands/porch/consultation.ts`

**Files to modify:**
- `packages/codev/src/commands/porch/types.ts` - Add consultation types
- `packages/codev/src/commands/porch/index.ts` - Integrate consultation

#### Acceptance Criteria
- [ ] 3-way consultation runs in parallel
- [ ] Feedback collected in structured format
- [ ] Loop continues until all approve
- [ ] Max rounds enforced (escalate to human if stuck)

#### Test Plan
- **Unit Tests**: Feedback parsing, verdict extraction
- **Integration Tests**: Full consultation loop with mock consult

---

### Phase 5: AF Integration, Kickoff, and Notifications

**Dependencies**: Phase 1, Phase 2

#### Objectives
- Rename `af spawn` to `af kickoff`
- Create worktrees at `worktrees/<protocol>_<id>_<name>/`
- Start porch in worktree
- Implement architect notification system

#### Deliverables
- [ ] `af kickoff` command
- [ ] Worktree creation in `worktrees/`
- [ ] Porch process management
- [ ] Architect notification (file-based polling)
- [ ] Dashboard pending gates display
- [ ] Sample `.claude/hooks/porch-notify.sh` hook

#### Implementation Details

**Command changes:**
```bash
af kickoff 0073              # Create worktree + start porch
af status                    # Show all projects
af status 0073               # Show specific project
af stop 0073                 # Stop porch (worktree persists)
af resume 0073               # Resume porch in existing worktree
af cleanup 0073              # Remove worktree (after complete/abandoned)
```

**Worktree naming (extensible for any protocol):**
- Pattern: `worktrees/<protocol>_<id>_<name>`
- Examples:
  - SPIDER: `worktrees/spider_0073_user-auth`
  - TICK: `worktrees/tick_0073_add-feature`
  - BUGFIX: `worktrees/bugfix_142`
  - MAINTAIN: `worktrees/maintain_2026-01`
  - RELEASE: `worktrees/release_v2.0.0`
  - Custom: `worktrees/<protocol-name>_<id>_<name>`

**Files to modify:**
- `packages/codev/src/agent-farm/index.ts` - Rename spawn → kickoff
- `packages/codev/src/agent-farm/worktree.ts` - Update paths
- `packages/codev/src/agent-farm/dashboard.ts` - Add pending gates display

**Files to create:**
- `codev-skeleton/.claude/hooks/porch-notify.sh` - Sample notification hook

**Architect notification system:**

1. **File-based polling** (status.yaml already has gate status):
   ```typescript
   // In af status command
   function getPendingGates(): PendingGate[] {
     const projects = glob('codev/projects/*/status.yaml');
     const executions = glob('codev/executions/*/status.yaml');
     return [...projects, ...executions]
       .map(parseStatusFile)
       .filter(s => hasPendingGates(s))
       .map(formatPendingGate);
   }
   ```

2. **Dashboard display**:
   ```
   af status --pending

   PENDING GATES:
   0073 user-auth     specify_approval    "Spec ready for review"
   0074 billing       plan_approval       "Plan ready for review"
   ```

3. **Claude hook** (for architect Claude):
   ```bash
   # .claude/hooks/porch-notify.sh
   #!/bin/bash
   # Check for pending gates on each prompt
   for f in codev/projects/*/status.yaml codev/executions/*/status.yaml; do
     if grep -q "status: pending" "$f" 2>/dev/null; then
       project=$(basename $(dirname "$f"))
       echo "⚠️ Gate pending: $project"
     fi
   done
   ```

#### Acceptance Criteria
- [ ] `af kickoff` creates worktree in correct location
- [ ] `af kickoff` starts porch process
- [ ] `af status 0073` shows project state
- [ ] `af status --pending` shows only pending gates
- [ ] Dashboard shows pending gates prominently
- [ ] Sample hook included in skeleton
- [ ] Legacy `af spawn` still works (deprecated warning)

#### Test Plan
- **Unit Tests**: Worktree path generation, pending gate detection
- **Integration Tests**: Full kickoff → stop → resume cycle, notification flow

---

### Phase 6: Protocol JSON Definitions (SPIDER, TICK, BUGFIX)

**Dependencies**: None (can be done in parallel)

#### Objectives
- Create protocol.json files for SPIDER, TICK, BUGFIX
- Keep protocol.md alongside for human reference
- Update skeleton structure
- Define distinct behaviors for each protocol

#### Deliverables
- [ ] `codev-skeleton/protocols/spider/protocol.json`
- [ ] `codev-skeleton/protocols/tick/protocol.json`
- [ ] `codev-skeleton/protocols/bugfix/protocol.json`
- [ ] Prompts in protocol-specific directories
- [ ] Security/permission configurations per protocol

#### Implementation Details

**New structure:**
```
codev-skeleton/protocols/
├── spider/
│   ├── protocol.json
│   ├── protocol.md      # Human reference (kept)
│   └── prompts/
│       ├── specify.md
│       ├── plan.md
│       └── ...
├── tick/
│   ├── protocol.json
│   ├── protocol.md
│   └── prompts/
└── bugfix/
    ├── protocol.json
    ├── protocol.md
    └── prompts/
```

**SPIDER protocol.json (key parts):**
```json
{
  "name": "spider",
  "version": "2.0.0",
  "phases": [
    {
      "id": "specify",
      "substates": ["draft", "consult", "revise"],
      "signals": { "SPEC_DRAFTED": "specify:consult" },
      "consultation": {
        "on": "consult",
        "models": ["gemini", "codex", "claude"],
        "type": "spec-review"
      },
      "gate": { "after": "revise", "type": "human", "next": "plan:draft" }
    }
  ],
  "permissions": {
    "specify": ["read:*"],
    "plan": ["read:*"],
    "implement": ["write:src/**", "bash:npm *"],
    "defend": ["write:tests/**", "bash:npm test"],
    "review": ["read:*"]
  }
}
```

**TICK protocol.json (simplified, no gates):**
```json
{
  "name": "tick",
  "version": "1.0.0",
  "description": "Fast amendments to existing specs",
  "phases": [
    {
      "id": "understand",
      "signals": { "UNDERSTOOD": "implement" }
    },
    {
      "id": "implement",
      "checks": { "build": { "command": "npm run build", "on_fail": "retry" } },
      "signals": { "IMPLEMENTED": "verify" }
    },
    {
      "id": "verify",
      "checks": { "tests": { "command": "npm test", "on_fail": "implement" } },
      "signals": { "VERIFIED": "complete" }
    },
    {
      "id": "complete",
      "terminal": true
    }
  ],
  "initial": "understand",
  "config": {
    "max_iterations": 20,
    "scope_limit_loc": 300
  }
}
```

**BUGFIX protocol.json (issue-driven, no gates):**
```json
{
  "name": "bugfix",
  "version": "1.0.0",
  "description": "GitHub issue bug fixes",
  "phases": [
    {
      "id": "diagnose",
      "signals": { "DIAGNOSED": "fix" }
    },
    {
      "id": "fix",
      "checks": { "build": { "command": "npm run build", "on_fail": "retry" } },
      "signals": { "FIXED": "test" }
    },
    {
      "id": "test",
      "checks": { "tests": { "command": "npm test", "on_fail": "fix" } },
      "signals": { "TESTED": "pr" }
    },
    {
      "id": "pr",
      "signals": { "PR_CREATED": "complete" }
    },
    {
      "id": "complete",
      "terminal": true
    }
  ],
  "initial": "diagnose",
  "config": {
    "source": "github_issue",
    "auto_pr": true
  }
}
```

**Key differences:**

| Feature | SPIDER | TICK | BUGFIX |
|---------|--------|------|--------|
| Human gates | Yes (specify, plan) | No | No |
| Consultation | Yes (3-way) | Optional | No |
| State location | `codev/projects/` | `codev/executions/` | `codev/executions/` |
| Scope | New features | Amendments | Issue fixes |
| Source | projectlist.md | Existing spec | GitHub issue |

#### Acceptance Criteria
- [ ] All three protocols defined in JSON
- [ ] protocol.md kept for human reference
- [ ] Porch loads protocols from new location
- [ ] Prompts organized per-protocol
- [ ] TICK runs without human gates
- [ ] BUGFIX integrates with GitHub issues
- [ ] Security permissions configured per phase

#### Test Plan
- **Unit Tests**: Protocol loading, schema validation
- **Integration Tests**: Run each protocol with --no-claude

---

### Phase 7: Documentation and Polish

**Dependencies**: All previous phases

#### Objectives
- Update CLAUDE.md/AGENTS.md with new commands
- Update command reference docs
- Add migration guide

#### Deliverables
- [ ] Updated CLAUDE.md with porch and af kickoff docs
- [ ] Updated codev/resources/commands/*.md
- [ ] Migration guide in CLAUDE.md

#### Implementation Details

**Key documentation updates:**
- CLI reference for `porch` command
- Updated `af` command reference (kickoff, status with ID)
- Three-level architecture explanation
- Migration instructions for Claude

#### Acceptance Criteria
- [ ] All new commands documented
- [ ] Migration path clear
- [ ] No broken internal links

#### Test Plan
- **Manual Testing**: Verify documentation accuracy

---

### Phase 8: Test Infrastructure

**Dependencies**: Phase 1, Phase 2, Phase 3 (can be developed in parallel)

#### Objectives
- Create comprehensive test infrastructure for porch
- Build fixtures: sample protocols, mock projects
- Implement E2E tests that create a project and follow it through the full protocol
- Enable `--dry-run` verification and mock modes

#### Deliverables
- [ ] Test fixtures directory with sample protocols
- [ ] Mock Claude/consult infrastructure
- [ ] E2E test suite for full protocol execution
- [ ] `porch test` command for running test suites
- [ ] CI integration

#### Implementation Details

**Test fixtures structure:**
```
packages/codev/src/commands/porch/__tests__/
├── fixtures/
│   ├── protocols/
│   │   ├── test-spider.json      # Simplified SPIDER for testing
│   │   └── test-simple.json      # 2-phase protocol for fast tests
│   ├── projects/
│   │   ├── sample-spec.md        # Sample spec for parsing tests
│   │   └── sample-plan.md        # Sample plan with phases
│   └── mock-responses/
│       ├── claude-specify.txt    # Mock Claude output with signals
│       └── consult-approve.txt   # Mock consultation approval
├── state.test.ts                 # State machine unit tests
├── plan-parser.test.ts           # Plan parsing unit tests
├── signal-parser.test.ts         # Signal extraction tests
├── consultation.test.ts          # Consultation loop tests
├── e2e/
│   ├── spider-full.test.ts       # Full SPIDER E2E
│   ├── tick-full.test.ts         # Full TICK E2E
│   └── dry-run.test.ts           # Dry-run verification
└── helpers/
    ├── mock-claude.ts            # Mock Claude subprocess
    ├── mock-consult.ts           # Mock consult tool
    └── test-project.ts           # Temp project creation
```

**Mock infrastructure:**

```typescript
// mock-claude.ts
export class MockClaude {
  private responses: Map<string, string>;

  constructor(responsesDir: string) {
    // Load mock responses from fixtures
  }

  // Returns mock output for a given phase
  getResponse(phase: string): string {
    return this.responses.get(phase) || '<signal>DEFAULT_COMPLETE</signal>';
  }
}

// Usage in tests:
const porch = new Porch({
  claudeAdapter: new MockClaude('./fixtures/mock-responses'),
  consultAdapter: new MockConsult({ verdicts: ['APPROVE', 'APPROVE', 'APPROVE'] })
});
```

**E2E test example:**

```typescript
// e2e/spider-full.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestProject, cleanupTestProject } from '../helpers/test-project';
import { MockClaude, MockConsult } from '../helpers/mocks';
import { Porch } from '../../index';

describe('SPIDER E2E', () => {
  let projectDir: string;
  let porch: Porch;

  beforeEach(async () => {
    projectDir = await createTestProject('spider', '9999');
    porch = new Porch({
      projectRoot: projectDir,
      claudeAdapter: new MockClaude(),
      consultAdapter: new MockConsult({ allApprove: true })
    });
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  it('follows full SPIDER protocol with mock gates', async () => {
    // Initialize
    await porch.init({ protocol: 'spider', projectId: '9999' });
    expect(porch.getState()).toBe('specify:draft');

    // Run specify phase (mock Claude emits SPEC_DRAFTED)
    await porch.runUntilGate();
    expect(porch.getState()).toBe('specify:consult');

    // Run consultation (mock all APPROVE)
    await porch.runUntilGate();
    expect(porch.getState()).toBe('specify:revise');

    // Approve gate
    await porch.approve('specify_approval');
    await porch.runUntilGate();
    expect(porch.getState()).toBe('plan:draft');

    // ... continue through all phases ...

    // Final state
    await porch.runToCompletion();
    expect(porch.getState()).toBe('complete');
  });

  it('handles REQUEST_CHANGES in consultation loop', async () => {
    const porch = new Porch({
      projectRoot: projectDir,
      consultAdapter: new MockConsult({
        verdicts: [
          ['APPROVE', 'REQUEST_CHANGES', 'APPROVE'], // Round 1
          ['APPROVE', 'APPROVE', 'APPROVE']           // Round 2
        ]
      })
    });

    // Should require 2 consultation rounds
    await porch.init({ protocol: 'spider', projectId: '9999' });
    await porch.runUntilGate();

    const status = porch.getStatus();
    expect(status.consultationRounds).toBe(2);
  });
});
```

**Dry-run test:**

```typescript
// e2e/dry-run.test.ts
it('dry-run shows state transitions without executing', async () => {
  const output = await porch.run('9999', { dryRun: true });

  expect(output).toContain('specify:draft → specify:consult');
  expect(output).toContain('[WOULD INVOKE] claude --print');
  expect(output).toContain('[WOULD INVOKE] consult --model gemini');
  expect(output).not.toContain('Error'); // No actual execution errors
});
```

**Test commands:**

```bash
# Run all porch tests
npm test -- packages/codev/src/commands/porch

# Run specific E2E suite
npm test -- packages/codev/src/commands/porch/__tests__/e2e

# Run with coverage
npm test -- --coverage packages/codev/src/commands/porch

# CI command (in package.json scripts)
"test:porch": "vitest run packages/codev/src/commands/porch/__tests__",
"test:porch:e2e": "vitest run packages/codev/src/commands/porch/__tests__/e2e"
```

#### Acceptance Criteria
- [ ] >80% code coverage on core state machine
- [ ] E2E tests pass for SPIDER, TICK, BUGFIX protocols
- [ ] Dry-run mode produces accurate execution plan
- [ ] Mock infrastructure allows testing without real Claude/consult
- [ ] Tests run in <30 seconds (unit) and <2 minutes (E2E)
- [ ] CI passes all tests before merge

#### Test Plan
- **Unit Tests**: State machine, parsers, signal extraction
- **Integration Tests**: Full phase transitions with mocks
- **E2E Tests**: Complete protocol execution with fixtures
- **Dry-run Tests**: Verify --dry-run output matches actual execution

#### Test Coverage Targets

| Module | Target | Focus |
|--------|--------|-------|
| state.ts | 95% | All state transitions, edge cases |
| plan-parser.ts | 90% | Various plan formats, fallbacks |
| signal-parser.ts | 95% | Signal extraction, malformed input |
| consultation.ts | 85% | Parallel execution, verdict handling |
| index.ts (main) | 80% | Integration of all components |

---

## Dependency Map

```
Phase 1 (Structure) ──┬──► Phase 2 (Standalone) ──┬──► Phase 4 (Consultation)
                      │                           │
                      │──► Phase 3 (IDE Loop) ────┘
                      │
                      │──► Phase 5 (AF Kickoff) ─────► Phase 7 (Docs)
                      │
                      └──► Phase 8 (Testing) ────────► All phases validated

Phase 6 (Protocol JSON) ───────────────────────────► Phase 7 (Docs)

Testing runs in parallel with development:
- Phase 8 starts with Phase 1 (test state machine first)
- Each phase adds tests for its components
- E2E tests validate full integration
```

## Resource Requirements

### Development Resources
- TypeScript/Node.js expertise
- Understanding of existing codev/af architecture

### Infrastructure
- No new infrastructure required
- All state is file-based

## Integration Points

### External Systems
- **claude CLI**: Subprocess invocation for LLM
  - Phase: 3, 4
  - Fallback: --no-claude flag for testing

- **consult CLI**: Multi-agent consultation
  - Phase: 4
  - Fallback: Mock consult for testing

### Internal Systems
- **af (Agent Farm)**: Worktree and process management
  - Phase: 5
  - Integration: af kickoff calls porch

## Risk Analysis

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Claude CLI subprocess instability | M | H | Robust error handling, retry logic |
| YAML parsing edge cases | L | M | Use established YAML library (js-yaml) |
| State file corruption | L | H | Atomic writes with fsync |
| Consultation timeout | M | M | Configurable timeout, skip mechanism |

### Schedule Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Phase 4 (consultation) complexity | M | M | Can ship without consultation loop initially |
| Migration complexity | L | M | Provide --legacy flag |

## Validation Checkpoints

1. **After Phase 1**: New project structure works, status files in correct location
   - Unit tests for state parsing pass
2. **After Phase 2**: `porch` command runs standalone
   - `porch --help` shows all commands
   - `porch list-protocols` works
3. **After Phase 3**: IDE loop processes multiple plan phases
   - E2E test with 3-phase plan completes all phases
4. **After Phase 4**: 3-way consultation loops correctly
   - Mock consultation test with REQUEST_CHANGES triggers revision
5. **After Phase 5**: `af kickoff` creates worktree and starts porch
   - Integration test: kickoff → stop → resume cycle
6. **After Phase 8**: Full test suite passes
   - >80% coverage on core modules
   - E2E tests for all protocols
   - `--dry-run` output verified
7. **Before Release**: Full SPIDER workflow tested end-to-end
   - Manual test with real Claude on sample project

## Documentation Updates Required

- [ ] CLAUDE.md - Three-level architecture, new commands
- [ ] codev/resources/commands/porch.md (new)
- [ ] codev/resources/commands/agent-farm.md - kickoff command
- [ ] codev/resources/arch.md - Porch architecture

## Post-Implementation Tasks

- [ ] End-to-end SPIDER protocol test
- [ ] End-to-end TICK protocol test
- [ ] End-to-end BUGFIX protocol test
- [ ] Performance validation (consultation timing)
- [ ] User acceptance testing with real project

## Expert Review

*To be completed after consultation*

## Approval

- [ ] Human Review
- [ ] Expert AI Consultation Complete (pending 3-way review)

## Change Log

| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-01-19 | Initial plan draft | Spec 0073 planning | Claude |

## Notes

- The spike implementation at `packages/codev/src/commands/porch/` provides a foundation
- We keep the existing `codev porch` subcommand for backward compatibility while adding standalone `porch`
- Protocol.md files are kept for human reference, not generated from JSON
- Multi-agent consultation loop is the most complex new feature

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
