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

**What happens next:** The Architect (AI) writes a specification. The human reviews and approves it.

**Artifact:** Draft specification in `codev/specs/NNNN-name.md`

---

### 2. Specified

**What it means:** The specification has been approved by a human.

**Who does it:** Only a human can approve a specification and mark it as specified.

**What happens next:** The Architect creates an implementation plan.

**Artifact:** Approved specification in `codev/specs/NNNN-name.md`

---

### 3. Planned

**What it means:** An implementation plan exists that describes how to build the feature.

**Who does it:** The Architect (AI) creates the plan, human reviews it.

**What happens next:** A Builder is spawned to implement the plan.

**Artifact:** Implementation plan in `codev/plans/NNNN-name.md`

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

**Artifact:** Review document in `codev/reviews/NNNN-name.md`

---

## Terminal States

Projects can also end up in terminal states if they won't be completed:

### Abandoned

The project was canceled or rejected. It will not be implemented. The notes field in `projectlist.md` should explain why.

### On-Hold

The project is temporarily paused but may resume later. The notes field should explain the reason and any conditions for resuming.

---

## Human Approval Gates

Two stages require explicit human approval - AI agents cannot bypass these:

| Gate | Transition | Why |
|------|------------|-----|
| **Spec Approval** | conceived → specified | Humans must approve what gets built |
| **Production Validation** | committed → integrated | Humans must verify it works in production |

```
conceived → [HUMAN APPROVES] → specified → planned → implementing → implemented → committed → [HUMAN VALIDATES] → integrated
```

---

## Managing Projects

All project tracking happens in `codev/projectlist.md`. To manage projects:

- **Add a project:** Tell the Architect what you want to build
- **Update status:** Ask the Architect to update the project status
- **Approve stages:** Review the spec/plan and tell the Architect to mark it approved
- **View progress:** Check the Projects tab in the dashboard or read `projectlist.md`

---

## Quick Reference

| Stage | Artifact | Who Advances |
|-------|----------|--------------|
| Conceived | Draft spec | AI writes, human approves |
| Specified | Approved spec | AI creates plan |
| Planned | Implementation plan | AI spawns builder |
| Implementing | WIP code | Builder completes |
| Implemented | Open PR | Architect reviews, Builder merges |
| Committed | Merged PR | Human validates |
| Integrated | Review doc | Complete |
