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
