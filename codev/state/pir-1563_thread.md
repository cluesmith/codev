# pir-1563 — Cycle agent terminals from keyboard and Stream Deck

## Context
PIR protocol, issue #1563. Two new VS Code commands (`codev.focusNextAgentTerminal` /
`codev.focusPreviousAgentTerminal`) that cycle agent terminals in the exact rendered order of the
sidebar Agents section (grouping-aware, wrap-around), plus a Stream Deck motion (dial rotation +
key-pair fallback) via the established command-relay path.

## Log

### PLAN phase — started
- Investigating: (1) Agents tree provider rendered order + grouping, (2) terminal open/focus
  commands, (3) Stream Deck relay path + face.ts. Two Explore agents dispatched.
- Key constraint from issue: single source of truth for ordering (shared-function lesson #818) —
  derive roster from the same data the Agents tree renders, do not build a parallel order.

### PLAN phase — findings & plan written
Two Explore agents mapped both sides. Key facts:
- Rendered order = `orderForDisplay(builders)` + `active().group(...)` (builder-grouping.ts),
  flattened by `rootChildren()`/`architectRootChildren()` in `views/builders.ts`.
- Axis matters: stage/area render builders only (architects not shown); architect axis renders
  architect headers (openable) interleaved with their builders, main-first then populated then
  idle. So the cycle roster is axis-dependent by design ("mirror sidebar exactly").
- Terminal registry: `TerminalManager.terminals` keyed `builder-<id>` / `architect:<name>` /
  `dev-<id>` / `shell-<n>`. `getActiveBuilderId()` exists; need to add `getActiveArchitectName()`.
- Deck relay: `VERB_COMMANDS` allowlist in `command-relay.ts`; add `focus-next-agent`/`focus-prev-agent`.
  Dial = SingletonAction + setFeedback (like ScrollNav); keys = VerbKey. face.ts has `labelFaceSvg`
  + glyphs 'terminal'/'switch'.
- Deck-follow is builder-only (`builder-active` activity hook on terminal focus); no architect-focus
  signal → deck face can show builder id natively but not architect name without extra work.

Plan: Phase 1 = VS Code commands + shared `agentCycleOrder()` (extract `partitionArchitectGroups`
to share architect-axis order with the renderer, anti-drift test) + `getActiveArchitectName` +
keybindings. Phase 2 = Stream Deck dial + key-pair + relay verbs + face. Both commits in one PR.

4 decision points surfaced for the reviewer: keybinding chord (cmd+k ]/[ pending verification),
deck surface, deck-face architect support, and confirming the axis-dependent roster.
Plan written to `codev/plans/1563-cycle-agent-terminals-from-key.md`. Awaiting plan-approval gate.
