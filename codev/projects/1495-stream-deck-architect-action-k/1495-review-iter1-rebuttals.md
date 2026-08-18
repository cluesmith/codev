# PIR #1495 — Consultation iteration 1: rebuttals / dispositions

Verdicts: **Gemini APPROVE**, **Claude APPROVE**, **Codex REQUEST_CHANGES**.

All three Codex findings are **documentation/verification** points (no code-correctness defect
was raised — Codex's own summary calls the implementation "sound"). Two were valid and are
**fixed**; one is a **scope/owner-decision** matter and is rebutted. Dispositions below.

## Codex 1 — "README does not explain how/where to apply the shipped `switch.png`" — FIXED

Valid. The plan promised README wiring steps and the Design section only stated the icon exists.
**Fixed** by adding a **"Wiring the native switch"** block to `apps/streamdeck/README.md` that
names the icon path (`com.cluesmith.codev.sdPlugin/icons/switch.png` / `@2x`) and gives the three
concrete native mechanisms — swipe (no key), a **Folder** key (set its image to `switch.png`), and
a **Switch Profile** key on each of two profiles (same icon) — plus the note that no built-in key
jumps to a specific page within one profile, so a switch *button* means a Folder or a second
profile.

## Codex 3 — "README lines 213–220 keep a contradictory old Row-1 Main-mode recommendation" — FIXED

Valid, and self-inflicted: I updated the layout to a two-page builders/architects board (removing
the Row-1 `main` anchor) but left the **Open Architect Terminal** action entry recommending that
key in "Row 1 slot 1". **Fixed** — that entry now recommends **Row 2 in Builder mode** (opens the
selected builder's architect) and states that reaching any *other* architect, `main` included, is
the new **Architects board's** job, so the key needn't carry Main mode. Main mode is still
documented as available on a spare key, but the stale "Row 1 slot 1 recommended" line is gone.

## Codex 2 — "Review records testing via page swipe, not the native switch button" — REBUTTED (with an honesty fix)

Not a defect — a scope decision by the owner, now made explicit in the review. During the
dev-approval gate the owner elected **page-swipe** for board navigation over a switch *button*
(verbatim: "swiping is enough actually"). The switch button is an **optional, native Stream Deck
affordance** (a Folder or Switch-Profile key), **not plugin code** — the plugin ships only the
`switch` icon; the key's behavior is Stream Deck's own. So there is nothing of *ours* to
hardware-verify on that path beyond the icon rendering, and re-driving it wouldn't test any code in
this PR.

What I *did* change: the review's manual-verification note now states plainly that page-swipe was
the chosen and verified navigation, and that the switch button is documented-but-not-hardware-
exercised because it is native, not plugin, behavior. That keeps the record honest without
claiming a verification that (a) the owner descoped and (b) would exercise Stream Deck, not this
change.

## Single-pass note

PIR consultation is `max_iterations: 1`, so these dispositions are **not** independently
re-reviewed. The two fixes are documentation-only (no code, so no regression test applies); the
one rebuttal rests on an owner decision recorded in the session. The human at the `pr` gate is the
remaining reviewer — this rebuttal + the README/review edits are for that review.
