# Rebuttal — Phase 4, iteration 2

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. Codex and Claude *disagreed* on the one point — Codex called it a summary⇄detail bug, Claude called it intended-per-A2. Resolved cleanly for both.

## The tension
While viewing builder X's worktree artifact, `resolveSelection`'s `?? artifact.builderId` fallback kept every Code Review / Builder Inspector navigation on X's detail, so the cross-builder summary was unreachable in-mode.

## Fix — move A2 navigation-scoping from the pure resolver to the provider, add zoom-out
- **Resolver:** removed the artifact fallback from `resolveSelection`. It is now purely `selection.builderId → detail, else summary` — navigation policy does not belong in the pure decision core. (The contextual A2 — a worktree artifact's Document Review carrying its builderId — is unchanged.)
- **Provider (`selectionForNavigate`):** first-navigating to Code Review / Builder Inspector while viewing a worktree artifact scopes to that builder (A2 preserved — richer context for free). Clicking the mode you are already in at DETAIL zooms out to its summary. So: view X's spec → click Code Review → X's detail (A2); click Code Review again → cross-builder summary (reachable, per Codex).
- **Tests:** resolver test asserts no artifact fallback (bare `{mode}` over a worktree artifact → summary; `{mode, builderId}` → detail). Provider test: first Code Review click on a worktree artifact → X detail, second click → summary.

This satisfies both reviewers and keeps A2's default. Because it refines the *navigation* semantics of the architect's A2 decision, it is flagged to the architect (who can veto the zoom-out).

## Result
74 files / 891 tests, check-types (both tsconfigs) + eslint + build clean.
