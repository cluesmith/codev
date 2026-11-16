# Codev Project Lifecycle

Every project in Codev flows through a series of stages from idea to production. This document explains each stage and how projects progress through the lifecycle.

## Lifecycle Overview

```
conceived → specified → planned → implementing → implemented → committed → integrated
```

## Stages

### 1. Conceived

**What it means:** An idea has been captured. A spec file may exist but hasn't been approved yet.

**Who does it:** Anyone can conceive a project by describing what they want to build.

**What happens next:** A Builder (AI) writes the specification; the Architect reviews it at the spec gate and the human approves it.

**Artifact:** Draft specification in `codev/specs/<id>-<name>.md`

---

### 2. Specified

**What it means:** The specification has been approved by a human.

**Who does it:** Only a human can approve a specification and mark it as specified.

**What happens next:** The Builder writes an implementation plan.

**Artifact:** Approved specification in `codev/specs/<id>-<name>.md`

---

### 3. Planned

**What it means:** An implementation plan exists that describes how to build the feature.

**Who does it:** The Builder (AI) writes the plan; the Architect reviews it at the plan gate and the human approves it.

**What happens next:** The same Builder implements the plan.

**Artifact:** Implementation plan in `codev/plans/<id>-<name>.md`

---

### 4. Implementing

**What it means:** Active development is in progress. A Builder is working on the code.

**Who does it:** A Builder (AI agent) in an isolated git worktree.

**What happens next:** Builder completes implementation and creates a PR.

**Artifact:** Code changes in a builder worktree, work in progress

---

### 5. Implemented

**What it means:** Code is complete, tests pass, and a Pull Request has been created.

**Who does it:** The Builder creates the PR after completing implementation.

**What happens next:** The Architect reviews the PR, Builder addresses feedback, then merges.

**Artifact:** Open Pull Request ready for review

---

### 6. Committed

**What it means:** The PR has been merged to the main branch.

**Who does it:** The Builder merges after approval from the Architect's review.

**What happens next:** Human validates in production and marks as integrated.

**Artifact:** Merged PR, code on main branch

---

### 7. Integrated

**What it means:** The feature has been validated in production and the project is complete.

**Who does it:** Only a human can mark a project as integrated after validating it works.

**What happens next:** Nothing - the project is complete! A review document captures lessons learned.

**Artifact:** Review document in `codev/reviews/<id>-<name>.md`

---

## Terminal States

Projects can also end up in terminal states if they won't be completed:

### Abandoned

The project was canceled or rejected. It will not be implemented. Close the GitHub Issue with a comment explaining why.

### On-Hold

The project is temporarily paused but may resume later. The notes field should explain the reason and any conditions for resuming.

---

## Human Approval Gates

Porch stops at each protocol's human gates — AI agents cannot bypass them. Each protocol's
`protocol.json` defines its gates:

| Protocol | Gates |
|----------|-------|
| SPIR | `spec-approval`, `plan-approval`, `pr`, `verify-approval` |
| ASPIR | `pr`, `verify-approval` |
| AIR, BUGFIX | `pr` |
| PIR | `plan-approval`, `dev-approval`, `pr` |
| MAINTAIN | `maintain-complete` |
| RESEARCH | `scope-approval`, `research-complete` |
| EXPERIMENT | `experiment-complete` |

In lifecycle terms, SPIR's `spec-approval` moves a project from conceived to specified, and
`verify-approval` (post-merge validation) from committed to integrated:

```
conceived → [spec-approval] → specified → [plan-approval] → planned → implementing → implemented → [pr] → committed → [verify-approval] → integrated
```

The human decides; the Architect relays the decision to the Builder, and the Builder runs
`porch approve <id> <gate> --a-human-explicitly-approved-this`.

---

## Managing Projects

Project tracking uses **GitHub Issues**. To manage projects:

- **Add a project:** Create a GitHub Issue describing what you want to build
- **Update status:** Update issue labels and comments as work progresses
- **Approve stages:** Review the spec/plan/PR and give the Architect your decision; the Architect relays it and the Builder runs `porch approve`
- **View progress:** Check the Work tab in the dashboard or `gh issue list`

---

## Quick Reference

| Stage | Artifact | Who Advances |
|-------|----------|--------------|
| Conceived | Draft spec | Builder writes, Architect reviews, human approves |
| Specified | Approved spec | Builder writes the plan |
| Planned | Implementation plan | Builder implements |
| Implementing | WIP code | Builder completes |
| Implemented | Open PR | Architect reviews, Builder merges |
| Committed | Merged PR | Human validates |
| Integrated | Review doc | Complete |
