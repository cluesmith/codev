# Specification: The Codev Book

## Metadata
- **ID**: 0050
- **Title**: The Codev Book: A Human-AI Software Development Operating System
- **Status**: draft (revised after 3-way consultation)
- **Created**: 2025-12-10
- **Priority**: high
- **Dependencies**: None (documentation of existing system)

---

## Executive Summary

This specification defines the structure, content, and publication strategy for "The Codev Book" - a comprehensive guide to the Codev methodology for human-AI collaborative software development. The book will be available in three formats: PDF (for offline reading), physical print (for those who prefer paper), and interactive online (with community annotations and corrections).

---

## Problem Statement

### The Gap

The AI-assisted coding landscape is chaotic. Developers face:
1. **Tool confusion**: Dozens of AI coding assistants with no unifying methodology
2. **Process vacuum**: No established workflows for human-AI collaboration
3. **Knowledge loss**: Insights from AI interactions evaporate after each session
4. **Scaling mystery**: Unclear how to coordinate multiple AI agents effectively
5. **Quality concerns**: No systematic approach to review and validate AI-generated code

### The Opportunity

Codev represents the first comprehensive "operating system" for human-AI software development. It provides:
- Structured protocols for different development scenarios
- Clear roles and responsibilities for humans and AI agents
- A memory architecture that accumulates wisdom over time
- Tools that operationalize the methodology

This knowledge exists in scattered markdown files across the codebase. **A book consolidates, explains, and evangelizes the Codev approach.**

---

## Vision & Positioning

### The Central Thesis

> **Codev is a Human-AI Software Development Operating System.**

Just as an operating system provides abstractions (processes, files, memory) that make hardware usable, Codev provides abstractions (protocols, roles, memory) that make AI collaboration productive.

### Core Principles

#### 1. Natural Language is the New Programming Language

Traditional programming required translating intent into syntax. With AI, we can express intent directly:
- Specifications replace pseudocode
- Plans replace implementation notes
- Reviews replace code comments

The skill shifts from "how do I write this code?" to "how do I express what I want clearly?"

#### 2. Multiple Models Outperform a Single Model

No single AI model is best at everything:
- Different models have different strengths (speed, depth, coding, reasoning)
- Consultation catches blind spots
- Consensus builds confidence
- Disagreement reveals complexity

Codev's `consult` tool operationalizes this principle.

#### 3. Coordination Models from Traditional Software Apply

Human software teams have developed coordination patterns over decades:
- **Architect/Builder separation** (design vs. implementation)
- **Code review** (quality gates)
- **Documentation standards** (specs, plans, reviews)
- **Version control workflows** (branches, PRs, merges)

These patterns translate directly to human-AI collaboration. Codev adapts them rather than inventing from scratch.

---

## Book Structure

### Part I: Foundations

#### Chapter 1: The AI Collaboration Crisis
<!-- REVIEW(@architect): I wouldn't call it a crisis. I would just say the challenge. And what I would say is that there is a huge opportunity by cooperatively working on things to materially move the needle on efficiency. Strike a positibe tone. -->
- The promise and chaos of AI-assisted development
- Why "just use ChatGPT" fails at scale
- The need for systematic methodology
- Introducing Codev: an operating system metaphor

#### Chapter 2: Core Principles
- Natural language as programming language
  - From code-first to intent-first development
  - The specification as the new unit of work
- Multiple models outperform single models
  - The wisdom of crowds, applied to AI
  - When to consult, what to ask
- Coordination patterns from traditional software
  - Standing on the shoulders of giants
  - What translates, what doesn't

<!-- REVIEW(@architect): Core concepts: give a brief introducion to all the core concpts in a first pass. -->
#### Chapter 3: The Memory Architecture
- Why AI conversations evaporate
- The four-level memory hierarchy:
  - **Level 0**: Institutional knowledge (arch.md, lessons-learned.md)
  - **Level 1**: Project state (projectlist.md)
  - **Level 2**: Project documentation (specs, plans, reviews)
  - **Level 3**: Source code
- How knowledge flows up and down the hierarchy
- The projectlist as the source of truth

### Part II: Core Concepts

<!-- REVIEW(@architect): Let's cll this the core concepts deep dive. -->
#### Chapter 4: Protocols - The Workflows
- **SPIDER**: Full development lifecycle
  - Specify → Plan → Implement → Defend → Evaluate → Review
  - When to use: new features, major changes
  - Walkthrough: implementing a feature end-to-end
- **TICK**: Lightweight amendments
  - For small, well-defined changes
  - Amending existing specs vs. creating new ones
- **EXPERIMENT**: Disciplined exploration
  - Hypothesis → Test → Learn
  - Managing technical uncertainty
- **MAINTAIN**: Codebase hygiene
  - Dead code removal
  - Documentation synchronization
  - The quarterly cleanup ritual

#### Chapter 5: Roles - The Cast of Characters
<!-- REVIEW(@architect): Roles come before PRotocols. -->
- **The Human**: Strategic direction, approval gates, domain expertise
- **The Architect**: Design, coordination, integration (human + primary AI)
- **The Builder**: Autonomous implementation in isolated worktrees
- **The Consultant**: Second opinions, blind spot detection
- Role boundaries and handoffs
- When roles blur and when they shouldn't

#### Chapter 6: Artifacts - The Documents
- **Specifications**: What to build and why
  - Structure and templates
  - The art of clear requirements
  - Common specification anti-patterns
- **Plans**: How to build it
  - Breaking specs into tasks
  - Addressing technical feasibility
  - The plan as a contract
- **Reviews**: What we learned
  - Post-implementation reflection
  - Extracting reusable lessons
  - The review as institutional memory

### Part III: The Tools

#### Chapter 7: The `codev` CLI
- Project initialization and adoption
- Health checks with `codev doctor`
- Framework updates with `codev update`
- The skeleton system

#### Chapter 8: Agent Farm (`af`)
- The Architect-Builder pattern in practice
- Starting the dashboard
- Spawning and managing builders
- Worktrees and isolation
- The annotation workflow

#### Chapter 9: The `consult` Tool
- Multi-model consultation
- Review types and when to use them
- Parallel vs. sequential consultation
- Interpreting disagreement

### Part IV: Putting It All Together

#### Chapter 10: A Complete Walkthrough
- From idea to integrated feature
- All protocols, roles, and tools in action
- Real examples from Codev's own development
- Common pitfalls and how to avoid them

#### Chapter 11: Scaling Codev
- Multiple projects, multiple teams
- The tower pattern for related projects
- Cross-project dependencies
- When Codev is overkill

#### Chapter 12: Extending Codev
- Creating custom protocols
- Adding new roles
- Tool integrations
- Contributing back

### Part V: Philosophy & Future
<!-- REVIEW(@architect): Delete this section altogether. -->

#### Chapter 13: The Human Element
- What humans do better (and worse) than AI
- Maintaining agency in AI collaboration
- The approval gates: conceived→specified, committed→integrated
- Avoiding learned helplessness

#### Chapter 14: Where We're Heading
- The evolution of AI capabilities
- What stays constant, what changes
- Codev's design for adaptability
- The vision: invisible coordination

### Appendices

#### Appendix A: Quick Reference
- Protocol summaries (1-page each)
- Role cheat sheets
- Command reference

#### Appendix B: Templates
- Specification template
- Plan template
- Review template

#### Appendix C: Troubleshooting
- Common errors and solutions
- "It's not working" decision tree

#### Appendix D: Glossary
- Terms and definitions

---

## Publishing Platform Analysis

### Requirements

| Requirement | Priority | Notes |
|-------------|----------|-------|
| PDF export (high-quality) | Must have | For offline reading, sharing |
| Physical print capability | Must have | Print-on-demand integration |
| Interactive online version | Must have | Primary reading experience |
| Community annotations | Must have | Comments, corrections, suggestions |
| Code syntax highlighting | Must have | Technical book requirement |
| Cross-references | Must have | Links between chapters/sections |
| Version control friendly | Should have | Markdown source in git |
| Search functionality | Should have | For online version |
| Mobile-responsive | Should have | Reading on phones/tablets |
| Dark mode | Nice to have | Eye comfort |
| Multiple languages | Future | Translation capability |

### Platform Comparison

#### Option A: Quarto (Recommended)

**Description**: Modern scientific and technical publishing system from Posit (formerly RStudio). Pandoc-based, supports multiple output formats from single source.

**Strengths**:
- Single source → PDF (via LaTeX), HTML, EPUB
<!-- REVIEW(@architect): I really really hate latex. What is the input? I would really like the input to be markdown. -->
- Excellent code block handling with syntax highlighting
- Native support for callouts, cross-references, citations
- Active development, growing ecosystem
- Markdown-based, git-friendly
- Can integrate Hypothesis for annotations

**Weaknesses**:
- Requires some setup (Python/R environment)
- LaTeX for PDF means occasional formatting battles
- Less mature than some alternatives

**Annotation Strategy**: Integrate [Hypothesis](https://web.hypothes.is/) overlay for community annotations on the HTML version.

**Print Strategy**: Generate PDF, use [Amazon KDP](https://kdp.amazon.com/) or [IngramSpark](https://www.ingramspark.com/) for print-on-demand.

#### Option B: GitBook

**Description**: Popular documentation platform with web-based editor.

**Strengths**:
- Polished web reading experience
- Built-in comments and change suggestions
- No local toolchain needed
- Good PDF export

**Weaknesses**:
- Limited free tier (1 public space)
- PDF quality not as good as LaTeX
- Vendor lock-in concerns
- Less control over output

#### Option C: Asciidoctor

**Description**: Professional publishing toolchain used by O'Reilly Media.

**Strengths**:
- Battle-tested for technical books
- Excellent print quality
- Highly customizable
- Open source

**Weaknesses**:
- Steeper learning curve
- Less modern web output
- Smaller community than Markdown-based tools

#### Option D: mdBook (Rust)

**Description**: Lightweight documentation tool from the Rust ecosystem.

**Strengths**:
- Fast, simple
- Clean HTML output
- Good search

**Weaknesses**:
- Limited PDF support
- No built-in annotation
- Minimal customization

### Recommendation

**Primary: Quarto + Hypothesis + Amazon KDP**

This combination provides:
1. **Online**: Quarto HTML output hosted on GitHub Pages or Netlify, with Hypothesis annotations
2. **PDF**: Quarto PDF output via LaTeX for high-quality offline reading
3. **Print**: PDF submitted to Amazon KDP for print-on-demand physical copies
4. **Community**: Hypothesis allows anyone to annotate, with annotations visible to all readers

**Alternative**: If Quarto proves too complex, fall back to mdBook for online + Leanpub for PDF/print.

---

## Community Engagement Model

### Annotation System

Using Hypothesis for community annotations:

1. **Anyone can annotate**: Readers highlight text and add comments
2. **Public visibility**: Annotations visible to all readers
3. **Author response**: Author can reply, acknowledge corrections
4. **Periodic incorporation**: Corrections folded into official text during updates

### Contribution Workflow

1. **Minor corrections**: Annotate via Hypothesis, author incorporates
2. **Significant changes**: Open GitHub issue with proposed edit
3. **New content**: Submit PR against book source
4. **Translation**: Coordinate via GitHub Discussions

### Version Strategy

- **Rolling updates**: Online version updated continuously
- **Versioned releases**: PDF/print versions numbered (v1.0, v1.1, etc.)
- **Changelog**: Track significant changes between versions

---

## Content Guidelines

### Tone & Style

- **Conversational but precise**: Accessible without being imprecise
- **Opinionated with rationale**: State preferences, explain why
- **Example-driven**: Abstract concepts illustrated with concrete cases
- **Self-aware**: Acknowledge limitations, uncertainties
- **Inclusive**: Assume reader is intelligent but unfamiliar with Codev

### Code Examples

- Use real examples from Codev's own development
- Keep examples minimal but complete
- Include both success and failure cases
- Show actual terminal output where relevant

### Visual Elements

- **Diagrams**: Memory hierarchy, protocol flows, role interactions
- **Screenshots**: Dashboard, terminal output
- **Tables**: Comparison matrices, quick references
- **Callouts**: Tips, warnings, notes

---

## Success Criteria

### Quantitative

- [ ] Book covers all protocols (SPIDER, TICK, EXPERIMENT, MAINTAIN)
- [ ] Book covers all roles (Human, Architect, Builder, Consultant)
- [ ] Book covers all tools (codev, af, consult)
- [ ] At least one worked example per protocol
- [ ] PDF renders correctly (no LaTeX errors)
- [ ] Print proof approved (physical quality check)
- [ ] Online version loads in < 3 seconds
- [ ] Hypothesis annotations functional

### Qualitative

- [ ] A developer unfamiliar with Codev can follow the walkthrough
- [ ] A skeptic understands the "why" behind the methodology
- [ ] Community annotations appear within first month
- [ ] At least one correction incorporated from community feedback

---

## Open Questions

1. **Title**: Is "The Codev Book" the final title? Alternatives:
   - "Human-AI Development: The Codev Operating System"
   <!-- REVIEW(@architect): Human-AI Co-development: The Codev operating system. -->
   - "Codev: A Methodology for AI-Assisted Software Development"
   - "The AI Development Handbook"

2. **Scope**: Should the book cover:
   - Only Codev methodology (narrower, more focused)?
   <!-- REVIEW(@architect): Specifically codev. -->
   - Broader AI-assisted development context (wider appeal)?

3. **Length**: Target page count?
<!-- REVIEW(@architect): As long as it needs to be. Bias towards shorter. -->
   - ~100 pages (concise guide)
   - ~200 pages (comprehensive handbook)
   - ~300+ pages (complete reference)

4. **Pricing**: For PDF/print versions:
   - Free (maximize reach)
   <!-- REVIEW(@architect): Free. -->
   - Pay-what-you-want (Leanpub model)
   - Fixed price (traditional publishing)

5. **Timeline**: When should v1.0 be ready?

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Codev evolves faster than book | High | Version the book, treat it as snapshot with updates |
| LaTeX formatting issues | Medium | Test PDF generation early and often |
| Low community engagement | Medium | Seed with author annotations, promote on social media |
| Scope creep | High | Strict outline adherence, save extras for v2 |
| Writing fatigue | High | Break into sprints, celebrate milestones |

---

## Dependencies

### Technical

- Quarto installation and configuration
- Hypothesis integration
- GitHub Pages or Netlify hosting
- Amazon KDP or IngramSpark account

### Content

- All existing Codev documentation (protocols, roles, templates)
- Example projects for walkthroughs
- Diagrams and visual assets

### Review

- Technical review: Codev developers
- Editorial review: Technical writer or editor
- Community review: Beta readers

---

## Repository & Source Strategy

### Source Location

The book source will live in the **main codev monorepo** under `docs/book/`:

```
codev/
├── docs/
│   └── book/
│       ├── _quarto.yml        # Quarto configuration
│       ├── index.qmd          # Front matter
│       ├── part1/             # Foundations
│       ├── part2/             # Core Concepts
│       ├── part3/             # The Tools
│       ├── part4/             # Putting It All Together
│       ├── part5/             # Philosophy & Future
│       ├── appendices/        # Quick reference, templates, etc.
│       └── _assets/           # Diagrams, screenshots
├── codev/                     # Existing codev directory
└── packages/                  # NPM packages
```

**Rationale**: Keeping the book in the monorepo ensures version alignment - when protocols change, the book can be updated in the same PR.

### Relationship to Existing Documentation

- **The book is downstream** - It synthesizes and explains existing protocol.md, CLAUDE.md, and role files
- **The book does NOT replace** - Protocol files remain the canonical implementation reference
- **Bidirectional updates** - Lessons from book writing may improve protocol documentation
- **Cross-references** - Book links to specific protocol.md lines; protocol files link to relevant book chapters

### Build & Publish Pipeline

```yaml
# .github/workflows/book.yml
on:
  push:
    paths: ['docs/book/**']
  workflow_dispatch:

jobs:
  build:
    - Setup Quarto
    - Render HTML → GitHub Pages
    - Render PDF → Artifact
    - On tag: Upload PDF to GitHub Release + Amazon KDP
```

---

## Testing & Validation Strategy

### Automated Checks (CI)

| Check | Tool | Frequency |
|-------|------|-----------|
| Markdown lint | markdownlint | Every PR |
| Broken links | lychee | Every PR |
| Spelling | cspell with technical dictionary | Every PR |
| Code block syntax | Quarto render | Every PR |
| Build PDF | Quarto + LaTeX | Every PR |
| Build HTML | Quarto | Every PR |

### Manual Review Process

1. **Technical Accuracy Review** (per chapter)
   - Reviewer: Codev developer or author
   - Checklist:
     - [ ] All commands actually work
     - [ ] Code examples are correct
     - [ ] Protocol descriptions match current implementation
     - [ ] Screenshots are current

2. **Editorial Review** (full book)
   - Reviewer: Technical editor (internal or contracted)
   - Focus: Clarity, consistency, grammar, flow

3. **Beta Reader Program** (before v1.0)
   - 5-10 readers unfamiliar with Codev
   - 2-week feedback window
   - Structured feedback form:
     - "Where did you get lost?"
     - "What's missing?"
     - "What would you cut?"

4. **Print Proof Review** (before KDP publish)
   - Order physical proof copy
   - Check: margins, font size, code readability, image quality
   - Sign-off required before release

### Acceptance Criteria

Before marking a chapter "complete":
- [ ] Automated checks pass
- [ ] Technical review approved
- [ ] At least one worked example tested end-to-end
- [ ] Cross-references validated

Before v1.0 release:
- [ ] All chapters complete
- [ ] Editorial review complete
- [ ] Beta reader feedback incorporated
- [ ] Print proof approved
- [ ] Hypothesis integration tested on staging

---

## Edge Cases & Mitigation

| Edge Case | Impact | Mitigation |
|-----------|--------|------------|
| **Hypothesis service outage** | Medium | Annotations lost during outage; book still readable. Evaluate self-hosted Hypothesis if critical. |
| **Hypothesis terms change** | High | Monitor ToS updates; have mdBook fallback without annotations. Consider Giscus (GitHub Discussions) as alternative. |
| **Amazon KDP rejects book** | Medium | Use IngramSpark as alternative; ensure content policy compliance during writing. |
| **LaTeX formatting breaks** | Medium | Test PDF early and often; maintain fallback to HTML-to-PDF (weasyprint) if needed. |
| **Annotations reference outdated text** | High | Use "annotation migration" during major updates: export annotations, map to new line numbers where possible, flag orphaned annotations for review. |
| **Codev evolves mid-writing** | High | Freeze protocol version for v1.0; document "as of Codev v1.x". Major protocol changes trigger book update sprint. |
| **Community spam/harassment** | Medium | See Moderation Policy below. |
| **External links rot** | Low | Quarterly link audit via lychee; prefer permalinks (GitHub commit hashes) for external code references. |
| **Accessibility failures** | Medium | Ensure alt-text for images, heading hierarchy for screen readers, sufficient color contrast. Run WAVE/axe checks. |

### Fallback Plan

If Quarto + Hypothesis proves unworkable (> 2 sprints of formatting battles):
1. **Switch to mdBook** for HTML output (simpler, faster)
2. **Use Leanpub** for PDF/EPUB (handles formatting, has PWYW model)
3. **Use Giscus** for page-level comments (GitHub Discussions-backed, less granular than Hypothesis)

---

## Annotation Moderation Policy

### Acceptable Use

Annotations should be:
- **On-topic**: Related to the book content
- **Constructive**: Questions, corrections, clarifications, suggestions
- **Respectful**: No personal attacks, harassment, or discrimination

### Prohibited Content

- Spam or promotional content
- Malicious links
- Personal attacks or harassment
- Off-topic discussions
- Copyrighted content without permission

### Moderation Workflow

1. **Author monitoring**: Author reviews new annotations weekly
2. **Community flagging**: Readers can flag inappropriate annotations via Hypothesis
3. **Response time**: Flagged annotations reviewed within 7 days
4. **Actions**:
   - **Spam**: Delete immediately, report to Hypothesis
   - **Harassment**: Delete, warn user, escalate repeat offenders
   - **Off-topic**: Reply asking to move to GitHub Discussions, leave annotation
   - **Corrections**: Thank, incorporate if valid, reply with status

### Identity

- Hypothesis requires account creation (reduces anonymous spam)
- Author's annotations marked distinctly (author response capability)
- No identity verification beyond Hypothesis account

---

## Visual Assets Strategy

### Diagram Types

| Diagram | Format | Tool | Location |
|---------|--------|------|----------|
| Memory hierarchy | SVG | Mermaid or Excalidraw | `_assets/diagrams/` |
| Protocol flows | SVG | Mermaid | `_assets/diagrams/` |
| Role interactions | SVG | Excalidraw | `_assets/diagrams/` |
| Architecture overview | SVG | Excalidraw | `_assets/diagrams/` |

### Screenshot Strategy

- **Source**: Captured from actual Codev usage
- **Format**: PNG for screenshots, SVG for diagrams
- **Versioning**: Regenerate on major UI changes
- **Annotation**: Use Skitch or similar for callout arrows
- **Location**: `_assets/screenshots/`

### Creation Workflow

1. **Author creates** initial diagrams (doesn't need to be polished)
2. **Designer polish** (optional) - if professional quality needed
3. **Store source files** - Excalidraw JSON, Mermaid source in repo
4. **Export to SVG/PNG** - Committed alongside source

### Licensing

- All diagrams created for the book are **CC BY-SA 4.0**
- Screenshots of Codev are owned by the project
- Third-party screenshots (if any) require permission

---

## Walkthrough Example Projects

The following Codev projects will be used as worked examples:

| Chapter | Example Project | Spec |
|---------|-----------------|------|
| Chapter 4 (SPIDER) | Test Infrastructure | 0001 |
| Chapter 4 (TICK) | Hide tmux Status Bar | 0012 |
| Chapter 4 (EXPERIMENT) | Preview Annotations (prototype) | 0049 |
| Chapter 8 (Agent Farm) | Architect-Builder Pattern | 0002 |
| Chapter 9 (Consult) | Markdown Preview | 0048 |
| Chapter 10 (Walkthrough) | Full end-to-end example | 0050 (this book!) |

**Rationale**: Using real Codev projects demonstrates dogfooding and provides concrete, verifiable examples.

---

## Open Questions - Recommendations

Based on the 3-way consultation and analysis, here are recommendations for the open questions:

### 1. Title

**Recommendation**: "Codev: The Human-AI Software Development Operating System"
<!-- REVIEW(@architect): Yes to this. -->

- Positions Codev as the subject (brandable)
- "Operating System" metaphor is central to the thesis
- Clear what it's about

**Alternatives to consider**:
- "The Codev Handbook" (more practical, less conceptual)
- Keep "The Codev Book" (simple, memorable)

### 2. Scope

**Recommendation**: Focus on Codev methodology with minimal broader context

<!-- REVIEW(@architect): Yes -->
- Chapter 1 provides context (AI chaos, need for methodology)
- Chapters 2-12 are pure Codev
- Keeps book focused and authoritative
- Broader AI development can be separate blog posts/talks

### 3. Length

**Recommendation**: ~200 pages (comprehensive handbook)

<!-- REVIEW(@architect): However long it needs to be. -->
- 100 pages too short for proper walkthroughs
- 300+ pages risks scope creep and writing fatigue
- ~200 pages = ~15 pages/chapter average, manageable

### 4. Pricing

**Recommendation**: Free online, PWYW for PDF/print

- **Online HTML**: Free (maximize reach, community annotations)
- **PDF download**: Pay-what-you-want via Gumroad or similar ($0 minimum)
- **Print**: Cost + small margin via KDP (~$15-20)

**Rationale**: Codev is open source; the book should be accessible. PWYW allows those who can pay to support the work.

### 5. Timeline

**Recommendation**: v1.0 by Q2 2025

Sprint plan:
- **Sprint 1** (Dec 2024): Platform setup, Part I (Chapters 1-3)
- **Sprint 2** (Jan 2025): Part II (Chapters 4-6)
- **Sprint 3** (Feb 2025): Part III (Chapters 7-9)
- **Sprint 4** (Mar 2025): Part IV & V (Chapters 10-14), Appendices
- **Sprint 5** (Apr 2025): Editorial review, beta readers, polish
- **Release** (May 2025): v1.0 online + PDF + print

---

## Expert Consultation Notes

### 3-Way Review Summary (2025-12-10)

| Model | Verdict | Time | Confidence |
|-------|---------|------|------------|
| Gemini | APPROVE | 25.4s | HIGH |
| Codex | REQUEST_CHANGES | 17.4s | HIGH |
| Claude | REQUEST_CHANGES | 58.4s | HIGH |

### Key Issues Identified

1. **Documentation Drift** (Gemini)
   - Need to clarify book's relationship to existing protocol.md files
   - **Addressed**: Added "Repository & Source Strategy" section

2. **Open Questions Unresolved** (Codex, Claude)
   - Title, scope, length, pricing, timeline undefined
   - **Addressed**: Added "Open Questions - Recommendations" section

3. **No Testing Strategy** (Codex, Claude)
   - Build validation, technical review, beta readers undefined
   - **Addressed**: Added "Testing & Validation Strategy" section

4. **Moderation Policy Missing** (Gemini, Codex, Claude)
   - Spam/harassment handling for Hypothesis annotations
   - **Addressed**: Added "Annotation Moderation Policy" section

5. **Edge Cases Unaddressed** (Codex, Claude)
   - Hypothesis outage, version-sync, accessibility
   - **Addressed**: Added "Edge Cases & Mitigation" section

6. **Visual Assets Underspecified** (Claude)
   - Creation, tooling, versioning unclear
   - **Addressed**: Added "Visual Assets Strategy" section

7. **Example Projects Undefined** (Claude)
   - Which projects for walkthroughs?
   - **Addressed**: Added "Walkthrough Example Projects" section

### Reviewer Suggestions Incorporated

- Repository strategy: Book in monorepo (Gemini)
- Automated testing: Link checking, markdown lint (Gemini, Codex)
- Annotation migration strategy (Claude)
- Fallback plan if Quarto fails (Claude)
- Accessibility considerations (Codex)

---

## Approval

- [ ] Author approval of scope and structure
- [ ] Technical review of platform recommendation
- [ ] Community input on open questions
