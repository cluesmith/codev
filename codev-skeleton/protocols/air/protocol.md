# AIR Protocol

> **AIR** = **A**utonomous **I**mplement & **R**eview
>
> A lightweight protocol for small features that are fully specified by their GitHub issue.
> Two phases: Implement → Review. No spec/plan artifacts.

## What is AIR?

AIR is a minimal protocol for implementing small features (< 300 LOC) where the GitHub issue provides all the requirements. It skips the Specify and Plan phases entirely — the builder implements directly from the issue and creates a PR with the review embedded in the PR body.

### How AIR Compares

| Aspect | BUGFIX | AIR | ASPIR/SPIR |
|--------|--------|-----|------------|
| **Use case** | Bug fixes | Small features | New features |
| **Input** | GitHub Issue | GitHub Issue | GitHub Issue → Spec |
| **Phases** | Investigate → Fix → PR | Implement → PR | Specify → Plan → Implement → Review |
| **Artifacts** | None | None | Spec, plan, review files |
| **Review location** | PR body | PR body | `codev/reviews/` file |
| **Consultation** | PR phase only | Optional (builder decides) | Every phase (3-way) |
| **Human gates** | None (PR gate) | None (PR gate) | Spec + Plan + PR gates (SPIR) |
| **LOC limit** | < 300 | < 300 | No limit |

### When to Use AIR

- Small features (< 300 LOC)
- Requirements are clear from the GitHub issue
- No architectural decisions needed
- No new abstractions or significant refactoring required
- Would be overkill for full SPIR/ASPIR ceremony

### When NOT to Use AIR

- Bug fixes → use **BUGFIX**
- Features needing spec discussion → use **SPIR** or **ASPIR**
- Amendments to existing specs → use **TICK**
- Architectural changes → use **SPIR**
- Complex features with multiple phases → use **SPIR** or **ASPIR**

## Protocol Phases

### I - Implement

The builder reads the GitHub issue and implements the feature:

1. Read and understand the issue requirements
2. Implement the feature (< 300 LOC)
3. Write tests
4. Verify build and tests pass
5. Commit with descriptive message

If the feature grows beyond 300 LOC or requires architectural decisions, the builder signals `TOO_COMPLEX` to escalate to ASPIR.

### R - Review (PR)

The builder creates a PR with the review embedded in the PR body:

1. Create PR linking to the issue
2. Include a review section in the PR body (summary, key decisions, test plan)
3. Optionally run CMAP consultation if the builder judges the complexity warrants it
4. Notify the architect

The **PR gate** is preserved — a human reviews all code before merge.

## Usage

```bash
# Spawn a builder using AIR
af spawn 42 --protocol air

# The builder implements autonomously and stops at the PR gate
```

## File Structure

```
codev-skeleton/protocols/air/
├── protocol.json          # Protocol definition
├── protocol.md            # This file
├── builder-prompt.md      # Builder instructions (Handlebars template)
├── prompts/
│   ├── implement.md       # Implement phase prompt
│   └── pr.md              # PR phase prompt
└── consult-types/
    ├── impl-review.md     # Implementation consultation guide
    └── pr-review.md       # PR consultation guide
```
