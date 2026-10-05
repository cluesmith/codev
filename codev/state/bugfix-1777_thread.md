# bugfix-1777 thread

## Investigate (2026-10-05)
- Root cause: `packages/codev/src/agent-farm/servers/overview.ts` `GATE_LABELS` is an allowlist (spec/plan/dev-approval, pr, verify-approval). `detectBlocked`/`detectBlockedGate`/`detectBlockedSince` iterate only it, so a pending `experiment-complete` never sets `blocked`/`blockedGate`.
- Audit of skeleton protocol.json gates: also missing `maintain-complete` (MAINTAIN), `scope-approval` + `research-complete` (RESEARCH). Same blind spot.
- Downstream consumers (web NeedsAttentionList, vscode GATE_ICONS -> bell, streamdeck face titleToken fallback) all degrade generically once Tower reports the gate.
- Fix plan: detect ANY gate with status pending + requested_at (known gates first, preserving order), label from map with a fallback derived from the gate name; add labels for the 4 missing gates; add vscode icons (beaker etc.).

## PR #1778 (2026-10-05)
- Fix: generic pending-gate detection in overview.ts + 4 VS Code icons. CMAP iter1: gemini APPROVE, codex COMMENT (branch behind main, merges clean), claude APPROVE.
- Took claude's nits: test pinning known-gates-first order; fallback label strips `-review` (no "code review review").
- Follow-up (not this PR): Stream Deck face.ts GATE_ICONS/GATE_LABELS and dashboard gateKindClass lack the 4 gates; designed fallbacks apply (bell / name token / plan styling).

## Integration review round (2026-10-05)
- main REQUEST_CHANGES (same defect, second site): `extractProjectIdFromWorktreeName` had no case for experiment-/maintain-/research- worktrees, so `discoverBuilders` went soft-mode and never read status.yaml; the gate detection fix was unreachable for exactly those lanes.
- Fix: generic `^[a-z]+-(\d+)(?:-|$)` -> bare number, after an explicit task-/worktree- -> null exclusion (all-digit short ids stay soft). Porch convention verified: experiment-1560 worktree, project dir 1560-slug, id '1560'; maintain/research spawn via the same spawnSpec path.
- Replaced the old `unknown-123-slug -> null` test (it pinned the defect). Added discoverBuilders-layer test (experiment-1560 pending experiment-complete -> strict, blocked) + task-123 stays soft.
- Residual edge (flagged, not fixed): `--protocol` without an issue gives a random 4-char shortId; an all-digit one (~1/1700) is indistinguishable from an issue number by name.
