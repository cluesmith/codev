# Specification: Rename afx CLI to afx

## Metadata
- **ID**: spec-647
- **Status**: draft
- **Created**: 2026-03-29
- **GitHub Issue**: #647

## Clarifying Questions Asked

The issue description (#647) provides clear requirements. No additional clarification needed — the problem, solution, and naming rationale are well-defined.

## Problem Statement

The `afx` command name is too short and ambiguous. AI assistants (Claude, GPT, Gemini) frequently misinterpret it as noise or a preposition, stripping it from commands. For example, `afx open file.ts` gets interpreted as just `open file.ts`, causing the system `open` command to run instead of the Agent Farm CLI.

This is a usability problem that affects every AI-assisted interaction with the Agent Farm toolchain.

## Current State

- The CLI is registered as `afx` in `packages/codev/package.json` bin field
- The bin shim lives at `packages/codev/bin/af.js`
- The CLI parser in `packages/codev/src/agent-farm/cli.ts` sets `.name('af')`
- ~11+ source files contain hardcoded `afx` references in help text, error messages, and deprecation warnings
- The `codev` CLI (`src/cli.ts`) registers `afx` as an alias for `agent-farm` (`.alias('af')`) and intercepts `args[0] === 'af'`
- `porch/index.ts` programmatically spawns `afx` via `spawn('af', ['open', ...])` to open the annotation viewer
- `doctor.ts` checks for `afx` installation via `commandExists('af')`
- ~197 markdown documentation files contain ~1,224 occurrences of `afx` as a CLI command
- ~20+ skeleton files in `codev-skeleton/` reference `afx` commands (deployed to user projects)
- Test files reference `afx` in describe blocks and assertions
- `af-config.json` is already deprecated (migrated to `.codev/config.json`) — only referenced in legacy error messages
- `.af-cron/` directory is a live functional path — `tower-cron.ts` hardcodes `join(workspacePath, '.af-cron')` to load cron definitions; `codev-skeleton/.af-cron/` ships example cron files to user projects
- `.claude/skills/af/` directory contains the `/afx` slash command skill definition; also exists in `codev-skeleton/.claude/skills/af/`

## Desired State

- Primary CLI command is `afx`
- `afx` continues to work as a deprecated alias for one release cycle, printing a deprecation warning on each invocation
- All documentation, skeleton files, help text, error messages, and examples reference `afx`
- Tests reference `afx` in descriptions and assertions
- After the deprecation period (next major release), the `afx` alias is removed

## Stakeholders
- **Primary Users**: Developers using Codev's Agent Farm via AI assistants (Claude Code, etc.)
- **Secondary Users**: Developers typing `afx` directly in their terminals
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `afx` command works identically to current `afx` command
- [ ] `afx` command still works but prints a deprecation warning to **stderr** directing users to `afx`
- [ ] All help text, error messages, and CLI output reference `afx` (not `afx`)
- [ ] All documentation in `codev/` references `afx`
- [ ] All skeleton files in `codev-skeleton/` reference `afx`
- [ ] CLAUDE.md and AGENTS.md updated to reference `afx`
- [ ] `.claude/skills/af/` renamed to `.claude/skills/afx/` (both repo and skeleton)
- [ ] Existing tests pass (updated to reference `afx` where appropriate)
- [ ] `codev agent-farm` alias updated from `afx` to `afx` (with `afx` kept as deprecated alias)
- [ ] Programmatic `spawn('af', ...)` and `commandExists('af')` calls updated to `afx`
- [ ] `af-config.json` legacy error message unchanged (it references the old file name correctly)
- [ ] `.af-cron/` directory left as-is (out of scope — see Notes)

## Constraints

### Technical Constraints
- Must maintain backward compatibility via the `afx` alias for one release cycle
- The bin shim approach (thin wrapper routing to the CLI parser) must be preserved
- npm global install must register both `afx` and `afx` commands simultaneously during the deprecation period

### Business Constraints
- Users who have `afx` in their muscle memory, scripts, or CLAUDE.md files need a migration path
- The deprecation warning must be clear and actionable

## Assumptions
- npm supports multiple bin entries in package.json (it does — both `afx` and `afx` can coexist)
- No external tools depend on the `afx` binary name (it's Codev-internal)
- Historical specs/plans/reviews in `codev/` should be updated to `afx` for consistency (they serve as living documentation)

## Solution Approaches

### Approach 1: Rename with Deprecated Alias (Recommended)

**Description**: Rename the primary command to `afx`, create a new `bin/afx.js` shim, and keep `bin/af.js` as a deprecated alias that prints a warning before delegating to the same CLI.

**Pros**:
- Clean migration path — no breaking change
- Users see deprecation warnings and learn the new name naturally
- Both commands work simultaneously

**Cons**:
- Two bin entries during the deprecation period
- Must update all documentation at once to avoid confusion

**Estimated Complexity**: Medium (code changes are small, documentation volume is large)
**Risk Level**: Low

### Approach 2: Hard Rename (No Alias)

**Description**: Rename `afx` to `afx` everywhere with no backward compatibility.

**Pros**:
- Simpler — no deprecated code path
- Clean break

**Cons**:
- Breaking change — existing scripts and muscle memory break immediately
- Users with `afx` in their CLAUDE.md or shell aliases get errors

**Estimated Complexity**: Low
**Risk Level**: Medium (breaking change)

### Recommended Approach

**Approach 1** — rename with deprecated alias. The backward compatibility cost is minimal (one extra bin entry + a deprecation wrapper), and it prevents a disruptive breaking change.

## Open Questions

### Critical (Blocks Progress)
- None — the issue description is clear

### Important (Affects Design)
- [x] Should the `afx` deprecation alias be removed in the next minor or major release? **Decision: Next major release (as stated in issue)**

### Nice-to-Know (Optimization)
- Whether to also rename internal references in old/historical specs (e.g., spec 403, 440) — **Decision: Yes, update for consistency since they serve as living documentation**

## Performance Requirements
- No performance impact — this is a rename, not a behavioral change
- The deprecation wrapper adds negligible overhead (one `console.warn` call)

## Security Considerations
- No security impact — no changes to authentication, authorization, or data handling
- The bin shim approach is unchanged

## Test Scenarios

### Functional Tests
1. `afx status` returns the same output as current `afx status`
2. `afx spawn`, `afx send`, `afx open`, `afx cleanup` all work correctly
3. `afx status` prints deprecation warning to stderr then works correctly
4. `afx --help` shows help with `afx` branding and a deprecation notice
5. `codev afx` works as alias for `codev agent-farm` (replacing `codev af`)
6. `spawn('afx', ['open', ...])` in porch works correctly
7. `commandExists('afx')` in doctor check works correctly
8. Cron loading still works (`.af-cron/` path unchanged)
7. Skill discovery works for `/afx` skill (renamed from `/afx`)

### Non-Functional Tests
1. Both `afx` and `afx` are registered after `npm install -g`
2. Deprecation warning goes to stderr (doesn't pollute stdout piping)

## Dependencies
- **External Services**: None
- **Internal Systems**: npm package.json bin field
- **Libraries/Frameworks**: Commander.js (existing CLI framework)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Users miss deprecation warning | Low | Low | Warning is prominent; docs are updated |
| Scripts break on `afx` removal | Low | Medium | One full release cycle of deprecation |
| Documentation search-replace introduces errors | Medium | Medium | Careful regex patterns; review diff thoroughly |
| Skeleton files in deployed projects still say `afx` | Medium | Low | `codev update` can refresh skeleton files |

## Notes

### Scope Clarification: af-config.json
The `af-config.json` path is already deprecated and throws an error directing users to `.codev/config.json`. This rename does NOT change the `af-config.json` string — it's a file name reference to a legacy config file, not a reference to the CLI command. Leave it as-is.

### Scope Clarification: .af-cron/ directory
The `.af-cron/` directory is a functional filesystem path used by `tower-cron.ts` and deployed to user projects via `codev-skeleton/`. Unlike the CLI command, this is a directory name that users may have existing cron definitions in. Renaming it would break existing projects without a clear migration path. **Decision: Leave `.af-cron/` as-is.** It's a directory name, not a CLI reference, and the `afx` prefix is incidental. This can be addressed in a future breaking change if desired.

### Scope Clarification: .claude/skills/af/ directory
The `.claude/skills/af/` directory contains the `/afx` slash command skill. This IS a CLI reference and MUST be renamed to `.claude/skills/afx/`. This applies to both the repo copy (`.claude/skills/af/`) and the skeleton copy (`codev-skeleton/.claude/skills/af/`). The skill content must also be updated to reference `afx` commands.

### Scope Clarification: User-level MEMORY.md
User-level config files (e.g., `.claude/projects/*/memory/MEMORY.md`) may contain `afx` command references. These are **out of scope** — they live outside the repository and are the user's responsibility to update. The deprecation warning will guide users to make this change themselves.

### Documentation Volume
The largest portion of work is updating ~197 markdown files with ~1,224 occurrences. This is mechanical but must be done carefully to avoid false positives (e.g., "af" appearing as part of other words like "after", "safari", "leaf"). The pattern to match is `afx ` (with trailing space) or `` `afx` `` (backtick-wrapped) or `afx spawn`/`afx status`/etc. (followed by a subcommand).

## Expert Consultation

**Date**: 2026-03-29
**Models Consulted**: Claude (Gemini failed due to tool mismatch; Codex unavailable)
**Verdict**: REQUEST_CHANGES (addressed in this revision)
**Key Feedback Addressed (Claude)**:
- Added `.af-cron/` directory scope decision (leave as-is)
- Added `.claude/skills/af/` directory rename to scope (rename to `afx`)
- Added MEMORY.md out-of-scope note
- Moved deprecation stderr requirement to success criteria
- Added cron loading and skill discovery to test scenarios
- Corrected documentation scope numbers (~197 files, ~1,224 occurrences)

**Key Feedback Addressed (Gemini)**:
- Added `codev` CLI alias (`.alias('af')` and `args[0] === 'af'`) to scope
- Added programmatic `spawn('af', ...)` and `commandExists('af')` calls to scope
- Removed non-existent tab completion test scenario (Codev has no tab completion)
