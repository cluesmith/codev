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
