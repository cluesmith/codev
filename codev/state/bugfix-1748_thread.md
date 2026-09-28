# bugfix-1748 thread

## Investigate
- Root cause: `agentCycleAttemptOrder` (apps/vscode/src/views/builders.ts) returned `[]` for `order.length <= 1` before looking at `currentIndex`, so a 1-agent roster with nothing focused (-1) hinted instead of opening the sole agent. extension.ts used one hint text for both empty roster and "only agent is focused".
- Existing unit test asserted the buggy `solo, -1 -> []` case; it becomes the regression test.
- Fix scope: guard change + distinct empty-roster hint in the command. Well under BUGFIX ceiling.
