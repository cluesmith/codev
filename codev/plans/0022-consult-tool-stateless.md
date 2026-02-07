# Plan: Consult Tool (Stateless)

## Metadata
- **Spec**: [0022-consult-tool-stateless.md](../specs/0022-consult-tool-stateless.md)
- **Status**: reviewed
- **Created**: 2025-12-04
- **Protocol**: TICK (simple implementation)

## Overview

Implement a Python CLI wrapper that invokes gemini-cli or codex with a consultant role. This is a straightforward implementation with four deliverables:

1. `codev/bin/consult` - Python CLI script
2. `codev/roles/consultant.md` - Role definition
3. Documentation updates
4. Add `.consult/` to `.gitignore`

## Phase 1: Create Consultant Role

**Goal**: Define the consultant role file

### Tasks

- [ ] Create `codev/roles/consultant.md` with collaborative partner definition
- [ ] Create `codev-skeleton/roles/consultant.md` (copy for new projects)

### Exit Criteria
- Role file exists and matches spec definition
- Both codev/ and codev-skeleton/ have the file

## Phase 2: Implement Python CLI

**Goal**: Working `consult` command

### Tasks

1. **Create the script**
   - [ ] Create `codev/bin/consult` with Python/Typer implementation
   - [ ] Make executable (`chmod +x`)
   - [ ] Add shebang (`#!/usr/bin/env python3`)

2. **Core functionality**
   - [ ] Parse model argument (gemini, codex, pro, gpt)
   - [ ] Parse query argument (positional or stdin)
   - [ ] Read consultant role from `codev/roles/consultant.md`
   - [ ] Build and execute subprocess command
   - [ ] Propagate exit codes
   - Note: No `--files` option needed - tools access filesystem directly

3. **Model-specific handling**
   - [ ] gemini: `gemini --yolo --system-instructions <role> <query>`
   - [ ] codex: `CODEX_SYSTEM_PROMPT=<role> codex --full-auto <query>`
   - Note: `--yolo` (gemini) and `--full-auto` (codex) enable autonomous mode with minimal permission prompts
4. **Observability**
   - [ ] Create `.consult/` directory if needed
   - [ ] Log queries to `.consult/history.log`

5. **Error handling**
   - [ ] Unknown model → helpful error
   - [ ] Missing CLI → detect with `shutil.which()`, friendly install guidance
   - [ ] No query → usage message
   - [ ] Missing role file → fail fast with clear error
   - [ ] Empty stdin → error message
   - [ ] Ctrl+C → graceful subprocess termination (try/except KeyboardInterrupt)

6. **Optional enhancements**
   - [ ] `--dry-run` flag to print command without executing (debugging aid)

### Exit Criteria
- `consult gemini "test"` invokes gemini-cli with `--yolo`
- `consult codex "test"` invokes codex with `--full-auto`
- Aliases work (pro, gpt)
- Stdin piping works
- History logged

## Phase 3: Dependencies & Gitignore

**Goal**: Proper Python dependencies and ignore patterns

### Tasks

- [ ] Add `typer>=0.9.0` to `codev/requirements.txt` (create if needed)
- [ ] Add `.consult/` to `.gitignore`
- [ ] Copy to codev-skeleton/ as appropriate

### Exit Criteria
- Typer listed in requirements
- `.consult/` ignored by git

## Phase 4: Documentation

**Goal**: Update docs to reflect new tool

### Tasks

- [ ] Update `CLAUDE.md` - Add consult tool to available commands
- [ ] Update `codev-skeleton/CLAUDE.md` template
- [ ] Update `codev/roles/architect.md` - Note consult as consultation method
- [ ] Update SPIR protocol docs if they reference mcp__zen__*

### Exit Criteria
- Documentation mentions `consult` command
- Clear instructions for usage

## Phase 5: Verification

**Goal**: Confirm everything works

### Tasks

1. **Manual testing**
   - [ ] Test `consult gemini "hello"`
   - [ ] Test `consult codex "hello"`
   - [ ] Test `echo "hello" | consult pro`
   - [ ] Test error cases (unknown model, no query)
   - [ ] Verify history log created
   - [ ] Verify autonomous mode works (no permission prompts)

2. **Verify CLI flags**
   - [ ] Confirm gemini-cli accepts `--system-instructions`
   - [ ] Confirm codex reads `CODEX_SYSTEM_PROMPT`

### Exit Criteria
- All manual tests pass
- CLI flags confirmed working

## Implementation Order

```
Phase 1 (Role) ──┐
                 ├──> Phase 2 (CLI) ──> Phase 5 (Verify)
Phase 3 (Deps) ──┘
                 ↓
              Phase 4 (Docs)
```

- Phases 1 and 3 can be done in parallel
- Phase 2 depends on Phase 1 (needs role file)
- Phase 4 can happen after Phase 2
- Phase 5 is final verification

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Role | 10 min |
| Phase 2: CLI | 30 min |
| Phase 3: Deps | 5 min |
| Phase 4: Docs | 15 min |
| Phase 5: Verify | 15 min |
| **Total** | ~1.5 hours |

## Risks

| Risk | Mitigation |
|------|-----------|
| gemini-cli flags differ from docs | Test against actual CLI before finalizing |
| codex env var not working | Test against actual CLI before finalizing |
| Python not available | Document prerequisite clearly |

## Notes

- This is a TICK-sized implementation (< 300 lines)
- Keep it simple - CLIs handle their own context management
- Phase 2 is the bulk of the work
- Can spawn a builder for this if desired, but simple enough to do directly

---

## Amendment History

This section tracks all TICK amendments to this plan.

### TICK-001: Architect-Mediated PR Reviews (2025-12-08)

**Changes**:

1. **New Phase 6: Architect-Mediated PR Reviews**

   **Goal**: Implement context-passing for PR reviews so consultants analyze provided overviews instead of exploring the filesystem.

   **Tasks**:

   - [ ] Add `--context` flag to `pr` subcommand
   - [ ] Support stdin for context input (when `--context` is `-` or omitted with piped input)
   - [ ] When context is provided, modify CLI invocation to disable filesystem tools:
     - gemini: Add `--sandbox` flag (no shell access)
     - codex: Use `codex exec` instead of `codex` (no tool use)
     - claude: Add `--print` flag (no interactive tools)
   - [ ] Update consultant role to handle provided context vs self-exploration
   - [ ] Add context template for PR reviews (what the architect should include)

   **Exit Criteria**:
   - `consult --model gemini pr 68 --context overview.md` runs without filesystem access
   - `cat overview.md | consult --model gemini pr 68` works equivalently
   - Review completes in <60s (vs 200s+ with exploration)

2. **Updates to Phase 2 (CLI)**:
   - Add `--context` optional flag to `pr` subcommand
   - Detect stdin when not a TTY
   - Pass context content to the consultant as part of the query

3. **Updates to Phase 4 (Documentation)**:
   - Add section on architect-mediated reviews to CLAUDE.md
   - Document the `--context` flag usage
   - Add template for PR overview format

4. **New file: `codev/templates/pr-overview.md`**:
   ```markdown
   # PR Overview Template

   ## PR Info
   - **Number**: #NNN
   - **Title**: [Title]
   - **Branch**: [branch-name]
   - **Spec**: [link to spec if applicable]

   ## Summary
   [1-2 sentence summary of what this PR does]

   ## Key Changes
   - [File 1]: [what changed and why]
   - [File 2]: [what changed and why]

   ## Diff (condensed)
   [Key portions of the diff, or full diff if small]

   ## Questions for Reviewer
   1. [Specific question 1]
   2. [Specific question 2]
   ```

**Review**: See `reviews/0022-consult-tool-stateless-tick-001.md`
