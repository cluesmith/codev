# Review: Spec 0039 TICK-005 - codev import command

**Spec:** 0039-codev-cli.md (TICK-005 amendment)
**Protocol:** SPIR (via TICK amendment)
**Date:** 2025-12-11
**Branch:** builder/0039-codev-cli

---

## Summary

Implemented `codev import` command for AI-assisted protocol import from other codev projects. This replaces the obsolete `codev-updater` and `spider-protocol-updater` agents with a more interactive, AI-assisted approach.

## Changes Made

### New Implementation
- `packages/codev/src/commands/import.ts` (320 lines)
  - Parses local paths and GitHub URLs
  - Fetches source codev/ directory
  - Reads markdown files from protocols/, resources/, roles/
  - Builds context prompt with source and target files
  - Spawns interactive Claude session

### CLI Integration
- `packages/codev/src/cli.ts` - Added import command registration

### Tests
- `packages/codev/src/__tests__/import.test.ts` (10 tests)
  - Source parsing (local, github:, full URLs, dotted repo names)
  - Error handling (missing source, no codev dir, empty source)
  - Dry run functionality

### Deleted (obsolete agents)
- `.claude/agents/codev-updater.md`
- `.claude/agents/spider-protocol-updater.md`
- `codev-skeleton/agents/codev-updater.md`
- `codev-skeleton/agents/spider-protocol-updater.md`
- `codev/agents/codev-updater.md`
- `codev/agents/spider-protocol-updater.md`
- `tests/20_codev_updater.bats`

### Documentation Updated
- `CLAUDE.md` - New "Protocol Import Command" section
- `AGENTS.md` - Same updates (kept in sync)

## Success Criteria Verification

| Criterion | Status |
|-----------|--------|
| `codev import <path>` works with local directories | ✅ |
| `codev import <github-url>` works with GitHub repos | ✅ |
| Command spawns interactive Claude session with source/target context | ✅ |
| Claude analyzes differences and recommends imports | ✅ |
| User can approve/reject each suggested change | ✅ |
| `codev-updater` agent deleted | ✅ |
| `spider-protocol-updater` agent deleted | ✅ |
| Documentation updated | ✅ |

## External Review Summary

### Gemini Pro
**Verdict: APPROVE**
- Implementation correctly fulfills requirements
- Code is clean, modular, and error-resilient
- Good test coverage for argument parsing and error conditions
- Obsolete agents correctly removed from all locations

### GPT-5 Codex
**Verdict: APPROVE** (after fix)
- Initial review found bug: GitHub URLs with dots in repo names (e.g., `vercel/next.js`) would fail
- Fixed regex to capture dots: `/[\w-]+/` → `/[\w.-]+/`
- Added test case for dotted repo names
- Re-review confirmed fix addresses the concern

## Lessons Learned

### 1. Regex Needs Careful Character Class Design
The initial regex `[\w-]+` for parsing GitHub repo names missed dots, which are common in repository names (e.g., `next.js`, `vue.js`). External review caught this before production.

**Lesson:** When writing regexes for user input (especially URLs), consider all valid characters in the domain, not just the most common cases.

### 2. Interactive AI Sessions Simplify Complex Merges
Rather than implementing sophisticated diff/merge logic, spawning an interactive Claude session lets the AI analyze differences contextually. This is simpler to implement and more powerful for the user.

**Pattern:** For complex decision-making tasks, consider "AI-in-the-loop" over complex algorithms.

### 3. Consolidating Agents into Commands
Moving from two separate agents (`codev-updater`, `spider-protocol-updater`) to a single CLI command (`codev import`) simplifies discovery and usage. Commands are more accessible than agents because:
- Commands appear in `--help` output
- Commands have consistent argument parsing
- Commands integrate with shell completion

**Pattern:** Prefer CLI commands over AI agents for well-defined operations.

## Technical Decisions

### Why spawn interactive Claude (not `--print`)?
The `--print` flag would make Claude output and exit. For import, we want an interactive session where Claude can discuss options with the user and make edits after approval. Using `-p` passes the initial prompt while maintaining interactivity.

### Why shallow clone for GitHub?
Using `git clone --depth 1` minimizes network usage and time, since we only need the latest version of the codev/ directory, not full history.

### Why truncate large files?
Files over 10,000 characters are truncated in the prompt to avoid overwhelming Claude's context. Most protocol files are well under this limit.

## Commits

1. `[Spec 0039][TICK-005][Implement]` - Main implementation
2. `[Spec 0039][TICK-005][Defend]` - Fix for dotted repo names

---

*Review completed: 2025-12-11*
