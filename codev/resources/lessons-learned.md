# Lessons Learned

Consolidated wisdom extracted from review documents. Updated during MAINTAIN protocol runs.

---

## Testing

- [From 0001] Always use XDG sandboxing in tests to avoid touching real $HOME directories
- [From 0001] Never use `|| true` patterns that mask test failures
- [From 0001] Create control tests to verify default behavior before testing modifications
- [From 0009] Verify dependencies actually export what you expect before using them (xterm v5 doesn't export globals)
- [From 0039-TICK-005] Regex character classes need careful design for user input - consider all valid characters (e.g., dots in repo names like `next.js`)
- [From 0041] Tarball-based E2E testing catches packaging issues that unit tests miss
- [From 0041] Tests should be independent and run in any order for parallel execution

## Architecture

- [From 0008] Single source of truth beats distributed state - consolidate to one implementation
- [From 0008] File locking is essential for concurrent access to shared state files
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files
- [From 0034] Two-pass rendering needed for format-aware processing (e.g., table alignment)
- [From 0039] CLI shim pattern (thin wrappers injecting into main CLI) provides backwards compatibility
- [From 0039] Embedding templates in npm packages ensures offline capability and version consistency
- [From 0039-TICK-005] Prefer CLI commands over AI agents for well-defined operations (better discoverability via --help, consistent arg parsing, shell completion)
- [From 0039-TICK-005] Interactive AI sessions simplify complex merges - "AI-in-the-loop" pattern over complex algorithms
- [From 0048] Three-container architecture (viewMode, editor, preview) provides clean separation for multi-mode UIs

## Process

- [From 0001] Multi-agent consultation catches issues humans miss - don't skip it
- [From 0001] Get FINAL approval from ALL experts on FIXED versions before presenting to user
- [From 0005] Failing fast with clear errors is better than silent fallbacks
- [From 0009] Check for existing work (PRs, git history) before implementing from scratch
- [From 0043] Establish baselines BEFORE optimizing - before/after data makes impact clear
- [From 0044] Phased approach makes progress visible and commit messages meaningful
- [From 0044] Test-first verification (grep for remaining references before committing) catches issues early
- [Bug report] 3-way review can approve code that completely misses UX requirements - add manual testing step

## Documentation

- [From 0001] Update ALL documentation after changes (README, CLAUDE.md, AGENTS.md, specs)
- [From 0008] Keep CLAUDE.md and AGENTS.md in sync (they should be identical)
- [From 0044] Documentation synchronization burden (CLAUDE.md, AGENTS.md, skeleton) is error-prone - consider single source
- [From 0051] Table-based formatting (Traditional vs Codev) effectively communicates paradigm shifts
- [From 0051] ASCII art diagrams work well for showing conceptual relationships in markdown
- [From 0052] Security model documentation is essential for any system exposing HTTP endpoints, even localhost-only
- [From 0052] Error handling deserves its own section - documents recovery mechanisms for operators
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)

## Tools

- [From 0009] When shell commands fail, understand the underlying protocol before trying alternatives
- [From 0031] Use atomic database operations instead of read-modify-write patterns on files
- [From 0043] Use official/documented configuration over undocumented env vars (e.g., experimental_instructions_file vs CODEX_SYSTEM_MESSAGE)
- [From 0043] Model reasoning effort tuning (low/medium/high) can significantly impact performance without quality loss

## Security

- [From 0048] DOMPurify for XSS protection when rendering user-provided markdown
- [From 0048] Link rendering should always include `target="_blank" rel="noopener noreferrer"`

## UI/UX

- [From 0050] Differentiate "not found" vs "empty" - use hash/flag to track "file was loaded" and prevent infinite reload loops
- [From 0050] State-change hooks - call checkState() after every state update, not just on init (prevents resource leaks)
- [From 0050] UX consistency: if you remove click behavior, also remove visual indicators (cursor, hover)
- [Bug report] Tests passing does NOT mean UX requirements are met - manually verify the actual user experience
- [Bug report] If spec says "async" and code is sync, that's a critical bug even if tests pass
- [Bug report] Code reviews miss UX gaps - reviewers must actually USE the feature as a user would
- [Bug report] Compare spec flow diagrams to actual behavior before approving PRs

---

*Last updated: 2025-12-19 (UX Verification Process Improvements)*
*Source: codev/reviews/*
