# pir-1463 — Stream Deck: open the architect that spawned the selected builder

## Plan phase (2026-08-15)

Read issue #1463 in full **plus** owner comment `5300180262`, which supersedes
ruling 1: the key adopts Builder Action's **Automatic-or-explicit** shape, and
Automatic **falls back to `main`** (matching `afx send architect`) — safe only
because the face renders the resolved target's name.

### Codebase facts verified
- `OverviewBuilder.spawnedByArchitect: string | null` on the wire
  (`packages/types/src/api.ts:201`, re-exported via `@cluesmith/codev-sdk/controller`).
  No types/Tower/relay change.
- Relay allowlist has `open-architect-terminal → codev.openArchitectTerminal`
  (`apps/vscode/src/command-relay.ts:62`), args forwarded verbatim.
- `codev.openArchitectTerminal(name?)` resolves the architect list and warns
  `No '<name>' architect found` on miss (`extension.ts:873-927`) = ruling 2's
  "defer to VS Code".
- Row-2 dynamic-face precedent is `ApproveGate` / `SendQueueAction`
  (`SingletonAction` + keys-map + `store.onChange`), **not** the static-face
  `VerbKey` (`OpenTerminalAction`/`DevServerAction` render once in
  `onWillAppear`). Plan recommends the `SingletonAction` shape because this
  face must track selection; flagged for the gate since the issue said
  "VerbKey subclass".
- Icon pipeline (`scripts/render-action-icons.mjs`) renders from a `face.ts`
  glyph; `rsvg-convert` + `magick` are installed. `manifest-icons.test.ts`
  enforces every manifest action icon exists at convention sizes → new action
  needs a rendered `open-architect` glyph + 4 PNGs.

### Key decision surfaced to architect
Base class: `SingletonAction` (ApproveGate shape) vs literal `VerbKey`. Recommend
the former. Reversible.

### Dependency (not my lane)
#1406 mis-attributes builders to `main` → Automatic can summon the wrong
architect on hardware. Mitigation in-scope: the face shows the resolved target
before pressing. Stated in the plan; needs fix/confirm before ship.

Plan written to `codev/plans/1463-stream-deck-key-to-open-the-ar.md`. Awaiting
plan-approval gate.

## Plan review — approved with one revision (2026-08-15)

Architect ratified the SingletonAction decision and required one change:
**don't hardcode `'main'`**. `afx send architect` is "main if present, else the
FIRST REGISTERED". Use `OverviewData.architects[0].name` (live-only, main-first,
`[]` when none) as the last link, so it self-corrects. Added a store accessor
`firstLiveArchitect()` (no store architects reader existed). `resolve()` now
returns `string | undefined`; `undefined` → inert (ruling 3). Named-but-not-live
targets still defer to VS Code (ruling 2). Revised plan + test cases (first-live,
non-main first-live, empty→inert) and recommitted. Gate now goes to Amr.

## Plan review — final fold-in (2026-08-15, registry-side review)

Verified `liveArchitects` (`tower-routes.ts:1077-1090`): skips any architect with
no live session (`if (!session) continue`), re-sorts main-first among survivors.
So `OverviewData.architects` = "what Tower can SEE live", transiently wrong.
Three consequences folded in:
1. Empty list → **explicit `No architect` unavailable face**, not silent inert
   (reviewer would otherwise press repeatedly).
2. Missing-main → positional fallback lands on a sibling; face (resolved name) is
   the safeguard → added hardware test 6b (face must visibly show the sibling).
3. Stale-but-present (live registration behind dead PTY) → documented known
   limitation (deck can't detect), README + Risks; not fixed.
Recommitted. Requesting plan-approval gate.

## Plan reshaped at the gate — two-mode design (2026-08-15, Amr in PTY)

Owner (Amr) reworked the key interactively at the gate. Final design supersedes
both ruling 1 and the free-text `Automatic`/pin revision (5300180262):

- **Two PI modes**, `target: 'builder' | 'main'`, default `builder`.
  - Builder mode → opens `selectedBuilder().spawnedByArchitect`; inert when none.
  - Main mode → fires literal `'main'` (VS Code does main-else-first, ruling 2).
- **No positional fallback** (dropped first-live + `firstLiveArchitect()` store
  accessor — no store change now). Neither mode summons an unexpected architect.
- **Title/subtitle face**: title `Architect` (constant), subtitle = resolved
  name **first-letter-capitalized** (deck-local `capitalizeFirst`, NOT VS Code's
  uppercase `displayArchitectName`). Inert → dim, subtitle `None`. Names are
  lowercase `[a-z][a-z0-9-]*` on the wire.
- **Codev Action**: keep its `open-architect-terminal` entry as the generic
  manual-picker escape hatch (owner ruled keep). No `codev-action.html` change.
- #1406 still a stated prereq; the visible owner name makes a mis-attribution
  noticeable but can't correct it.

Rewrote the plan to this. Re-requesting plan-approval.

## Implement phase complete (2026-08-15)

plan-approval approved by Amr (relayed via porch by architect). Implemented:
- `face.ts`: `architect` person glyph, `capitalizeFirst`, `architectFaceSvg(name|undefined)`
  (title `Architect` / subtitle name; dim `None` when inert). primaryLine/secondaryLine
  got an optional color param for the dim state.
- `actions.ts`: `OpenArchitectAction` (SingletonAction + keys-map + onChange). Modes
  `builder` (default → selectedBuilder.spawnedByArchitect, inert when none) / `main`
  (fires literal 'main'). Registered in `plugin.ts`.
- Manifest action + `ui/open-architect.html` (target select). Dedicated icon via the
  render pipeline (added `architect` to ICONS; ran the script).
- README: key docs, modes, known edges, Row-1 placement caveat (#1465).
- Tests: face (capitalizeFirst + architectFaceSvg), actions (both modes, inert x2,
  main, relay-reject, dynamic face), manifest-icons sizes, render extractGlyph.

Gotcha: the render script regenerates ALL ICONS/BRAND_ICONS, so it dirtied the
pre-existing send-queue/open-terminal/action PNGs (byte churn); restored those 12 to
committed, kept only the 4 new open-architect PNGs. Glyph line must carry NO trailing
comment (the extractor regex rejects it).

Verified from worktree: build ✓, check-types (tsc) ✓, vitest 197/197 ✓, streamdeck
validate ✓. Pushed. dev-approval is a hardware session — requesting the gate.

## Gate-time refinement: symmetric terminal-key rename (2026-08-15)

At Amr's direction, renamed the two terminal keys as a PAIR: existing
`Open Terminal` → `Open Builder Terminal` (face `Terminal`→`Builder`, terminal
glyph kept) and the new key → `Open Architect Terminal`. UUIDs UNCHANGED
(`open-terminal`, `open-architect`) so already-placed keys survive; only Name +
Tooltip + face label moved. Terminal-vs-person glyphs stay the visual
differentiator. Updated manifest, actions.ts (+doc), README (incl. ASCII cell),
OpenTerminal face test. build/tsc/vitest 197/validate ✓. Architect verified +
approved the scope expansion (feature created the ambiguity, so resolve in-lane).
Added dev-approval hardware check #8: an already-placed Open Terminal key must
survive the rename (still opens the builder terminal, now reads `Builder`) —
proves UUID stability on hardware. dev-approval remains Amr's.

## Row-1 windowing question + follow-up #1465 (2026-08-15)

Amr asked about Row-1 slot selection and placing the Main-mode key on a Row-1
key. Traced it: ZoomNav dial steps the selection ±1 across the fleet;
`windowedBuilder` shows the page of `ROW1_WINDOW_SIZE=4` containing the
selection. The 4 is a fixed constant, independent of placed BuilderAction keys —
so 3 placed keys hide every 4th builder at 4+ fleet (a selectable-but-invisible
ambiguous state). Verified the Elgato SDK (@2.1.0): NO profile-structure API
(profiles.d.ts: plugins "cannot access user-defined profiles"), but willAppear
carries KeyAction.coordinates + streamDeck.devices gives Device.size — so a
self-sizing window is derivable from the lifecycle. Architect filed that as a
SEPARATE issue **#1465** (reframed to lead with the correctness bug), credited to
me. 1463 stays as-is; added a one-line Row-1 placement caveat + #1465 pointer to
the plan's README-guidance section (documentation, not a fold-in). Architect
endorsed the reshape and the Main-mode residual wording. Gate still pending (Amr).
