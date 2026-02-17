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
- [From 0065/PR-133] NEVER skip CMAP reviews - they catch issues manual review misses (e.g., stale commits in PR, scope creep)
- [From 0085] When guessing fails, build a minimal repro - capturing raw data beats speculation (crab icon fix took 5 failed attempts, then 1 repro solved it)
- [From scroll saga] Intermittent bugs = external state mutation. Grep for everything that touches the state before attempting fixes. The scroll issue took ~10 hours because we kept fixing the renderer instead of finding what was flipping terminal settings (one flag, one character)
- [From scroll saga] Consult external models EARLY. Three AI consultations found the root cause in minutes; solo debugging produced three failed quick fixes over hours
- [From scroll saga] Never spawn builders for symptom fixes. If you don't understand the root cause, more code won't help — PRs #220 and #225 were wasted work

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
- [From 0085] PTY sessions need full locale environment (LANG=en_US.UTF-8) — terminal multiplexers use client locale to decide Unicode vs ASCII rendering

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
- [From 0002-001] Shell escaping in terminal multiplexers: complex content with backticks/quotes needs launch scripts
- [From 0085] xterm.js `customGlyphs: true` renders block elements (▀▄█) procedurally — crisp at any size, no font dependency
- [From scroll saga] Global terminal multiplexer flags can poison ALL sessions. Always use session-scoped settings. One global flag poisoned every session on the machine

## Documentation

- [From 0044] Documentation synchronization burden (multiple identical files) is error-prone - consider single source
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)

## 3-Way Reviews

- [From 0054] Each reviewer catches different aspects - Claude: spec compliance, Gemini: API correctness, Codex: practical issues
- [From 0061-002] Security vulnerabilities (XSS) often identified in 3-way review that weren't in initial implementation
- [From CMAP analysis] Codex catches security edge cases (SSRF bypass, path traversal, file permissions) that other reviewers miss; blocked in 38 rounds across Jan 30-Feb 13 window
- [From CMAP analysis] CMAP misses proxy/deployment topology bugs and React lifecycle/WebSocket timing issues — add "works behind reverse proxy?" to review checklist for HTTP specs
- [From CMAP analysis] When 2/3 approve for 3+ consecutive rounds, auto-advance with documented dissent — prevents 7-10 iteration loops (seen in 0097 Phase 7, 0101 Phase 4)
- [From CMAP analysis] Full analysis with ROI data: `codev/resources/cmap-value-analysis-2026-02.md`

---

*Last updated: 2026-02-13 (CMAP value analysis)*
*Source: codev/reviews/*
