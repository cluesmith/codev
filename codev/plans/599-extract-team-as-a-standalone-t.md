# Plan: Extract `team` as a Standalone Top-Level CLI

## Metadata
- **ID**: plan-599
- **Status**: draft
- **Specification**: codev/specs/599-extract-team-as-a-standalone-t.md
- **Created**: 2026-03-09

## Executive Summary

Extract the `af team` subcommands into a standalone `team` CLI binary, following the same routing pattern as `consult.js`. The work is split into three phases: (1) core CLI extraction with `team add`, (2) deprecation of `af team`, and (3) documentation and reference updates. Library code stays in place — only CLI wiring changes.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Existing tests pass without modification
- [ ] New tests cover `team add` and deprecation warnings
- [ ] Documentation complete (skill, command reference, CLAUDE.md)

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "cli-extraction", "title": "CLI Extraction and team add"},
    {"id": "deprecation", "title": "af team Deprecation Wrapper"},
    {"id": "docs-and-refs", "title": "Documentation and Reference Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: CLI Extraction and team add
**Dependencies**: None

#### Objectives
- Register `team` as a top-level command group in `src/cli.ts`
- Create `bin/team.js` entry point
- Add `team` to `package.json` bin entries
- Implement `team add <github-handle>` command
- Wire existing `list`, `message`, `update` subcommands to the new command group

#### Deliverables
- [ ] `bin/team.js` — new entry point (same pattern as `bin/consult.js`)
- [ ] `src/cli.ts` — register `team` command group with 4 subcommands
- [ ] `src/agent-farm/commands/team.ts` — add `teamAdd()` function
- [ ] `package.json` — add `"team": "./bin/team.js"` to bin
- [ ] Tests for `team add` (valid handle, duplicate, invalid handle, custom flags)

#### Implementation Details
- `bin/team.js`: `#!/usr/bin/env node` → `import { run } from '../dist/cli.js'; run(['team', ...process.argv.slice(2)]);`
- In `src/cli.ts`, add a `team` command group using Commander, registering `list`, `message`, `update`, `add` subcommands
- **Workspace validation**: Each subcommand action calls `findWorkspaceRoot()` first. If it throws (no `codev/` found), catch and print `Error: Not inside a Codev workspace. Run from a project that has a codev/ directory.` then `process.exit(1)`. This matches the spec's Design Constraint.
- `teamAdd()` in `src/agent-farm/commands/team.ts`: validates handle with `isValidGitHubHandle()`, normalizes to lowercase, creates `codev/team/people/<handle>.md` with YAML frontmatter, fails if file exists with exact error: `Error: Team member '<handle>' already exists at codev/team/people/<handle>.md`
- Invalid handle: `Error: Invalid GitHub handle '<handle>'` (exit code 1)

#### Acceptance Criteria
- [ ] `team list` produces identical output to `af team list`
- [ ] `team message "test"` posts to messages.md
- [ ] `team update` runs hourly summary
- [ ] `team add validhandle` creates member file with correct frontmatter
- [ ] `team add existing` fails with exact error: `Error: Team member 'existing' already exists at codev/team/people/existing.md`
- [ ] `team add "../bad"` fails with exact error: `Error: Invalid GitHub handle '../bad'`
- [ ] `team list` outside a codev workspace fails with: `Error: Not inside a Codev workspace. Run from a project that has a codev/ directory.`
- [ ] `team --help` shows all 4 subcommands

#### Test Plan
- **Unit Tests**: `teamAdd()` — valid handle, duplicate (exact error text), invalid handle (exact error text), custom `--name`/`--role` flags, directory creation
- **Error Handling Tests**: `team list` outside workspace (exact error text, exit code 1), `team add` with non-writable directory (exit code 1)
- **Integration Tests**: Full CLI invocation via Commander parse

#### Rollback Strategy
Remove `team` from `src/cli.ts` command registration and `package.json` bin entry.

---

### Phase 2: af team Deprecation Wrapper
**Dependencies**: Phase 1

#### Objectives
- Modify existing `af team` subcommands to print deprecation warning on stderr before executing
- Update `.af-cron/team-update.yaml` to use `team update` instead of `af team update`

#### Deliverables
- [ ] `src/agent-farm/cli.ts` — add stderr deprecation warning to each `af team` subcommand action
- [ ] `.af-cron/team-update.yaml` — update command to `team update`
- [ ] Tests for deprecation warning output

#### Implementation Details
- In `src/agent-farm/cli.ts`, wrap each `af team` action to print a per-subcommand deprecation warning:
  - `af team list` → `⚠ \`af team\` is deprecated. Use \`team list\` instead.`
  - `af team message` → `⚠ \`af team\` is deprecated. Use \`team message\` instead.`
  - `af team update` → `⚠ \`af team\` is deprecated. Use \`team update\` instead.`
- The warning goes to stderr so it doesn't interfere with piped output
- Cron config change is a single-line edit: `command: "team update"`

#### Acceptance Criteria
- [ ] `af team list` prints deprecation warning on stderr then lists members normally
- [ ] `af team message "test"` prints warning then posts message
- [ ] `.af-cron/team-update.yaml` references `team update`
- [ ] Warning does not appear when using `team list` directly

#### Test Plan
- **Unit Tests**: Verify deprecation warning is emitted on stderr for each `af team` subcommand
- **Integration Tests**: Verify existing `af team` tests still pass (output unchanged, warning on stderr only)

#### Rollback Strategy
Remove deprecation warning wrappers from `src/agent-farm/cli.ts`. Revert cron config.

---

### Phase 3: Documentation and Reference Updates
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Create skill documentation for AI agents
- Create command reference documentation
- Update CLAUDE.md/AGENTS.md, arch.md, and overview.md with the new CLI

#### Deliverables
- [ ] `.claude/skills/team/SKILL.md` — skill for AI agents
- [ ] `codev/resources/commands/team.md` — command reference doc
- [ ] `codev/resources/commands/overview.md` — add `team` to CLI overview
- [ ] `CLAUDE.md` and `AGENTS.md` — add `team` to CLI reference section
- [ ] `codev/resources/arch.md` — add `team` CLI to architecture doc

#### Implementation Details
- Skill doc covers: CLI commands, team file format (frontmatter + body), message format, setup instructions
- Command reference follows the pattern of `agent-farm.md` and `consult.md`
- CLAUDE.md/AGENTS.md updates: add `team` to the "CLI Command Reference" section and the "Available Protocols" or tools list
- arch.md: add `team` as a top-level CLI alongside `codev`, `af`, `consult`, `porch`

#### Acceptance Criteria
- [ ] Skill triggers when AI agent needs team management
- [ ] Command reference has complete usage examples
- [ ] CLAUDE.md/AGENTS.md mention `team` CLI
- [ ] arch.md reflects updated CLI architecture

#### Test Plan
- **Manual Testing**: Verify skill renders correctly in Claude Code
- **Grep Validation**: Verify all `af team` references in docs point to `team` or note deprecation

#### Rollback Strategy
Remove new doc files and revert edits to existing docs.

## Dependency Map
```
Phase 1 (CLI Extraction) ──→ Phase 2 (Deprecation) ──→ Phase 3 (Docs)
```

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `af team` breaks during extraction | Low | Medium | Keep `af team` working throughout — only add deprecation wrapper |
| Cron job fails with new binary name | Low | Low | Test `team update` before updating cron config |
| Missing import paths after wiring | Low | Low | Reuse existing library imports; no code moves |

## Validation Checkpoints
1. **After Phase 1**: `team list`, `team add`, `team message`, `team update` all work from CLI
2. **After Phase 2**: `af team *` shows deprecation warning, cron uses new command
3. **Before PR**: All docs updated, all tests pass, `npm run build` succeeds
