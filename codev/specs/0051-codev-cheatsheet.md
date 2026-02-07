# Spec 0051: Codev Cheatsheet

**Status:** planned
**Protocol:** SPIR
**Priority:** High
**Dependencies:** None

---

## Overview

Create a comprehensive cheatsheet documenting Codev's philosophies, concepts, and tools. This serves as both onboarding material and quick reference.

---

## Requirements

### 1. Core Philosophies (3)

#### Philosophy 1: Natural Language is the Programming Language

- Specs and plans are as important as code
- The spec IS the requirements; the plan IS the design
- Code is the implementation of well-defined natural language artifacts
- AI agents translate natural language to code, making the spec/plan primary

#### Philosophy 2: Multiple Models Outperform a Single Model

- Claude serves as architect and builder (primary agent)
- Gemini, Codex, Claude used as consultants for reviews
- 3-way reviews catch issues single models miss
- Different models have different strengths/blind spots

#### Philosophy 3: Human-Agent Work Requires Thoughtful Structure

- Just like structuring a human team
- Well-defined protocols (SPIR, TICK, MAINTAIN, EXPERIMENT)
- Clear roles (Architect, Builder, Consultant)
- Leverage parallelism to scale (multiple builders, parallel reviews)

### 2. Core Concepts

#### Protocols
Bullet points for each:
- **SPIR**: Full development cycle (Specify → Plan → Implement → Defend → Evaluate → Review)
- **TICK**: Amendments to existing specs (fast, lightweight)
- **MAINTAIN**: Periodic maintenance (code hygiene, documentation sync)
- **EXPERIMENT**: Disciplined experimentation with clear hypotheses

#### Roles
- **Architect**: Orchestrates development, writes specs/plans, reviews PRs, maintains big picture
- **Builder**: Implements specs in isolated worktrees, writes tests, creates PRs
- **Consultant**: External reviewers (Gemini, Codex, Claude) providing second opinions
  - Different flavors via `--type`: spec-review, plan-review, impl-review, integration-review

#### Information Hierarchy (Top → Bottom)
```
┌─────────────────────────────────────────┐
│  arch.md, lessons-learned.md            │  ← System understanding
├─────────────────────────────────────────┤
│  projectlist.md                         │  ← Project tracking
├─────────────────────────────────────────┤
│  specs/, plans/, reviews/               │  ← Feature artifacts
├─────────────────────────────────────────┤
│  Source code                            │  ← Implementation
└─────────────────────────────────────────┘
```

### 3. Tools Section

#### codev
- `codev init <name>` - Create new project
- `codev adopt` - Add codev to existing project
- `codev doctor` - Check dependencies
- `codev update` - Update framework
- `codev tower` - Cross-project dashboard

#### agent-farm (af)
- `af start` - Start dashboard
- `af stop` - Stop all processes
- `af spawn -p <id>` - Spawn builder for project
- `af status` - Check builder status
- `af send <id> <msg>` - Send message to builder
- `af cleanup -p <id>` - Clean up builder
- `af open <file>` - Open file in dashboard

#### consult
- `consult --model <model> spec <id>` - Review a spec
- `consult --model <model> plan <id>` - Review a plan
- `consult --model <model> pr <id>` - Review a PR
- `consult --model <model> general "<query>"` - General query
- `--type <type>` - Use stage-specific prompt (spec-review, plan-review, impl-review, integration-review)
- Models: gemini, codex, claude (aliases: pro, gpt, opus)

### 4. Integration

- Link cheatsheet from CLAUDE.md (add to Quick Start or new section)
- Link cheatsheet from README.md (add to documentation section)
- File location: `codev/resources/cheatsheet.md`

---

## Success Criteria

- [ ] Cheatsheet created at `codev/resources/cheatsheet.md`
- [ ] Three philosophies clearly explained with corollaries
- [ ] All protocols listed with brief descriptions
- [ ] Roles explained including consultant flavors
- [ ] Information hierarchy visualized
- [ ] All tools documented with key commands/parameters
- [ ] CLAUDE.md links to cheatsheet
- [ ] README.md links to cheatsheet
