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

### Plan review (architect) — APPROVED with additions, revised
Architect ratified both decisions and required three additions (commit revising):
- Decision 1: state the mutual-reinforcement argument — the press justifies the label
  AND the label justifies the press; dropping the press removes the reason the strip
  exists. Forecloses a later "simplify away the press".
- Reframe root cause: the dial was *declared* a different control type (label.json vs
  the siblings' dial.json); code + manifest were self-consistent but sibling-inconsistent.
- REQUIRED: delete orphaned layouts/label.json in the same PR (grep-verified sole ref is
  the manifest line being changed). Precedent #1440 (six dead PNGs).
Cross-lane awareness only: pir-1495 adds explicit assertions for four manifest-less
PNGs (the inverse case); no general "every shipped asset referenced" check here.
Revised + recommitted; re-requesting gate.

### Decision 2 reversed by human reviewer — DROP THE BAR
Human (in-pane) directed dropping the bar: on this dial rotation (viewport scroll) and
builder-progress are unrelated axes, and scroll-position (the only related bar) isn't
available. Neither candidate bar is both available AND related → show none.
Ripple: layout is now title+value (no bar), NOT the siblings' dial.json (whose default
bar:0 would render a false empty bar). So `label.json` → renamed `scroll.json`
(title+value), NOT switched-to-dial.json + deleted. This SUPERSEDES the architect's
earlier required addition (switch to dial.json + delete label.json). Flagged to architect.
This trades strict visual uniformity for honesty; the Scroll dial becomes the one dial
without a bar (line1+line2 still match house shape).

### Scope addition (architect) — fold a stranded doc from pir-1495
Carrying a doc-only append into this PR: append "Protocol Note — the pir-1495 lane
reproduced #1462 live" to codev/reviews/1495-stream-deck-architect-action-k.md ON MAIN
(one edit: "this lane"→"the pir-1495 lane"). Saves a standalone CI cycle (precedent
#1454). Accepted — it touches a file mine doesn't; keep as its own labelled commit so it
stays separable in consult/review. Must fetch origin/main first so the append lands on
the file's live content (my branch predates pir-1495's merge). Recorded in plan under
"Out-of-band".
