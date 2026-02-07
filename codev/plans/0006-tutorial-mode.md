# Plan: Interactive Tutorial Mode

## Metadata
- **Spec**: codev/specs/0006-tutorial-mode.md
- **Protocol**: TICK (well-defined, single-file changes, < 300 lines per step)
- **Created**: 2025-12-04

## Overview

Add an interactive terminal-based tutorial command to agent-farm CLI that walks new users through the Codev/Agent Farm workflow. The tutorial will be contextual (adapts to project type), persistent (saves progress), and hands-on (creates real files).

## Key Design Decisions

### Terminal-Based (Not Web-Based)
The spec left this open. Terminal-based is better because:
- Aligns with existing CLI patterns (`af start`, `af spawn`)
- No additional HTTP server infrastructure needed
- Works in headless environments (CI/CD, SSH)
- Users stay in their natural development environment
- Simpler implementation using Commander.js prompts

### State Storage Location
Tutorial state stored at `.agent-farm/tutorial.json`:
- Follows existing state pattern (`.agent-farm/state.json`)
- Per-project, not global (user might have different progress per project)
- JSON format for easy serialization

### Step Architecture
Steps are modular TypeScript functions that can:
- Display content via `logger`
- Ask questions via `readline` or simple prompts
- Perform file operations (create codev dirs, files)
- Check preconditions (git repo, project type)
- Return success/skip/abort status

## Implementation Steps

### Step 1: Add TutorialState Type and State Management

**File**: `agent-farm/src/types.ts`

Add tutorial state interface:
```typescript
export interface TutorialStep {
  id: string;
  title: string;
  completed: boolean;
}

export interface TutorialState {
  projectPath: string;
  currentStep: string;
  completedSteps: string[];
  userResponses: Record<string, string>;
  startedAt: string;
  lastActiveAt: string;
}
```

**File**: `agent-farm/src/utils/tutorial-state.ts`

Create new file for tutorial state management:
```typescript
export async function loadTutorialState(): Promise<TutorialState | null>
export async function saveTutorialState(state: TutorialState): Promise<void>
export async function resetTutorialState(): Promise<void>
```

### Step 2: Create Tutorial Command Handler

**File**: `agent-farm/src/commands/tutorial.ts`

Main command logic:
```typescript
export interface TutorialOptions {
  reset?: boolean;
  skip?: boolean;
  status?: boolean;
}

export async function tutorial(options: TutorialOptions): Promise<void>
```

**File**: `agent-farm/src/index.ts`

Register command:
```typescript
program
  .command('tutorial')
  .description('Interactive tutorial for new users')
  .option('--reset', 'Start tutorial fresh')
  .option('--skip', 'Skip current step')
  .option('--status', 'Show tutorial progress')
  .action(async (options) => {
    const { tutorial } = await import('./commands/tutorial.js');
    await tutorial(options);
  });
```

### Step 3: Implement Step Runner Infrastructure

**File**: `agent-farm/src/tutorial/runner.ts`

Step runner that:
- Loads/saves state automatically
- Displays step header and instructions
- Handles user input (y/n, free text, selection)
- Tracks completion

```typescript
export interface StepContext {
  state: TutorialState;
  projectPath: string;
  projectType: 'nodejs' | 'python' | 'other';
  hasGit: boolean;
  hasCodev: boolean;
}

export interface StepResult {
  status: 'completed' | 'skipped' | 'aborted';
  responses?: Record<string, string>;
}

export type StepFunction = (ctx: StepContext) => Promise<StepResult>;

export interface Step {
  id: string;
  title: string;
  run: StepFunction;
}

export async function runTutorial(steps: Step[]): Promise<void>
```

### Step 4: Implement Tutorial Steps (Modules 1-6)

**File**: `agent-farm/src/tutorial/steps/index.ts`

Export all steps:
```typescript
export { welcomeStep } from './welcome.js';
export { setupStep } from './setup.js';
export { firstSpecStep } from './first-spec.js';
export { planningStep } from './planning.js';
export { implementationStep } from './implementation.js';
export { reviewStep } from './review.js';
```

Each step file implements `StepFunction`:

**Module 1: Welcome & Project Detection** (`welcome.ts`)
- Detect git repo (`git rev-parse --git-dir`)
- Detect project type (package.json → nodejs, pyproject.toml → python)
- Explain Codev value proposition
- Ask if user wants to continue

**Module 2: Setup Phase** (`setup.ts`)
- Check if codev/ exists, offer to create
- Explain directory structure
- Show where specs/plans/reviews go
- Offer to install sample files

**Module 3: First Spec Walkthrough** (`first-spec.ts`)
- Ask user what they want to build (freeform)
- Suggest small, achievable scope
- Show spec template
- Guide them through sections
- Create `codev/specs/0001-tutorial-task.md`

**Module 4: Planning Phase** (`planning.ts`)
- Read the spec they created
- Show plan template
- Explain breaking work into phases
- Create `codev/plans/0001-tutorial-task.md`
- Mention multi-agent consultation (brief)

**Module 5: Implementation Demo** (`implementation.ts`)
- Explain TICK vs SPIR choice
- Show how to use `af spawn`
- Demonstrate basic workflow
- Point to documentation for more

**Module 6: Review & Next Steps** (`review.ts`)
- Show annotation viewer (`af annotate`)
- Explain review process
- Point to resources for deeper learning
- Mark tutorial complete

### Step 5: Add Simple Prompt Utilities

**File**: `agent-farm/src/tutorial/prompts.ts`

Simple readline-based prompts:
```typescript
export async function confirm(message: string): Promise<boolean>
export async function prompt(message: string): Promise<string>
export async function select(message: string, options: string[]): Promise<string>
export function section(title: string): void
export function content(text: string): void
```

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `agent-farm/src/types.ts` | Modify | Add TutorialState interface |
| `agent-farm/src/index.ts` | Modify | Register tutorial command |
| `agent-farm/src/commands/tutorial.ts` | Create | Command handler |
| `agent-farm/src/tutorial/runner.ts` | Create | Step runner infrastructure |
| `agent-farm/src/tutorial/prompts.ts` | Create | Input utilities |
| `agent-farm/src/tutorial/steps/index.ts` | Create | Step exports |
| `agent-farm/src/tutorial/steps/welcome.ts` | Create | Module 1 |
| `agent-farm/src/tutorial/steps/setup.ts` | Create | Module 2 |
| `agent-farm/src/tutorial/steps/first-spec.ts` | Create | Module 3 |
| `agent-farm/src/tutorial/steps/planning.ts` | Create | Module 4 |
| `agent-farm/src/tutorial/steps/implementation.ts` | Create | Module 5 |
| `agent-farm/src/tutorial/steps/review.ts` | Create | Module 6 |

## Testing Checklist

- [ ] `af tutorial` starts tutorial for new user
- [ ] Tutorial detects git repo (shows warning if not)
- [ ] Tutorial detects project type (Node.js, Python, Other)
- [ ] Progress persists across sessions
- [ ] `af tutorial --reset` clears progress
- [ ] `af tutorial --skip` advances to next step
- [ ] `af tutorial --status` shows current progress
- [ ] Ctrl+C exits gracefully with saved progress
- [ ] Tutorial creates real `codev/specs/0001-*.md` file
- [ ] Tutorial creates real `codev/plans/0001-*.md` file
- [ ] All steps complete without error on fresh project
- [ ] Works on macOS and Linux

## Risks

| Risk | Mitigation |
|------|------------|
| readline issues with different terminals | Use simple prompts, test in various terminals |
| State file corruption | JSON parse with fallback to fresh state |
| User confusion with large output | Keep each step focused and concise |

## Simplifications from Spec

Deferring for v1:
- Video/animated content (not practical for CLI)
- Web-based tutorial (terminal-based is simpler)
- Context-aware hints from codebase (basic project type detection only)
- Multi-agent consultation demo (just mention it exists)

## Estimated Complexity

- Types: ~20 lines
- Command handler: ~50 lines
- Runner: ~100 lines
- Prompts: ~50 lines
- Steps (6 files): ~400 lines total
- **Total**: ~620 lines across 12 files

Appropriate for TICK with multiple focused commits.

## Implementation Order

1. Types + State management
2. Command registration + basic handler
3. Prompt utilities
4. Step runner infrastructure
5. Steps 1-2 (welcome, setup)
6. Steps 3-4 (spec, plan)
7. Steps 5-6 (implementation, review)
8. Testing and polish
