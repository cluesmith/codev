# Review: TICK-004 — Genericize Artifact Resolver + Fix Bugs

## What Was Amended and Why

Spec 559 introduced a FAVA Trails artifact resolver for porch. TICK-004 fixes bugs in the resolver pipeline and genericizes naming for upstream acceptance.

## Changes Made

### Bug Fixes
1. **Critical**: `handleOncePhase()` in `next.ts:733` now passes `resolver` to `buildPhasePrompt()`. Previously all TICK/BUGFIX protocols silently ignored the external resolver.
2. **Error caching**: CLI failures are no longer cached as `null`. Only successful results are cached. This prevents transient CLI failures from poisoning lookups.
3. **hasPreApproval()**: Implemented via shared `isPreApprovedContent()` helper used by both `LocalResolver` and `CliResolver`.
4. **Diagnostic logging**: `getProjectSummary()` now logs which fallback source is used (GitHub issue → spec heading → title).

### Genericization
- `FavaTrailsResolver` → `CliResolver`
- `backend: 'fava-trails'` → `backend: 'cli'` (with `'fava-trails'` as alias)
- New `artifacts.command` config field (defaults to `'fava-trails'`)
- `CODEV_ARTIFACTS_DATA_REPO` env var (reads legacy `FAVA_TRAILS_DATA_REPO` as fallback)

## Consultation

**Date**: 2026-03-16
**Model**: GPT-5.3 Codex via Pal MCP (`mcp__pal__codereview`)
**Verdict**: Approved with one refinement — don't cache CLI errors at all (adopted).

Key feedback:
- Confirmed all 4 bugs are correctly identified and fixed
- Recommended not caching errors (implemented)
- Suggested shared `isPreApprovedContent()` helper (implemented)
- Noted upstream should document the CLI protocol (`get` and `get --list` contract)

**3-way consensus review** (2026-03-16):
**Models**: Gemini 3.1 Pro (for), GPT-5.3 Codex (against), DeepSeek v3.2 (neutral)
**Verdict**: Unanimous approval with 3 fixes applied:
1. `hasPreApproval()` now parses artifact type from glob (specs/plans/reviews) and calls the correct getter — previously always checked spec content
2. Negative cache with sentinel value — CLI failures are now cached to avoid repeated 5s timeouts, using a Symbol sentinel to distinguish from empty string results
3. Empty listing output is now cached — prevents repeated CLI calls for scopes without children

## Upstream

Feature request created: https://github.com/cluesmith/codev/issues/612

## Architecture Updates

No architectural changes — this is a rename + bug fix within the existing resolver abstraction.

## Lessons Learned Updates

- **Thread resolvers through ALL code paths**: When adding a pluggable abstraction, grep for every call site — `handleOncePhase` was missed because it was a less-common code path (TICK/BUGFIX vs SPIR).
- **Don't cache errors**: Caching successful results is fine for performance, but caching failures as `null` makes transient errors permanent and indistinguishable from "not found".
- **Generic naming from day one**: Naming a class after a specific tool (`FavaTrailsResolver`) makes it hard to upstream. Use generic names (`CliResolver`) that describe the mechanism, not the implementation.
