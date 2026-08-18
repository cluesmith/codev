# pir-1498 — Scroll dial narrates itself

## Context
PIR builder for issue #1498. Bring `ScrollNav` (`apps/streamdeck/src/actions.ts`)
onto the ReviewNav house pattern: `setFeedback` + `store.onChange`, so the dial names
its live delivery mode (`Scroll · queue`/`Scroll · send`), shows the selected builder,
a progress bar, and a visibly-inert `No builder` empty state. Rotation unchanged.

## Plan phase
- Investigated `actions.ts`: ScrollNav (line 933) is a bare `setTitle('Scroll')` in
  onWillAppear, no subscription, no setFeedback. ReviewNav (line 775) is the exact
  pattern to adopt — tracked `current?: DialAction`, `store.onChange`, renderTo
  composing `{title, value, bar}`, incl. `axis · mode` line-1 and `No builder`.
- Store: `feedbackMode()` → 'forward'|'queue' (line 179); `selectedBuilder()` (146).
  Label form is `feedbackMode()==='queue' ? 'queue' : 'send'` (matches ReviewNav 815).
- **Manifest finding:** scroll-nav uses `layouts/label.json` (title-only); the
  house-layout dials use `layouts/dial.json` (title/value/bar). Must switch scroll-nav
  to dial.json to render the bar. label.json is used ONLY by scroll-nav → orphaned.
  Both files are `apps/streamdeck` — still in scope (no VS Code / relay / types change).
- **Decision 1 (press earns its place):** recommend KEEP. The press is what makes the
  mode label meaningful, and queue mode's press is the deck-shaped reversible loop.
- **Decision 2 (bar):** builder progress, per neighbours. Scroll position not available
  (VS Code owns viewport; ReviewNav comment records why). Never invent a position bar.

Plan drafted → `codev/plans/1498-stream-deck-the-scroll-dial-do.md`. Awaiting
plan-approval gate.
