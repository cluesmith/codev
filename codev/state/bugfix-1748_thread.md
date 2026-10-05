# bugfix-1748 thread

## Investigate
- Root cause: `agentCycleAttemptOrder` (apps/vscode/src/views/builders.ts) returned `[]` for `order.length <= 1` before looking at `currentIndex`, so a 1-agent roster with nothing focused (-1) hinted instead of opening the sole agent. extension.ts used one hint text for both empty roster and "only agent is focused".
- Existing unit test asserted the buggy `solo, -1 -> []` case; it becomes the regression test.
- Fix scope: guard change + distinct empty-roster hint in the command. Well under BUGFIX ceiling.

## Fix + PR
- Guard split in `agentCycleAttemptOrder` (empty -> []; lone+focused -> []; else walk). extension.ts: empty roster hints "Codev: no agent terminals".
- Regression test fails on main, passes with fix. tsc clean; vscode suite 1026/1026.
- PR #1749. CMAP: gemini=APPROVE, codex=COMMENT (stale overview comment at extension.ts:875; PR body named wrong keys, actual bindings are cmd+alt+N/P), claude=COMMENT (same stale comment + a long doc line). All addressed in comment-only follow-ups.
- Command hint texts are not unit-reachable (closure inside activate()); noted in PR body.
- Mishap: a scratch backup of builders.ts briefly landed in the main checkout's .builders/ dir via a bad relative path; deleted immediately, no other effect.
