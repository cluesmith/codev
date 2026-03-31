# Spec 0027: README Core Flow Clarity

## Context

HN post #2 (Mar 1, 2026) drove 14 GitHub stars in 48 hours — our best conversion yet. But two independent commenters gave the same feedback:

- **yodon** (spec-kit power user): "Five minutes into reading your home page and medium post and some of your repo docs, I'm ready to believe this is true, but I have no idea what that core flow is or looks like."
- **skydhash**: "I couldn't have guessed otherwise" what codev is from the description.

The getting-started page at codevos.ai/getting-started has a clear 4-step flow (spec → spawn → plan → walk away), but visitors from GitHub never see it. The README's Quick Start section shows **setup** (install, init, doctor) but not **usage** (the actual day-to-day workflow).

## Problem

After `codev init`, the README says: *"Then tell your AI agent: 'I want to build X using the SPIR protocol'"* — this is vague and doesn't convey what the experience actually looks like. Visitors bounce before understanding the value proposition.

## Goal

A visitor should understand what they'd actually *do* with codev within 30 seconds of landing on the README. The core flow should be visible above the fold (before any scrolling on a standard screen).

## Requirements

### 1. Add "How It Works" section immediately after Quick Start

Show the 4-step usage flow with concrete commands:

```
## How It Works

1. **Write a spec** — Describe what you want. The architect helps refine it.
2. **Spawn a builder** — `afx spawn 42` kicks off an autonomous agent in an isolated worktree.
3. **Review the plan** — The builder writes an implementation plan. You approve or annotate.
4. **Walk away** — The builder implements, tests, and opens a PR. You review and merge.
```

### 2. Fix the post-init instruction

Replace the vague "tell your AI agent" line with a concrete next step, e.g.:

```
Then open a GitHub Issue describing what you want to build, and run:
afx spawn <issue-number>
```

### 3. Reframe the one-liner

The current one-liner is: "Codev is an operating system for structured human-AI collaboration. You write specs and plans that AI agents execute reliably."

This tells people what it IS in abstract terms but not what it DOES concretely. Consider something like:

"Codev turns GitHub Issues into tested, reviewed PRs. You write specs; autonomous AI builders handle the rest."

### 4. Link to getting-started

Add a prominent link to `https://codevos.ai/getting-started` right after Quick Start for the full walkthrough.

## Non-Goals

- Don't restructure the entire README — this is a targeted clarity fix
- Don't remove existing content (production metrics, SPIR explanation, etc.)
- Don't change the actual CLI commands or workflow

## Success Criteria

- A developer landing on the README can describe what codev does and how they'd use it within 30 seconds
- The 4-step flow is visible without scrolling past the Quick Start section
