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

## Codex 2 — "Review records testing via page swipe, not the native switch button" — PARTIALLY REBUTTED + GAP CLOSED

Codex pointed at the switch *button press*, which is genuinely **not ours** — so that framing is
dismissed — but there was a real gap underneath it, and the honest split matters because a rebuttal
outlives the PR:

- **The native key's BEHAVIOUR is Elgato's.** A Switch-Profile / Folder key runs Stream Deck's own
  code; the plugin contributes none of it. During the dev-approval gate the owner elected
  **page-swipe** for board navigation over a switch button ("swiping is enough actually"), so there
  is no *plugin* behaviour to hardware-verify on that path. Correctly out of scope.
- **The icons and the documented procedure ARE ours.** The four `switch` PNGs and the README wiring
  steps are things this PR ships. My first draft said "nothing of ours is left unverified" — that
  was **wrong**: the `switch` icon was the plugin's one shipped asset with **no test coverage**,
  because `manifest-icons.test.ts` builds its ref set from `manifest.Actions` and the switch icon is
  manifest-less (no action references it), so the generic loop structurally can't see it. **Gap
  closed:** added explicit existence + convention-size assertions for all four switch PNGs, matching
  the pinned form the file already uses for the other dedicated icons.

The useful generalisation: **the gap lived in the seam between "our code" and "the platform's
feature".** Everything on our side (store, action, face, the action icon) had coverage; everything
on Elgato's side (the switch key's behaviour) was correctly out of scope; and four PNGs plus a
README procedure sat *in between* — belonging to us while looking like the platform's — which is
exactly where an asset slips through both the manifest-driven test and the "it's native" dismissal.

The review's manual-verification note also now states plainly that page-swipe was the chosen and
verified navigation, and that the switch button itself is native (not plugin) behaviour, documented
but not hardware-exercised.

## Single-pass note

PIR consultation is `max_iterations: 1`, so these dispositions are **not** independently
re-reviewed. Fixes 1 and 3 are documentation; the Codex-2 gap-close adds a real test
(`manifest-icons.test.ts` switch-PNG assertions) that fails if any of the four assets go missing or
ship at the wrong size. The switch-button *rebuttal* rests on an owner decision recorded in the
session. The human at the `pr` gate is the remaining reviewer — this rebuttal + the README/review/
test edits are for that review.
