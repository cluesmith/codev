# Specification 0006: Interactive Tutorial Mode

## Overview

An interactive tutorial system that walks new users through applying Codev/Agent Farm to their own projects. The tutorial should be contextual, adaptive, and provide hands-on experience with the development workflow.

## Goals

1. Help users understand how Codev fits into their development workflow
2. Walk through creating their first spec, plan, and implementation
3. Demonstrate the multi-agent consultation process
4. Show how to use the Architect/Builder pattern for larger projects
5. Provide immediate, practical value by working on the user's actual codebase

## User Experience

### Entry Point

```bash
# Start tutorial mode
npx agent-farm tutorial

# Or within an existing project
agent-farm tutorial
```

### Tutorial Flow

1. **Welcome & Project Detection**
   - Detect if user is in a git repository
   - Identify project type (Node.js, Python, etc.)
   - Explain what Codev/Agent Farm will do

2. **Setup Phase**
   - Initialize codev directory if needed
   - Explain the directory structure
   - Show where specs, plans, and reviews go

3. **First Spec Walkthrough**
   - Ask user what they want to build/fix
   - Guide them through creating a spec
   - Show the spec template and explain each section
   - Help them fill it out for their actual use case

4. **Planning Phase Demo**
   - Create a plan from their spec
   - Demonstrate multi-agent consultation (optional)
   - Show how to break work into steps

5. **Implementation Demo**
   - For simple tasks: Show TICK protocol
   - For complex tasks: Explain Architect/Builder pattern
   - Let them try a small implementation

6. **Review Phase**
   - Show how to use the annotation viewer
   - Explain the review process
   - Demonstrate lessons learned documentation

### Interactive Features

- Progress checkpoints that persist across sessions
- "Skip ahead" option for experienced users
- Context-aware hints based on their project
- Real examples from their codebase

## Technical Requirements

### Tutorial State

```typescript
interface TutorialState {
  projectPath: string;
  currentStep: string;
  completedSteps: string[];
  userResponses: Record<string, string>;
  startedAt: string;
  lastActiveAt: string;
}
```

### Steps Definition

Each step should:
- Have a clear objective
- Provide context and explanation
- Include hands-on exercises where applicable
- Allow skipping if user is confident
- Save progress automatically

### Integration with CLI

Add to agent-farm CLI:
```bash
agent-farm tutorial          # Start or resume tutorial
agent-farm tutorial --reset  # Start fresh
agent-farm tutorial --skip   # Skip current step
agent-farm tutorial --status # Show progress
```

## Content Outline

### Module 1: Introduction (5 min)
- What is Codev/Agent Farm?
- How it differs from just "using an AI assistant"
- The value of structured development

### Module 2: Project Setup (5 min)
- Directory structure
- Understanding protocols (SPIR vs TICK)
- When to use which

### Module 3: Your First Spec (10 min)
- Picking something small to start
- Writing a good specification
- Common pitfalls

### Module 4: Planning (10 min)
- Breaking down work
- Using multi-agent consultation
- Creating actionable plans

### Module 5: Implementation (15 min)
- Following the TICK protocol
- Writing tests as you go
- When to escalate to SPIR

### Module 6: Review & Iterate (5 min)
- Using the annotation viewer
- Documenting lessons learned
- Improving the process

## Success Criteria

1. User can run `agent-farm tutorial` and complete the introduction
2. Tutorial adapts to user's project type and structure
3. Progress persists between sessions
4. User completes at least one real spec by end of tutorial
5. Clear path to continue learning after tutorial

## Non-Goals

- Teaching general programming concepts
- Replacing project-specific documentation
- Fully automated project analysis

## Dependencies

- Spec 0005: TypeScript CLI (agent-farm package)
- Spec 0004: Dashboard Navigation UI (for annotation demo)

## Open Questions

1. Should tutorial be web-based or terminal-based?
2. How much should we automate vs. have user do manually?
3. Should we include video/animated content?
