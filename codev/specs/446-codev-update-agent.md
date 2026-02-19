# Specification: codev update --agent

## Metadata
- **ID**: spec-446
- **Status**: draft
- **Created**: 2026-02-19

## Clarifying Questions Asked

1. **Q: Should the output be structured JSON or plain text?**
   A: Structured JSON is the primary output format — it's machine-readable and easily consumed by AI agents. Human-readable summaries should go to stderr so stdout is pure JSON.

2. **Q: Should --agent mode handle conflict resolution itself or delegate to the calling agent?**
   A: Delegate to the calling agent. The `--agent` flag produces instructions; the agent reading those instructions decides how to merge conflicts.

3. **Q: Should --agent mode commit changes or leave that to the agent?**
   A: Leave it to the agent. The update command applies file changes (same as today) but does NOT commit or push. The JSON output tells the agent which files to stage and commit.

## Problem Statement

After a new Codev release, projects need to pull in updated protocols, templates, skills, and agent definitions. The current `codev update` command handles this but has a critical limitation: when conflicts arise (user-modified files vs. new template versions), it spawns an interactive Claude session for human-guided merging. This makes `codev update` unusable for autonomous AI agents running maintenance workflows, cron tasks, or builder operations.

## Current State

`codev update` performs these steps:

1. Cleans up legacy directories (codev/bin, config migration)
2. Copies new consult-types, skills, and roles (skipExisting mode)
3. Iterates template files using hash-based conflict detection:
   - New files: copies directly
   - Unchanged files: skips
   - Template changed, user didn't modify: safe overwrite
   - Template changed, user modified: writes `.codev-new` conflict file
4. Handles root files (CLAUDE.md, AGENTS.md) with placeholder substitution
5. **If conflicts exist**: spawns an interactive `claude` session with merge prompt

The interactive Claude spawn (step 5) blocks autonomous usage. Additionally, the output is human-formatted (chalk colors, console.log) with no structured data for programmatic consumption.

**Existing flags:**
- `--dry-run` / `-n`: Preview changes without applying
- `--force` / `-f`: Overwrite all files regardless of conflicts

## Desired State

A new `--agent` flag transforms `codev update` into an agent-friendly, non-interactive command:

1. **Same update logic**: File copying, hash-based conflict detection, and `.codev-new` creation work identically to the standard mode.
2. **No interactive spawn**: Instead of launching Claude to merge conflicts, the command outputs structured JSON describing what happened and what the agent needs to do.
3. **Structured JSON on stdout**: Machine-readable output with clear categories (updated, new, conflicts, skipped).
4. **Human-readable progress on stderr**: Optional progress messages go to stderr so stdout remains clean JSON.
5. **Exit code semantics**: Exit 0 = success (with or without conflicts), Exit 1 = error. The presence of conflicts is indicated in the JSON output, not the exit code.

### JSON Output Schema

```json
{
  "version": "1.0",
  "success": true,
  "summary": {
    "new": 3,
    "updated": 5,
    "conflicts": 2,
    "skipped": 42
  },
  "files": {
    "new": ["codev/protocols/aspir/protocol.json", "..."],
    "updated": ["codev/protocols/spir/protocol.md", "..."],
    "skipped": ["codev/roles/architect.md", "..."],
    "conflicts": [
      {
        "file": "CLAUDE.md",
        "codevNew": "CLAUDE.md.codev-new",
        "reason": "User modified file; new template version available"
      }
    ]
  },
  "instructions": {
    "conflicts": "For each conflict, merge the .codev-new file into the original. Preserve user customizations and incorporate new sections from .codev-new. Delete the .codev-new file after merging.",
    "commit": "Stage and commit all changed files with message: '[Maintenance] Update codev to vX.Y.Z'"
  }
}
```

### Combinability with Existing Flags

- `--agent --dry-run`: Output the JSON describing what *would* change, without applying. The `success` field reflects that no changes were made.
- `--agent --force`: Apply all updates forcefully (overwrite even user-modified files), then output JSON with no conflicts.
- `--agent` alone: Apply updates with standard conflict detection, output JSON with any conflicts listed.

## Stakeholders
- **Primary Users**: AI agents (builders, maintenance agents, cron-based update workflows)
- **Secondary Users**: Developers scripting codev operations in CI/CD pipelines
- **Technical Team**: Codev maintainers
- **Business Owners**: Codev project lead

## Success Criteria
- [ ] `codev update --agent` runs without interactive prompts or spawning Claude
- [ ] Structured JSON is written to stdout with the schema described above
- [ ] Human-readable progress goes to stderr (when not in dry-run)
- [ ] `--agent --dry-run` outputs what would change without applying
- [ ] `--agent --force` overwrites all files and reports no conflicts
- [ ] Exit code is 0 on success (even with conflicts), 1 on error
- [ ] Existing `codev update` behavior (no --agent flag) is unchanged
- [ ] All tests pass with >90% coverage for new code
- [ ] The JSON schema version is "1.0" for future extensibility

## Constraints

### Technical Constraints
- Must reuse existing update logic (hash-based conflict detection, template resolution, scaffold utilities)
- JSON output must go to stdout; progress/diagnostic messages to stderr
- Must not break the existing interactive flow when `--agent` is not specified
- Commander.js CLI framework (existing pattern)

### Business Constraints
- Should be implementable as a straightforward refactor of the existing `update()` function
- No new dependencies required

## Assumptions
- AI agents can parse JSON from stdout
- AI agents have their own strategies for merging `.codev-new` conflicts
- The calling agent handles git operations (add, commit, push)
- The `codev` CLI is installed and accessible in the agent's PATH

## Solution Approaches

### Approach 1: Refactor update() with agent mode flag (Recommended)

**Description**: Add an `agent` boolean to `UpdateOptions`. When true, suppress all `console.log` output, skip the interactive Claude spawn, and return the `UpdateResult` data. A thin wrapper in cli.ts serializes it to JSON on stdout.

**Pros**:
- Minimal code changes — the update logic is already structured around `UpdateResult`
- Clean separation: update() returns data, caller decides presentation
- Easy to test — assert on the returned result object

**Cons**:
- Need to handle stderr output carefully (chalk vs. plain text in agent mode)

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Separate function for agent update

**Description**: Create a new `updateForAgent()` function that duplicates the core logic but returns structured data instead of printing.

**Pros**:
- No risk of breaking existing behavior

**Cons**:
- Code duplication
- Two code paths to maintain
- Bug fixes need to be applied twice

**Estimated Complexity**: Medium
**Risk Level**: Low

**Selected**: Approach 1 — refactor with agent mode flag.

## Open Questions

### Critical (Blocks Progress)
- None — requirements are clear from the GitHub issue and codebase analysis.

### Important (Affects Design)
- [x] Should the JSON include file contents for conflicts? **No** — file paths are sufficient. The agent can read the files.

### Nice-to-Know (Optimization)
- [ ] Should there be a `--agent --json-pretty` flag for pretty-printed JSON? **Deferred** — agents can pipe through `jq`. Use compact JSON by default.

## Performance Requirements
- **Response Time**: Same as current `codev update` (< 5 seconds for typical projects)
- **Resource Usage**: No additional memory beyond the JSON result object

## Security Considerations
- Path traversal protection is already handled by `isValidRelativePath()` in templates.ts
- No new file operations are introduced — same files are read/written as the standard mode
- JSON output does not include file contents, only paths

## Test Scenarios

### Functional Tests
1. **Happy path (no conflicts)**: `--agent` outputs JSON with updated/new files, zero conflicts
2. **Conflicts present**: `--agent` outputs JSON listing conflicts with `.codev-new` paths
3. **Dry run**: `--agent --dry-run` outputs JSON describing changes without applying
4. **Force mode**: `--agent --force` outputs JSON with all files updated, no conflicts
5. **Up to date**: `--agent` when no updates needed outputs JSON with all zeros
6. **No codev directory**: `--agent` still throws error (non-zero exit)
7. **Standard mode unchanged**: Running without `--agent` behaves identically to current behavior

### Non-Functional Tests
1. **JSON validity**: Output is valid JSON parseable by `JSON.parse()`
2. **stdout purity**: No non-JSON content on stdout when `--agent` is used
3. **stderr separation**: Progress messages appear on stderr, not stdout

## Dependencies
- **Internal**: `packages/codev/src/commands/update.ts`, `packages/codev/src/lib/templates.ts`, `packages/codev/src/lib/scaffold.ts`
- **Libraries**: None new — uses existing `chalk`, `commander`, `node:fs`, `node:crypto`

## References
- GitHub Issue #446: codev update --agent
- Existing update command: `packages/codev/src/commands/update.ts`
- Template utilities: `packages/codev/src/lib/templates.ts`
- CLI entry point: `packages/codev/src/cli.ts`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Breaking existing update behavior | Low | High | Keep agent mode behind flag; don't change default behavior |
| Incorrect JSON schema | Low | Medium | Define schema in spec, validate in tests |
| stderr/stdout mixing | Medium | Medium | Use a dedicated logging approach for agent mode |

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

The JSON output schema includes a `version` field ("1.0") to allow future schema evolution without breaking existing consumers. The `instructions` field provides human-readable guidance that an AI agent can use to understand what to do next — it's advisory, not prescriptive.

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.
