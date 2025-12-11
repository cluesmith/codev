# Plan 0050: The Codev Book

**Spec:** codev/specs/0050-codev-book.md
**Protocol:** SPIDER
**Strategy:** Massively parallel - one builder per chapter

---

## Overview

This plan is designed for parallel execution. After infrastructure setup, each chapter can be written independently by a separate builder. All builders work in isolated worktrees and create PRs that are integrated sequentially.

**Key decisions from spec review:**
- Title: "Human-AI Co-development: The Codev Operating System"
- Tone: Positive, opportunity-focused (not "crisis")
- Part V deleted (was Philosophy & Future)
- Order: Roles before Protocols in Part II
- Human + Architect treated as single unit (not separated)
- "Artifacts" renamed to "The Documents"
- Length: As long as needed, bias towards shorter
- Pricing: Free
- No CI workflow (build locally)

## Directory Structure

```
docs/book/
├── _quarto.yml           # Quarto configuration
├── index.qmd             # Front matter, preface
├── part1/
│   ├── _part.qmd         # Part I intro
│   ├── ch01-opportunity.qmd
│   ├── ch02-principles.qmd
│   ├── ch03-concepts-overview.qmd   # NEW: Core concepts overview
│   └── ch04-memory.qmd
├── part2/
│   ├── _part.qmd         # Part II intro (Core Concepts Deep Dive)
│   ├── ch05-roles.qmd
│   ├── ch06-protocols.qmd
│   └── ch07-documents.qmd           # Renamed from "artifacts"
├── part3/
│   ├── _part.qmd         # Part III intro (The Tools)
│   ├── ch08-codev-cli.qmd
│   ├── ch09-agent-farm.qmd
│   └── ch10-consult.qmd
├── part4/
│   ├── _part.qmd         # Part IV intro (Putting It All Together)
│   ├── ch11-walkthrough.qmd
│   ├── ch12-scaling.qmd
│   └── ch13-extending.qmd
├── appendices/
│   ├── a-reference.qmd
│   ├── b-templates.qmd
│   ├── c-troubleshooting.qmd
│   └── d-glossary.qmd
└── _assets/
    ├── diagrams/
    └── screenshots/
```

---

## Phase 0: Infrastructure (Sequential - Architect)

**Must complete before spawning chapter builders.**

### 0.1 Create Directory Structure

```bash
mkdir -p docs/book/{part1,part2,part3,part4,appendices,_assets/{diagrams,screenshots}}
```

### 0.2 Create Quarto Configuration

```yaml
# docs/book/_quarto.yml
project:
  type: book
  output-dir: _book

book:
  title: "Human-AI Co-development: The Codev Operating System"
  author: "The Codev Project"
  date: last-modified
  chapters:
    - index.qmd
    - part: "Part I: Foundations"
      chapters:
        - part1/ch01-opportunity.qmd
        - part1/ch02-principles.qmd
        - part1/ch03-concepts-overview.qmd
        - part1/ch04-memory.qmd
    - part: "Part II: Core Concepts Deep Dive"
      chapters:
        - part2/ch05-roles.qmd
        - part2/ch06-protocols.qmd
        - part2/ch07-documents.qmd
    - part: "Part III: The Tools"
      chapters:
        - part3/ch08-codev-cli.qmd
        - part3/ch09-agent-farm.qmd
        - part3/ch10-consult.qmd
    - part: "Part IV: Putting It All Together"
      chapters:
        - part4/ch11-walkthrough.qmd
        - part4/ch12-scaling.qmd
        - part4/ch13-extending.qmd
    - part: "Appendices"
      chapters:
        - appendices/a-reference.qmd
        - appendices/b-templates.qmd
        - appendices/c-troubleshooting.qmd
        - appendices/d-glossary.qmd

format:
  html:
    theme: cosmo
    toc: true
    toc-depth: 3
  pdf:
    documentclass: scrbook
    papersize: letter
    toc: true
    number-sections: true
    colorlinks: true
```

### 0.3 Create Stub Files

Create minimal stub for each chapter so Quarto can render:

```qmd
# Chapter Title {#chNN}

::: {.callout-note}
This chapter is under development.
:::
```

### 0.4 Verify Build

```bash
cd docs/book && quarto render --to html
```

### Exit Criteria (Phase 0)

- [ ] Directory structure created
- [ ] `_quarto.yml` configured
- [ ] All stub files in place
- [ ] `quarto render` succeeds (HTML)
- [ ] PR merged to main

---

## Parallel Phase: Chapter Writing

**Each chapter is independent. Spawn one builder per chapter.**

### Builder Spawn Commands

```bash
# Part I: Foundations
af spawn --task "Write Chapter 1: The AI Collaboration Opportunity (positive tone about efficiency gains through human-AI cooperation)" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part1/ch01-opportunity.qmd"
af spawn --task "Write Chapter 2: Core Principles" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part1/ch02-principles.qmd"
af spawn --task "Write Chapter 3: Core Concepts Overview (brief intro to all core concepts: roles, protocols, documents, memory)" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part1/ch03-concepts-overview.qmd"
af spawn --task "Write Chapter 4: The Memory Architecture" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part1/ch04-memory.qmd"

# Part II: Core Concepts Deep Dive
af spawn --task "Write Chapter 5: Roles (Human-Architect as one unit, Builder, Consultant)" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part2/ch05-roles.qmd,codev/roles/architect.md,codev/roles/builder.md"
af spawn --task "Write Chapter 6: Protocols - The Workflows" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part2/ch06-protocols.qmd,codev/protocols/spider/protocol.md,codev/protocols/tick/protocol.md"
af spawn --task "Write Chapter 7: The Documents (specs, plans, reviews)" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part2/ch07-documents.qmd"

# Part III: The Tools
af spawn --task "Write Chapter 8: The codev CLI" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part3/ch08-codev-cli.qmd,codev/docs/commands/codev.md"
af spawn --task "Write Chapter 9: Agent Farm (af) - include commands overview table" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part3/ch09-agent-farm.qmd,codev/docs/commands/agent-farm.md"
af spawn --task "Write Chapter 10: The consult Tool" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part3/ch10-consult.qmd,codev/docs/commands/consult.md"

# Part IV: Putting It All Together
af spawn --task "Write Chapter 11: A Complete Walkthrough" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part4/ch11-walkthrough.qmd"
af spawn --task "Write Chapter 12: Scaling Codev" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part4/ch12-scaling.qmd"
af spawn --task "Write Chapter 13: Extending Codev" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/part4/ch13-extending.qmd"

# Appendices
af spawn --task "Write Appendix A: Quick Reference" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/appendices/a-reference.qmd"
af spawn --task "Write Appendix B: Templates" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/appendices/b-templates.qmd"
af spawn --task "Write Appendix C: Troubleshooting" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/appendices/c-troubleshooting.qmd"
af spawn --task "Write Appendix D: Glossary" --files "codev/specs/0050-codev-book.md,codev/plans/0050-codev-book.md,docs/book/appendices/d-glossary.qmd"
```

---

## Chapter Specifications

### Chapter 1: The AI Collaboration Opportunity

**File:** `docs/book/part1/ch01-opportunity.qmd`
**Tone:** Positive, opportunity-focused

**Outline:**
1. The promise of AI-assisted development
2. The current challenge: tools without methodology
3. The opportunity: dramatic efficiency gains through cooperation
4. Why systematic methodology matters
5. Introducing Codev: an operating system metaphor

**Key points:**
- Open with the exciting potential (not doom/gloom)
- Frame challenges as opportunities
- End with the OS metaphor that frames the rest of the book

---

### Chapter 2: Core Principles

**File:** `docs/book/part1/ch02-principles.qmd`

**Outline:**
1. Natural language as programming language
   - From code-first to intent-first
   - The specification as the new unit of work
2. Multiple models outperform single models
   - Wisdom of crowds applied to AI
   - When to consult, what to ask
3. Coordination patterns from traditional software
   - Standing on giants' shoulders
   - What translates, what doesn't

---

### Chapter 3: Core Concepts Overview (NEW)

**File:** `docs/book/part1/ch03-concepts-overview.qmd`

**Purpose:** Brief introduction to all core concepts before the deep dive in Part II.

**Outline:**
1. The four pillars of Codev:
   - **Roles**: Who does what (Human-Architect, Builder, Consultant)
   - **Protocols**: How work flows (SPIDER, TICK, EXPERIMENT, MAINTAIN)
   - **Documents**: What gets produced (specs, plans, reviews)
   - **Memory**: How knowledge persists (projectlist, institutional knowledge)
2. How the pieces fit together
3. Preview of Part II deep dives

**Key points:**
- This is the "map" before the "territory"
- Keep it brief - details come in Part II
- Use a diagram showing how concepts relate

---

### Chapter 4: The Memory Architecture

**File:** `docs/book/part1/ch04-memory.qmd`

**Outline:**
1. Why AI conversations evaporate
2. The four-level memory hierarchy:
   - Level 0: Institutional knowledge (arch.md, lessons-learned.md)
   - Level 1: Project state (projectlist.md)
   - Level 2: Project documentation (specs, plans, reviews)
   - Level 3: Source code
3. How knowledge flows up and down
4. The projectlist as source of truth

**Include:** Mermaid diagram of the hierarchy

---

### Chapter 5: Roles

**File:** `docs/book/part2/ch05-roles.qmd`

**Outline:**
1. Why roles matter
2. **The Human-Architect**: Strategic direction, design, coordination, approval gates
   - The human and AI architect work as a single unit
   - Human provides domain expertise and final approval
   - AI provides analysis, drafting, and execution
3. **The Builder**: Autonomous implementation in isolated worktrees
4. **The Consultant**: Second opinions, blind spot detection
5. Role boundaries and handoffs

**Note:** Human and Architect are NOT separated - they form one collaborative unit.

**Sources:**
- `codev/roles/architect.md`
- `codev/roles/builder.md`
- `codev/roles/consultant.md`

---

### Chapter 6: Protocols - The Workflows

**File:** `docs/book/part2/ch06-protocols.qmd`

**Outline:**
1. What is a protocol?
2. **SPIDER**: Full development lifecycle
3. **TICK**: Lightweight amendments
4. **EXPERIMENT**: Disciplined exploration
5. **MAINTAIN**: Codebase hygiene
6. Protocol selection flowchart

**Sources:**
- `codev/protocols/spider/protocol.md`
- `codev/protocols/tick/protocol.md`
- `codev/protocols/experiment/protocol.md`
- `codev/protocols/maintain/protocol.md`

---

### Chapter 7: The Documents

**File:** `docs/book/part2/ch07-documents.qmd`

**Outline:**
1. Documentation as first-class output
2. **Specifications**: What to build and why
3. **Plans**: How to build it
4. **Reviews**: What we learned

---

### Chapter 8: The `codev` CLI

**File:** `docs/book/part3/ch08-codev-cli.qmd`

**Outline:**
1. Installation
2. `codev init` - Creating new projects
3. `codev adopt` - Adding to existing projects
4. `codev doctor` - Health checks
5. `codev update` - Framework updates

---

### Chapter 9: Agent Farm (`af`)

**File:** `docs/book/part3/ch09-agent-farm.qmd`

**Outline:**
1. The Architect-Builder pattern
2. **Commands Overview** (table of all commands):
   | Command | Description |
   |---------|-------------|
   | `af start` | Start the dashboard |
   | `af stop` | Stop all processes |
   | `af spawn` | Spawn a builder |
   | `af status` | Check builder status |
   | `af send` | Send message to builder |
   | `af cleanup` | Remove completed builders |
   | `af open` | Open file in viewer |
   | `af util` | Open utility shell |
   | `af rename` | Rename a builder |
   | `af db` | Database management |
3. Starting the dashboard
4. Spawning builders (spec, task, protocol, shell modes)
5. Managing builders
6. The dashboard UI

---

### Chapter 10: The `consult` Tool

**File:** `docs/book/part3/ch10-consult.qmd`

**Outline:**
1. Why multi-model consultation?
2. Basic usage
3. Review types
4. Parallel consultation
5. Interpreting disagreement

---

### Chapter 11: A Complete Walkthrough

**File:** `docs/book/part4/ch11-walkthrough.qmd`

**Outline:**
1. The scenario: Adding a new feature
2. Phase by phase walkthrough
3. Common pitfalls and recovery

**Note:** Use real example from Codev's own development.

---

### Chapter 12: Scaling Codev

**File:** `docs/book/part4/ch12-scaling.qmd`

**Outline:**
1. Multiple projects, multiple teams
2. The tower pattern
3. Cross-project dependencies
4. When Codev is overkill

---

### Chapter 13: Extending Codev

**File:** `docs/book/part4/ch13-extending.qmd`

**Outline:**
1. Creating custom protocols
2. Adding new roles
3. Tool integrations
4. Contributing back

---

### Appendix A: Quick Reference

- Protocol summaries (1-page each)
- Role cheat sheets
- Command reference tables

---

### Appendix B: Templates

- Specification template
- Plan template
- Review template

---

### Appendix C: Troubleshooting

- Common errors and solutions
- Decision tree

---

### Appendix D: Glossary

- Terms and definitions

---

## Builder Instructions Template

Each builder receives:

```markdown
## Your Task

Write [CHAPTER_NAME] for The Codev Book.

## Writing Guidelines

1. **Tone**: Conversational but precise. Positive and opportunity-focused.
2. **Length**: As long as needed, bias towards shorter
3. **Format**: Quarto markdown (.qmd)
4. **Code examples**: Use real examples from Codev
5. **Cross-references**: Use Quarto `@sec-` syntax

## Quarto Syntax

```qmd
# Chapter Title {#sec-chapter-id}

::: {.callout-tip}
Helpful tip here
:::

See @sec-other-chapter for details.
```

## Deliverables

1. Complete chapter content
2. Any diagrams in docs/book/_assets/diagrams/
3. PR with chapter content
```

---

## Integration Phase (Sequential)

After all chapter PRs are merged:

1. **Editorial Review** - Consistency, cross-references, formatting
2. **Visual Assets** - Diagrams, screenshots, alt-text
3. **PDF Verification** - Render, check formatting
4. **Deploy** - Host HTML (method TBD)

---

## Success Criteria

- [ ] All 13 chapters + 4 appendices written
- [ ] Quarto renders HTML successfully
- [ ] Quarto renders PDF successfully
- [ ] All cross-references valid
- [ ] Code examples verified
- [ ] Editorial review complete

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Inconsistent style across builders | Editorial review pass |
| Cross-reference issues | Builders use placeholder refs; fix in integration |
| Quarto/LaTeX issues | Test PDF build early |
| Merge conflicts | Each chapter in separate file |
