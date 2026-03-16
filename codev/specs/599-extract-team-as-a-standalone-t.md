# Specification: Extract `team` as a Standalone Top-Level CLI

## Metadata
- **ID**: spec-599
- **Status**: draft
- **Created**: 2026-03-09
- **GitHub Issue**: #599

## Problem Statement

The `af team` commands (`list`, `message`, `update`) currently live as subcommands of the `af` (Agent Farm) CLI. However, team management is conceptually separate from the GUI/orchestration toolkit — it's about people and communication, not builders and worktrees.

This creates a misleading mental model: `af` is the orchestration layer (spawn, status, cleanup, tower), while team management is a coordination concern. Every other distinct domain already has its own top-level CLI (`codev`, `consult`, `porch`). Team should follow the same pattern.

## Current State

- `af team list` — lists team members from `codev/team/people/`
- `af team message <text>` — posts to `codev/team/messages.md`
- `af team update` — hourly cron summary of notable events
- Implementation lives in `packages/codev/src/agent-farm/commands/team.ts` and `team-update.ts`
- Library code is already cleanly separated in `src/lib/team.ts` and `src/lib/team-github.ts`
- Cron config at `.af-cron/team-update.yaml` references `af team update`
- Tower route `GET /api/team` calls the library directly (not the CLI)
- No `team add` command exists yet

## Desired State

1. **`team` is a standalone top-level CLI** — `team list`, `team message`, `team update`, `team add`
2. **`af team` keeps working** — prints a deprecation notice pointing to `team`, then delegates
3. **A new skill** (`.claude/skills/team/SKILL.md`) documents the CLI and team file format
4. **Command reference** (`codev/resources/commands/team.md`) follows the pattern of existing docs
5. **Cron and documentation updated** to reference `team` instead of `af team`

## Stakeholders
- **Primary Users**: AI agents (architect and builders) using team commands
- **Secondary Users**: Human developers managing team members
- **Technical Team**: Codev maintainers

## Requirements

### R1: New `team` CLI binary
A new entry point `bin/team.js` registered in `package.json` under `"bin"`, with subcommands:

| Command | Description |
|---------|-------------|
| `team list` | List team members (existing functionality) |
| `team message <text>` | Post to team message log (existing) |
| `team update` | Hourly activity summary (existing) |
| `team add <github-handle>` | Scaffold a new member file (new) |

### R2: `team add <github-handle>` command
Creates `codev/team/people/<github-handle>.md` with YAML frontmatter scaffolding:
```yaml
---
name: <github-handle>
github: <github-handle>
role: Team Member
---
```
- Normalizes the handle to lowercase for the filename (GitHub handles are case-insensitive)
- Fails if the file already exists (no overwriting) — exits with code 1 and message: `Error: Team member '<handle>' already exists at codev/team/people/<handle>.md`
- Optionally accepts `--name` and `--role` flags to populate frontmatter; if `--name` is omitted, uses the handle as the `name` field
- Validates the handle format using existing `isValidGitHubHandle()` — on failure exits with code 1 and message: `Error: Invalid GitHub handle '<handle>'`
- Creates the `codev/team/people/` directory if it doesn't exist

### R3: `af team` deprecation
The existing `af team` subcommands continue to work but print a deprecation notice:
```
⚠ `af team` is deprecated. Use `team list` instead.
```
Then delegate to the same underlying functions. No behavior change — just a warning on stderr.

### R4: Skill documentation
New skill at `.claude/skills/team/SKILL.md` covering:
- CLI commands and usage
- Team file format (frontmatter fields, body content)
- How to set up a team directory
- Message format and conventions

### R5: Command reference documentation
New file `codev/resources/commands/team.md` following the pattern of `agent-farm.md`, `consult.md`, etc.

### R6: Update references
- `.af-cron/team-update.yaml` → change command to `team update`
- `CLAUDE.md` / `AGENTS.md` → add `team` to CLI tool list, update any `af team` references
- `codev/resources/arch.md` → add `team` CLI to architecture documentation

## Success Criteria
- [ ] `team list` works identically to current `af team list`
- [ ] `team message "hello"` works identically to current `af team message "hello"`
- [ ] `team update` works identically to current `af team update`
- [ ] `team add waleedkadous` creates a properly formatted member file
- [ ] `af team list` prints deprecation warning then works normally
- [ ] `team --help` shows all subcommands with descriptions
- [ ] Existing unit tests pass without modification (or with minimal import path changes)
- [ ] New tests cover `team add` and deprecation warnings
- [ ] Skill and command reference docs are complete
- [ ] Cron config updated to use `team update`

## Constraints

### Technical Constraints
- Must reuse existing library code in `src/lib/team.ts` and `src/lib/team-github.ts`
- Must follow the same CLI entry point pattern as `consult.js` and `af.js`
- Tower API route (`GET /api/team`) must continue working — it calls library functions directly, not the CLI
- Must not break existing `af` command structure

### Design Constraints
- The `team` CLI should work from any directory within a codev project (same workspace detection as `af`)
- When run outside a codev workspace (no `codev/` directory found), all commands fail immediately with: `Error: Not inside a Codev workspace. Run from a project that has a codev/ directory.` (exit code 1)
- No new dependencies required — uses `commander`, `js-yaml`, and Node builtins already in the project

## Assumptions
- The existing `findWorkspaceRoot()` utility can be reused for the team CLI
- GitHub handle validation already exists in `src/lib/team.ts` (`isValidGitHubHandle`)
- The `detectAuthor()` function in `team.ts` can remain where it is or be moved to the lib

## Solution Approach: Route Through Main CLI

Follow the exact pattern used by `consult.js`:

```
bin/team.js → dist/cli.js run(['team', ...args]) → commander team command group
```

Register a `team` command group in `src/cli.ts` (the main CLI router) with the four subcommands. The `af team` commands get a deprecation wrapper that warns then calls the same functions.

**Why this approach**: It's identical to how `consult` and `af` already work. Minimal new code, consistent architecture, easy to maintain.

## Open Questions

### Critical
- None — requirements are clear from the issue.

### Important
- [x] Should `team add` try to fetch the user's real name from GitHub? → No, keep it simple. Use the handle as the default `name` field; user can edit the file afterward.

### Nice-to-Know
- Should `team remove` be added? → Out of scope. Users can delete the file directly.

## Performance Requirements
- CLI commands should complete in <1s for local operations
- `team update` may take longer due to `gh` API calls (existing behavior, no change)

## Security Considerations
- `team add` must validate GitHub handles to prevent path traversal (e.g., `../../../etc/passwd`)
- No secrets are stored in team files

## Test Scenarios

### Functional Tests
1. `team list` — lists members from codev/team/people/ with correct formatting
2. `team message "hello"` — appends message to messages.md with auto-detected author
3. `team update` — collects events and posts summary (existing tests)
4. `team add validhandle` — creates member file with correct frontmatter
5. `team add existing-member` — fails with clear error
6. `team add --name "Jane Doe" --role "Developer" jdoe` — creates file with custom fields
7. `team add "../bad"` — fails validation
8. `af team list` — prints deprecation warning, then lists members

### Error Handling Tests
1. `team list` outside a codev workspace — fails with "Not inside a Codev workspace" error
2. `team add` with non-writable directory — fails with filesystem error (exit code 1)

### Non-Functional Tests
1. CLI help output shows all commands and options
2. Exit codes: 0 on success, 1 on error

## Dependencies
- **Internal**: `src/lib/team.ts`, `src/lib/team-github.ts`, `findWorkspaceRoot()`
- **Libraries**: `commander` (already used), `js-yaml` (already used)
- **External**: `gh` CLI (optional, for author detection)

## References
- Spec 587: Team Tab in Tower Right Panel (original team implementation)
- Issue #599: Extract team as a standalone top-level CLI
- Existing CLIs: `bin/consult.js`, `bin/af.js`, `bin/porch.js`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking `af team` for existing users | Low | Medium | Keep `af team` working with deprecation warning |
| Cron job breaks after rename | Low | Low | Update `.af-cron/team-update.yaml` in same PR |
| Import path changes break tests | Low | Low | Library code stays in place; only CLI wiring changes |

## Expert Consultation

**Date**: 2026-03-09
**Models Consulted**: Gemini, Codex, Claude

**Results**:
- **Gemini**: APPROVE (high confidence). Suggested moving handler implementations to `src/commands/team/` for cleaner separation from `agent-farm`. (Noted but not required — library code is already cleanly separated in `src/lib/team.ts`.)
- **Codex**: REQUEST_CHANGES (medium confidence). Requested clarifications on: (1) behavior outside a codev workspace, (2) handle normalization/casing, (3) error messaging and exit codes. All three addressed in this revision.
- **Claude**: APPROVE (high confidence). Verified codebase claims. Noted handle casing as a minor observation (addressed).

**Changes made from consultation**:
- R2: Added lowercase normalization for filenames, explicit error messages and exit codes for validation failures and duplicate members
- Design Constraints: Added workspace-not-found error behavior
- Test Scenarios: Added error handling test cases for outside-workspace and non-writable directory
