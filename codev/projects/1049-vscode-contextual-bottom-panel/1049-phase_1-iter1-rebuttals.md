# Rebuttal — Phase 1 (Mode resolver + contract types), iteration 1

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES** (single issue: the code was untracked), **Claude COMMENT** (verified the full suite + types + lint green; two substantive gaps). All adopted.

## Process — code was uncommitted (Codex, Claude #3)

Correct and my miss: I signalled `PHASE_COMPLETE` with `types.ts` / `resolver.ts` / the test still untracked, so the reviewer diff contained only doc/state files (Gemini and Claude reviewed from disk; Codex, which reads the diff, saw no implementation). **Fixed:** committed as `[Spec 1049][Phase: phase_1] …` (`af384f9bd`) before continuing. The code, tests, and this rebuttal are now in the branch.

## Substantive (Claude)

1. **A2 "scoped to that builder" was not realized.** Correct — `resolveSelection` dropped `artifact.builderId`, so clicking Code Review while viewing `.builders/<id>/…` gave the generic cross-builder summary, and the A2 test's applicability assertion (`code-review === true`) was vacuous. **Fixed:** `resolveSelection` now uses `scopedBuilderId = drilledBuilderId ?? artifact?.builderId` for the builder-scoped modes, so navigating to Code Review / Builder Inspector while viewing a worktree artifact lands on *that builder's* detail. Added three real tests: worktree-artifact + Code Review → detail scoped to the builder; same for Builder Inspector; and a plain (non-worktree) artifact → summary (no builder in scope). This realizes the architect's A2 decision rather than leaving it a no-op.

2. **No automated purity/no-I/O guard.** The spec makes "no filesystem/network I/O (automated assertion)" a success criterion. **Fixed:** added a source-scan test that reads `resolver.ts` and asserts its only import specifier is `./types.js` (and no `vscode` / `node:` imports), making the O(1)/pure invariant enforceable rather than conventional.

3. **Nit — malformed `ManualSelection.builderId` not pinned.** **Fixed:** the never-throws case table now crosses six malformed surfaces × six malformed selections (including `{ mode: 'code-review', builderId: 42 }`, a bare `builderId`, a non-mode string, and a non-object), asserting no throw for every pair.

## Result

`vitest run` on the suite: **28/28 pass** (was 24); full `test:unit`: 69 files / 836+ pass; `check-types` clean (both tsconfigs); `eslint` clean on all three files. Resolver remains pure (enforced by the new guard). Gemini's APPROVE stands; the two substantive points and the process miss are resolved.
