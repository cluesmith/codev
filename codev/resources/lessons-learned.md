# Lessons Learned

<!-- Lessons -- most important first -->

Generalizable wisdom extracted from review documents, ordered by impact. Updated during MAINTAIN protocol runs.

> **Note**: Items codified as rules (CLAUDE.md invariants, protocol requirements) are not repeated here.

---

## Critical (Prevent Major Failures)

- [From 0008] Single source of truth beats distributed state - consolidate to one implementation
- [From 0009] Check for existing work (PRs, git history) before implementing from scratch
- [From bug reports] Tests passing does NOT mean requirements are met - manually verify the actual user experience before marking complete
- [From 0043] Establish baselines BEFORE optimizing - before/after data makes impact clear

## Security

- [From 0048] DOMPurify for XSS protection when rendering user-provided content
- [From 0048] External links need `target="_blank" rel="noopener noreferrer"`
- [From 0055] Context matters for escaping: JS context needs different escaping than HTML context
- [From 0052] Security model documentation is essential for any system exposing HTTP endpoints, even localhost-only

## Architecture

- [From 0031] SQLite with WAL mode handles concurrency better than JSON files for shared state
- [From 0039-TICK-005] Prefer CLI commands over AI agents for well-defined operations (discoverability, arg parsing, shell completion)
- [From 0034] Two-pass rendering needed for format-aware processing (e.g., table alignment)
- [From 0048] Three-container architecture (viewMode, editor, preview) provides clean separation for multi-mode UIs
- [From 0039] Embedding templates in npm packages ensures offline capability and version consistency
- [From 0060] When modularizing large files, group by concern (CSS together, JS together) not by feature

## Process

- [From 0044] Phased approach makes progress visible and commit messages meaningful
- [From 0054] Keep specs technology-agnostic when implementation should match existing codebase patterns
- [From 0059] Verify what data is actually available in state before designing features that depend on it
- [From 0057] Always handle both new and existing branches when creating worktrees

## Testing

- [From 0009] Verify dependencies actually export what you expect before using them
- [From 0041] Tarball-based E2E testing catches packaging issues that unit tests miss
- [From 0039-TICK-005] Regex character classes need careful design - consider all valid characters in user input
- [From 0059] Timezone handling: use local date formatting, not UTC, when displaying to users

## UI/UX

- [From 0050] Differentiate "not found" vs "empty" states to prevent infinite reload loops
- [From 0050] State-change hooks should run after every state update, not just on init
- [From 0055] Be selective about file exclusions - exclude heavyweight directories, not all dotfiles
- [From 0057] Follow git's branch naming rules - use pattern-based rejection, not whitelist
- [From 0002-001] Shell escaping in tmux: complex content with backticks/quotes needs launch scripts

## Documentation

- [From 0044] Documentation synchronization burden (multiple identical files) is error-prone - consider single source
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)

## 3-Way Reviews

- [From 0054] Each reviewer catches different aspects - Claude: spec compliance, Gemini: API correctness, Codex: practical issues
- [From 0061-002] Security vulnerabilities (XSS) often identified in 3-way review that weren't in initial implementation

---

*Last updated: 2025-12-28 (Maintenance Run 0004)*
*Source: codev/reviews/*
