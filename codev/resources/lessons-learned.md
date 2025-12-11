# Lessons Learned

Consolidated wisdom extracted from review documents. Updated during MAINTAIN protocol runs.

---

## Testing

- [From 0001] Always use XDG sandboxing in tests to avoid touching real $HOME directories
- [From 0001] Never use `|| true` patterns that mask test failures
- [From 0001] Create control tests to verify default behavior before testing modifications
- [From 0009] Verify dependencies actually export what you expect before using them (xterm v5 doesn't export globals)
- [From 0041] Tarball-based E2E testing catches packaging issues that unit tests miss
- [From 0041] Tests should be independent and run in any order for parallel execution

## Architecture

- [From 0008] Single source of truth beats distributed state - consolidate to one implementation
- [From 0008] File locking is essential for concurrent access to shared state files
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files
- [From 0034] Two-pass rendering needed for format-aware processing (e.g., table alignment)
- [From 0039] CLI shim pattern (thin wrappers injecting into main CLI) provides backwards compatibility
- [From 0039] Embedding templates in npm packages ensures offline capability and version consistency
- [From 0039 TICK-005] CLI commands are more discoverable than AI agents (--help, shell completion)
- [From 0048] Three-container architecture (viewMode, editor, preview) provides clean separation for multi-mode UIs
- [From 0052] SQLite schema IS documentation - helps readers understand the data model without reading code

## Process

- [From 0001] Multi-agent consultation catches issues humans miss - don't skip it
- [From 0001] Get FINAL approval from ALL experts on FIXED versions before presenting to user
- [From 0005] Failing fast with clear errors is better than silent fallbacks
- [From 0009] Check for existing work (PRs, git history) before implementing from scratch
- [From 0039 TICK-005] For complex decision-making tasks, consider "AI-in-the-loop" over complex algorithms
- [From 0043] Establish baselines BEFORE optimizing - before/after data makes impact clear
- [From 0044] Phased approach makes progress visible and commit messages meaningful
- [From 0044] Test-first verification (grep for remaining references before committing) catches issues early

## Documentation

- [From 0001] Update ALL documentation after changes (README, CLAUDE.md, AGENTS.md, specs)
- [From 0008] Keep CLAUDE.md and AGENTS.md in sync (they should be identical)
- [From 0044] Documentation synchronization burden (CLAUDE.md, AGENTS.md, skeleton) is error-prone - consider single source
- [From 0051] Comparison tables communicate paradigm shifts effectively (e.g., Traditional vs Codev)
- [From 0051] Quick reference sections (checklists, workflow boxes) provide actionable quick-start guides
- [From 0051] ASCII diagrams work well for conceptual relationships in markdown
- [From 0052] ASCII diagrams render consistently and work well in terminal-based documentation
- [From 0052] Error handling deserves its own documentation section - helps operators troubleshoot
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)

## Tools

- [From 0009] When shell commands fail, understand the underlying protocol before trying alternatives
- [From 0031] Use atomic database operations instead of read-modify-write patterns on files
- [From 0039 TICK-005] When writing regexes for user input (URLs), consider all valid characters in the domain
- [From 0043] Use official/documented configuration over undocumented env vars (e.g., experimental_instructions_file vs CODEX_SYSTEM_MESSAGE)
- [From 0043] Model reasoning effort tuning (low/medium/high) can significantly impact performance without quality loss

## Security

- [From 0048] DOMPurify for XSS protection when rendering user-provided markdown
- [From 0048] Link rendering should always include `target="_blank" rel="noopener noreferrer"`
- [From 0052] Security model is essential for infrastructure - even localhost-only services need explicit documentation

## UX

- [From 0050] Click event propagation needs `stopPropagation()` when moving handlers from parent to child
- [From 0050] State-change hooks - when adding polling intervals, ensure checkState() is called after every state update (not just on init)
- [From 0050] Differentiate "not found" vs "empty" responses to prevent infinite reload loops
- [From 0050] UX consistency - if removing click behavior, also remove visual indicators (cursor, hover)

---

*Last updated: 2025-12-11*
*Source: codev/reviews/*
