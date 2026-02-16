# Specification: Consult CLI Rework

## Metadata
- **ID**: 0125
- **Status**: draft
- **Created**: 2026-02-16

## Problem Statement

The `consult` CLI has accumulated complexity that makes it confusing to use and fragile in practice:

1. **Too many parameters**: `--model`, `--type`, `--role`, `--context`, `--output`, `--plan-phase`, `--protocol`, `--project-id` — most users only need model + what to review
2. **Integration reviews read wrong files**: When running `consult -m X pr 35` from the architect's main worktree, models read files from `main`, not from the PR branch. The diff is correct but file-reading instructions point at stale code.
3. **Prompt sourcing is opaque**: Review type prompts come from `codev/consult-types/` (or deprecated `codev/roles/review-types/`), roles from `codev/roles/`, with skeleton fallbacks. Users can't tell what the model sees.
4. **Inconsistent filesystem access**: Claude and Codex get tool-based file access (Read, Glob, Grep). Gemini gets none — it's a subprocess with JSON output. Yet all review type prompts say "read the files directly."
5. **PR reviews don't include the diff**: `buildPRQuery()` deliberately omits the diff to avoid truncation, telling models to "read files directly." But on `main`, those files don't reflect the PR changes.

## Root Cause Analysis

The core architectural issue: **consult doesn't establish a correct working context before invoking the model.** It runs from wherever the user is, passes a prompt that assumes branch-aware file access, and hopes for the best.

Secondary issue: the parameter space grew organically. `--type`, `--role`, `--plan-phase`, `--context`, `--protocol`, `--project-id` are all porch/automation concerns leaked into the user-facing CLI.

## Desired State

### Principle: Consult always runs in the right context

When reviewing a PR, consult should:
1. Determine the PR's head branch
2. Either checkout that branch in a temp worktree, or instruct the model to use `git show <branch>:<file>` for file reads
3. Ensure all three models (Claude, Codex, Gemini) see the same file state

### Principle: Simple CLI, complex internals

User-facing interface:
```bash
consult pr 35                    # Review PR (all 3 models in parallel)
consult pr 35 -m gemini          # Review PR with specific model
consult spec 42                  # Review spec
consult plan 42                  # Review plan
consult "How should I structure caching?"   # General question
```

Porch/automation flags moved to a separate namespace or environment variables:
```bash
# Porch passes context via env vars, not CLI flags
CONSULT_PROTOCOL=bugfix CONSULT_PROJECT=319 consult pr 35
```

### Principle: Gemini gets file access

Either:
- (a) Run Gemini in a mode that allows file access (gemini-cli has `--sandbox` modes), or
- (b) Pre-gather relevant file contents and inject them into the prompt, or
- (c) Accept the limitation and document it clearly

## Implementation Sketch

### Phase 1: Fix the worktree problem (critical)

When `consult pr <N>` is invoked:
1. Run `gh pr view <N> --json headRefName` to get the branch
2. Create a temporary shallow worktree: `git worktree add --detach /tmp/consult-<N> <branch>`
3. Run the model with `cwd` set to that worktree
4. Clean up the worktree after the model finishes

This ensures all file reads happen against the PR's actual code, not `main`.

### Phase 2: Simplify the CLI surface

- Make `consult pr` default to 3-way parallel (currently requires manual `&` syntax)
- Drop `--type` for PR reviews — the review type should be inferred from context (PR review = `impl-review` or `integration-review` depending on caller)
- Move `--context`, `--protocol`, `--project-id`, `--plan-phase`, `--output` to env vars for porch
- Keep `--model` / `-m` and `--role` as the only user-facing flags

### Phase 3: Unify model capabilities

- Ensure all models can read files in the worktree context
- For Gemini: either enable sandbox mode or pre-gather file contents
- Standardize the prompt contract: "You are in a directory with the full codebase. Read any file you need."

## Success Criteria

- [ ] `consult pr 35` from any directory reads files from the PR branch, not main
- [ ] Integration reviews no longer produce findings about code that doesn't exist in the PR
- [ ] CLI has at most 3 user-facing flags: `-m`, `--role`, `--dry-run`
- [ ] All three models produce consistent results given the same prompt and context
- [ ] Porch automation still works (via env vars instead of CLI flags)

## Constraints

- Must not break porch integration — porch calls consult programmatically
- Must not require additional API keys or new model installations
- Temporary worktrees must be cleaned up reliably (trap on exit)
- `consult general` should still work without any PR/branch context

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Temp worktree creation adds latency | Medium | Low | Shallow clone, reuse if same branch |
| Gemini file access limitations | Medium | Medium | Fall back to context injection |
| Porch env var migration breaks existing scripts | Low | Medium | Support both CLI flags and env vars during transition |
| Large repos make temp worktrees expensive | Low | Medium | Use `git worktree add` (lightweight) not clone |

## Open Questions

- [ ] Should `consult pr` default to 3-way parallel? Or keep single-model as default?
- [ ] Should we cache temp worktrees across consultations for the same PR?
- [ ] Is there value in keeping `--type` as a user-facing flag, or should it always be inferred?
