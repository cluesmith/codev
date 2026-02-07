# Specification: End-of-Day Reporter

## Metadata
- **ID**: 0003-end-of-day-reporter
- **Status**: ready-for-review
- **Created**: 2025-12-02

## Clarifying Questions Asked

1. **What should the end-of-day reporter summarize?**
   - Answer: All of the above - Git activity, Claude Code sessions, and SPIR progress

2. **How should the report be delivered?**
   - Answer: Terminal output

3. **When should this run?**
   - Answer: Manual command (user invokes explicitly)

4. **What time range should 'end of day' cover?**
   - Answer: Since midnight (all activity from 00:00 today, **local system time**)

5. **Should the report include AI-generated insights?**
   - Answer: Yes, use Claude to generate a narrative summary of the day's work

## Problem Statement

Developers using Codev need a way to reflect on their daily progress. Currently, understanding what was accomplished requires manually checking git logs, reviewing file changes, and mentally tracking SPIR spec/plan status. This friction reduces the value of end-of-day reviews and makes it harder to communicate progress to stakeholders or prepare for the next day.

An automated end-of-day reporter would consolidate all development activity into a single, AI-summarized view, making it easy to:
- See the day's accomplishments at a glance
- Identify incomplete work for tomorrow
- Share progress updates with team members
- Maintain a record of development velocity

## Current State

Today, developers must manually:
1. Run `git log --since="midnight"` to see commits
2. Check `git status` and `git diff` for uncommitted work
3. Review `codev/specs/`, `codev/plans/`, and `codev/reviews/` directories
4. Mentally reconstruct what Claude Code sessions accomplished
5. Piece together a narrative of the day's progress

This is tedious, error-prone, and rarely done consistently.

## Desired State

A single command `./codev/bin/eod-report` that:
1. Gathers all development activity since midnight
2. Analyzes git commits, changed files, and branch activity
3. Checks SPIR spec/plan status changes
4. Uses Claude to generate a narrative summary
5. Outputs a well-formatted report to the terminal

Example output:
```
================================================================================
                        END-OF-DAY REPORT - 2025-12-02
================================================================================

## Summary
Today you focused on implementing the Architect-Builder pattern. You completed
the spec review phase and began implementation, creating the CLI commands for
spawning and managing builder agents.

## Git Activity
- 4 commits on branch `spir/0002-architect-builder/implement`
- Files changed: 12 (847 lines added, 23 removed)
- Key commits:
  - "Add architect spawn command with ttyd integration"
  - "Implement builder status tracking in builders.md"

## SPIR Progress
- 0002-architect-builder: Moved from PLAN → IMPLEMENT phase
- 0003-end-of-day-reporter: Spec created (NEW)

## Uncommitted Work
- codev/bin/architect (modified, not staged)
- codev/templates/dashboard.html (new file, untracked)

## Stashed Work
- stash@{0}: WIP on feature-branch (created 3:45pm)

## Tomorrow's Focus
Consider completing the architect dashboard and writing tests for the spawn
command before moving to the Defend phase.

================================================================================
```

## Stakeholders
- **Primary Users**: Solo developers and small teams using Codev
- **Secondary Users**: Team leads wanting progress visibility
- **Technical Team**: Codev maintainers
- **Business Owners**: Project stakeholders receiving updates

## Success Criteria
- [ ] Single command generates comprehensive daily report
- [ ] Git activity (commits, branches, diffs) accurately captured
- [ ] SPIR spec/plan/review status changes detected
- [ ] AI narrative summary is coherent and actionable
- [ ] Report renders cleanly in terminal (80-column compatible)
- [ ] Execution completes in <30 seconds
- [ ] Works on macOS and Linux
- [ ] All tests pass with >90% coverage
- [ ] Documentation updated (README, CLAUDE.md)

## Constraints

### Technical Constraints
- Must work without internet for git/file analysis (AI summary requires API)
- Should gracefully degrade if Claude API unavailable (show raw data)
- Must not modify any files (read-only operation)
- Must handle repositories with large git histories efficiently

### Business Constraints
- Should minimize API token usage for cost efficiency
- Must respect any configured API rate limits

## Assumptions
- User has git installed and is in a git repository
- User has Claude Code configured (for AI summary)
- SPIR artifacts follow standard naming conventions (0001-name.md)
- Terminal supports ANSI colors (with fallback for no-color mode)

## Solution Approaches

### Approach 1: Shell Script with Claude CLI
**Description**: Bash script that collects data via git commands and file reads, then pipes to Claude for summarization.

**Pros**:
- Simple to implement
- No additional dependencies beyond `jq`
- Easy to customize/extend
- Follows existing `codev/bin/architect` pattern

**Cons**:
- Shell scripting can be fragile for complex parsing
- YAML/Markdown frontmatter parsing is brittle in bash
- Achieving >90% test coverage is impractical
- BSD vs GNU tool differences (macOS vs Linux)

**Estimated Complexity**: Medium
**Risk Level**: Medium (due to testing/parsing challenges)

### Approach 2: Node.js CLI Tool
**Description**: Node.js script using child_process for git commands and structured data handling.

**Pros**:
- Better JSON/data handling
- Easier testing with Jest/Mocha
- More maintainable for complex logic
- Can use existing Node ecosystem

**Cons**:
- Adds Node.js dependency
- Slightly heavier than shell script
- Different pattern from architect script

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 3: Python CLI with Typer
**Description**: Python script using Typer for CLI, subprocess for git, and structured reporting.

**Pros**:
- Excellent CLI framework (per user preferences)
- Strong typing and error handling
- Good testing ecosystem
- Rich terminal output libraries (rich, colorama)

**Cons**:
- Adds Python dependency
- Different from existing bash tools in codev/bin

**Estimated Complexity**: Medium
**Risk Level**: Low

### Recommended Approach
**Approach 3 (Python with Typer)** - Per expert consultation, Python is recommended over shell for:
1. **Robust parsing**: YAML frontmatter and JSON handling are first-class
2. **Testability**: pytest enables achieving >90% coverage requirement
3. **Cross-platform**: No BSD vs GNU tool differences
4. **Rich output**: The `rich` library provides excellent terminal formatting
5. **User preference**: Aligns with project's Typer preference for CLIs

A thin shell wrapper (`codev/bin/eod-report`) can invoke the Python module for backward compatibility with existing CLI patterns.

## Open Questions

### Critical (Blocks Progress)
- [x] Confirmed: Terminal output only (no file persistence needed for MVP)
- [x] Confirmed: `--no-ai` flag required for offline/fast mode (per expert feedback)

### Important (Affects Design)
- [ ] Should previous reports be cached/stored for historical comparison?
- [ ] How to detect Claude Code session activity? (Investigation needed: check `~/.claude/` for history/logs)
- [ ] How to detect SPIR status changes? (Proposed: parse `Status:` field from markdown frontmatter)

### Nice-to-Know (Optimization)
- [ ] Would users want custom report templates?
- [ ] Integration with time-tracking tools?

## Performance Requirements
- **Response Time**: <30 seconds for full report generation
- **Throughput**: N/A (single user invocation)
- **Resource Usage**: Minimal (shell process + one API call)
- **Availability**: N/A (local tool)

## Security Considerations
- No authentication beyond existing Claude API setup
- Report contains potentially sensitive commit messages (terminal only, no persistence)
- Should not include file contents, only names/stats
- Respects .gitignore for untracked file listings
- **Privacy Warning**: Commit messages and filenames are sent to Claude API for summarization
  - First run should display a privacy notice
  - `--no-ai` flag skips API transmission entirely
  - Consider optional `--local` alias for `--no-ai`

## AI Prompt Design

The AI summary uses a structured JSON input with explicit instructions:

```python
SYSTEM_PROMPT = """You are an Engineering Manager summarizing daily progress.
Focus on WHAT was achieved, not just which files changed.
Do NOT infer or fabricate work not present in the supplied data."""

USER_CONTEXT = {
    "date": "2025-12-02",
    "git_activity": {
        "commits": [...],  # message, branch, stats
        "branches_touched": [...],
        "files_changed": [...],  # names and change magnitude only
        "uncommitted": [...],
        "stashes": [...]
    },
    "spir_progress": [
        {"id": "0002", "title": "...", "phase_before": "PLAN", "phase_after": "IMPLEMENT"}
    ]
}

INSTRUCTIONS = """
1. Produce 2-3 paragraph narrative summary
2. Reference SPIR IDs explicitly (e.g., "Spec 0002")
3. Highlight milestones, blockers, and pending work
4. Suggest tomorrow's focus as bullet list
5. Keep under 200 words
6. If any section is empty, note "No activity" - do not invent content
"""
```

**Token Management**:
- Use `git shortlog` and `git diff --stat` (not full diffs)
- Implement context budget: if >50 commits, summarize with "Plus N other commits"
- Temperature: 0.3 (low, for determinism)

## Test Scenarios

### Functional Tests
1. **Happy path**: Repository with commits today, SPIR specs in progress
2. **No activity**: Repository with no commits since midnight
3. **No SPIR artifacts**: Plain git repo without codev/ directory
4. **Uncommitted changes**: Modified and untracked files present
5. **Multiple branches**: Activity across several branches
6. **Git stashes**: Stashes created today are reported
7. **SPIR phase changes**: Status field changes detected in specs/plans
8. **`--no-ai` flag**: Raw data output without API call

### Non-Functional Tests
1. **Large repo**: Repository with 1000+ commits (test git log efficiency)
2. **API failure**: Claude API unavailable (graceful degradation to raw data)
3. **No color mode**: Terminal without ANSI support (respects NO_COLOR env)
4. **Narrow terminal**: Width <80 columns (graceful wrapping)

## Dependencies
- **External Services**: Claude API (for narrative generation)
- **Internal Systems**: Git repository, codev/ directory structure
- **Libraries/Frameworks**:
  - Python 3.9+
  - `typer` - CLI framework
  - `rich` - Terminal formatting
  - `pyyaml` - YAML frontmatter parsing
  - `anthropic` or `httpx` - Claude API client

## References
- `codev/bin/architect` - Existing CLI pattern to follow
- `codev/specs/0002-architect-builder.md` - Similar CLI tool spec
- SPIR protocol: `codev/protocols/spir/protocol.md`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Claude API changes | Low | Medium | Version-pin API, graceful fallback |
| Large git history slow | Medium | Low | Use --since flag, limit log entries, use --max-count |
| Inconsistent SPIR naming | Low | Medium | Document expected format, warn on mismatches |
| Terminal width issues | Medium | Low | Detect width, provide --width flag |
| Token cost on large repos | Medium | Medium | Context budget, truncate with "Plus N other commits" |
| Privacy concerns | Medium | High | Display warning, provide --no-ai flag |
| Git timestamp confusion | Low | Medium | Use committer date with --date=local explicitly |
| Claude Code session detection | High | Low | Document as "best effort", may be unavailable |

## Expert Consultation
**Date**: 2025-12-02
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro

### Key Feedback Incorporated:

**From GPT-5 Codex**:
- Changed recommended approach from Shell to Python for testability and robust parsing
- Added timezone clarification (local system time)
- Added `--no-ai` flag as confirmed requirement
- Added context budget for token management
- Recommended structured JSON prompt with low temperature
- Highlighted git stash as missing data source

**From Gemini 3 Pro**:
- Confirmed Python over Shell for YAML/JSON parsing robustness
- Emphasized privacy warning for API data transmission
- Recommended `git shortlog` + `git diff --stat` over full diffs
- Added narrow terminal test scenario
- Noted Claude Code session detection as high-risk unknown
- Suggested investigating `~/.claude/` for session logs

**Sections Updated**:
- Solution Approaches: Changed recommendation to Python
- Open Questions: Added `--no-ai` as confirmed, added SPIR status detection
- Security Considerations: Added privacy warning section
- AI Prompt Design: New section with structured prompt and token management
- Test Scenarios: Added stash, phase changes, --no-ai, and narrow terminal tests
- Dependencies: Updated for Python ecosystem
- Risks and Mitigation: Added token cost, privacy, timestamp, and session detection risks

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete (GPT-5 Codex + Gemini 3 Pro, 2025-12-02)

## Notes
- Consider future expansion to support Slack/email output as additional delivery modes
- Could integrate with the Architect-Builder dashboard for visual reporting
- May want to track "focus time" if Claude Code hooks can capture session duration
