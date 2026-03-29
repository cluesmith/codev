# Specification: Rename af CLI to afx

## Metadata
- **ID**: spec-647
- **Status**: draft
- **Created**: 2026-03-29
- **GitHub Issue**: #647

## Clarifying Questions Asked

The issue description (#647) provides clear requirements. No additional clarification needed — the problem, solution, and naming rationale are well-defined.

## Problem Statement

The `af` command name is too short and ambiguous. AI assistants (Claude, GPT, Gemini) frequently misinterpret it as noise or a preposition, stripping it from commands. For example, `af open file.ts` gets interpreted as just `open file.ts`, causing the system `open` command to run instead of the Agent Farm CLI.

This is a usability problem that affects every AI-assisted interaction with the Agent Farm toolchain.

## Current State

- The CLI is registered as `af` in `packages/codev/package.json` bin field
- The bin shim lives at `packages/codev/bin/af.js`
- The CLI parser in `packages/codev/src/agent-farm/cli.ts` sets `.name('af')`
- ~11+ source files contain hardcoded `af` references in help text, error messages, and deprecation warnings
- ~270 markdown documentation files contain ~2,119 line references to `af` commands
- ~20+ skeleton files in `codev-skeleton/` reference `af` commands (deployed to user projects)
- Test files reference `af` in describe blocks and assertions
- `af-config.json` is already deprecated (migrated to `.codev/config.json`) — only referenced in legacy error messages

## Desired State

- Primary CLI command is `afx`
- `af` continues to work as a deprecated alias for one release cycle, printing a deprecation warning on each invocation
- All documentation, skeleton files, help text, error messages, and examples reference `afx`
- Tests reference `afx` in descriptions and assertions
- After the deprecation period (next major release), the `af` alias is removed

## Stakeholders
- **Primary Users**: Developers using Codev's Agent Farm via AI assistants (Claude Code, etc.)
- **Secondary Users**: Developers typing `af` directly in their terminals
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `afx` command works identically to current `af` command
- [ ] `af` command still works but prints a deprecation warning directing users to `afx`
- [ ] All help text, error messages, and CLI output reference `afx` (not `af`)
- [ ] All documentation in `codev/` references `afx`
- [ ] All skeleton files in `codev-skeleton/` reference `afx`
- [ ] CLAUDE.md and AGENTS.md updated to reference `afx`
- [ ] Existing tests pass (updated to reference `afx` where appropriate)
- [ ] `af-config.json` legacy error message unchanged (it references the old file name correctly)

## Constraints

### Technical Constraints
- Must maintain backward compatibility via the `af` alias for one release cycle
- The bin shim approach (thin wrapper routing to the CLI parser) must be preserved
- npm global install must register both `af` and `afx` commands simultaneously during the deprecation period

### Business Constraints
- Users who have `af` in their muscle memory, scripts, or CLAUDE.md files need a migration path
- The deprecation warning must be clear and actionable

## Assumptions
- npm supports multiple bin entries in package.json (it does — both `af` and `afx` can coexist)
- No external tools depend on the `af` binary name (it's Codev-internal)
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

**Description**: Rename `af` to `afx` everywhere with no backward compatibility.

**Pros**:
- Simpler — no deprecated code path
- Clean break

**Cons**:
- Breaking change — existing scripts and muscle memory break immediately
- Users with `af` in their CLAUDE.md or shell aliases get errors

**Estimated Complexity**: Low
**Risk Level**: Medium (breaking change)

### Recommended Approach

**Approach 1** — rename with deprecated alias. The backward compatibility cost is minimal (one extra bin entry + a deprecation wrapper), and it prevents a disruptive breaking change.

## Open Questions

### Critical (Blocks Progress)
- None — the issue description is clear

### Important (Affects Design)
- [x] Should the `af` deprecation alias be removed in the next minor or major release? **Decision: Next major release (as stated in issue)**

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
1. `afx status` returns the same output as current `af status`
2. `afx spawn`, `afx send`, `afx open`, `afx cleanup` all work correctly
3. `af status` prints deprecation warning then works correctly
4. `af --help` shows help with `afx` branding and a deprecation notice
5. Tab completion works for `afx` subcommands

### Non-Functional Tests
1. Both `af` and `afx` are registered after `npm install -g`
2. Deprecation warning goes to stderr (doesn't pollute stdout piping)

## Dependencies
- **External Services**: None
- **Internal Systems**: npm package.json bin field
- **Libraries/Frameworks**: Commander.js (existing CLI framework)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Users miss deprecation warning | Low | Low | Warning is prominent; docs are updated |
| Scripts break on `af` removal | Low | Medium | One full release cycle of deprecation |
| Documentation search-replace introduces errors | Medium | Medium | Careful regex patterns; review diff thoroughly |
| Skeleton files in deployed projects still say `af` | Medium | Low | `codev update` can refresh skeleton files |

## Notes

### Scope Clarification: af-config.json
The `af-config.json` path is already deprecated and throws an error directing users to `.codev/config.json`. This rename does NOT change the `af-config.json` string — it's a file name reference to a legacy config file, not a reference to the CLI command. Leave it as-is.

### Documentation Volume
The largest portion of work is updating ~270 markdown files. This is mechanical but must be done carefully to avoid false positives (e.g., "af" appearing as part of other words like "after", "safari", "leaf"). The pattern to match is `af ` (with trailing space) or `` `af` `` (backtick-wrapped) or `af spawn`/`af status`/etc. (followed by a subcommand).
