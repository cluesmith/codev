# PIR Plan: `composer-open-or-submit` — one context-aware canvas command

## Scope of this lane

This project is the **bridge-extension half** of the agreed cross-lane split (main + streamdeck
architects, recorded on issue #1420):

- **In scope** — requirement 1 (new `composer-open-or-submit` command, resolved **canvas-side**
  from `composingLine`, which never discards a draft) and requirement 2 (add it to the closed
  `CanvasCommand` union in `packages/types`, the host allowlist, and the canvas action map).
- **Out of scope, streamdeck's follow-on lane** — requirement 3 (deck dial remapping in
  `apps/streamdeck/.../actions.ts`) and requirement 4 (touchstrip legibility). Those sequence
  **after** this command merges, mirroring the #1401 → #1400 pattern.
- Requirement 5 stands: submit/cancel only, no text entry.

Nothing in `apps/streamdeck/` changes here. The deck stays stateless; the canvas owns composer
state.

## Understanding

In canvas/review mode a controller (the Stream Deck) drives an open artifact-canvas view over
Tower's `sendCanvasCommand` bridge (#1401). Today it can `composer-open` at the focused block, but
committing the comment still needs the keyboard (`Cmd+Enter` submit / `Esc` cancel), which breaks
the hands-free dictation flow.

The controller cannot own the open-vs-submit decision: the bridge result carries only
`{ok, target}`, so the deck never learns composer state back. A deck that *guessed* the state would
desync the moment the composer is submitted/cancelled via the keyboard, and a wrong guess is not
harmless — `composer-open` re-anchors the composer and unmounts the in-progress draft
(`ArtifactCanvas.tsx` `openComposer` → `setComposingLine`), so a mis-fire discards a dictated
comment.

Only the **canvas** knows whether a composer is open — it tracks `composingLine`
(`ArtifactCanvas.tsx:246`). So the fix is a single context-aware command the canvas resolves against
its own state.

### Why the empty-draft ruling is already satisfied

The deck-stakeholder ruling requires that a press on an **open but empty** composer must NOT submit
an empty comment and must NOT discard the draft. The existing composer already delivers this:
`CommentComposer.submit()` trims and returns early on an empty body
(`CommentComposer.tsx:72-76`), leaving the composer mounted with its draft intact. Routing the
"open" case through `submit()` therefore inherits the guard for free — no empty comment is written,
and nothing re-anchors the composer.

### Why reading `composingLine` in the action is correct

`canvasActions` is rebuilt on every render and `runCanvasCommandRef.current` is refreshed on every
render (`ArtifactCanvas.tsx:996-1001`), so an action body reads that render's `composingLine`. The
existing `composer-cancel` action already reads `composingLine` directly
(`ArtifactCanvas.tsx:948-950`); the new command follows the identical, proven pattern.

## Proposed Change

Add **one** new command, `composer-open-or-submit`, to the closed `CanvasCommand` vocabulary and
resolve it canvas-side:

- **Composer closed (`composingLine === null`)** → open at the focused block (the exact
  `composer-open` guard: `originLine` present and numeric, then `openComposer(line)`).
- **Composer open (`composingLine !== null`)** → `composerHandleRef.current?.submit()`. A non-empty
  draft submits; an empty draft is a no-op that leaves the composer and its draft untouched.

The command is remote-only (no key binding), exactly like `block-next`/`block-prev`, so the keyboard
path is unchanged. It is a `NonTraversalCommand` automatically (excluded from `TraversalCommand`),
so `count` is rejected on it by the existing relay and host validation — no wiring needed.

Failure verdicts need no new channel: the command travels the existing relay + SSE path, so failures
stay inside the closed `CanvasCommandClientErrorCode` union (`no-canvas` / `invalid-request` /
`unreachable`) the dial already renders.

## Files to Change

The union is guarded by `satisfies readonly CanvasCommand[]` / `satisfies Record<CanvasCommand, …>`
assertions in **four** independent locations, so adding the union member without updating each is a
compile error. **Note: the issue's requirement 2 lists only three of these; the fourth
(`canvas-relay.ts`, Tower's own relay validation) is required too — without it Tower answers
`invalid-request` and the command never reaches the canvas.**

1. `packages/types/src/canvas-command.ts:44-49` — add `| 'composer-open-or-submit'` under the
   `// Composer.` group, and extend the type doc-comment to describe the context-aware resolution.
   (No `TraversalCommand` change — it lands in `NonTraversalCommand` automatically.)
2. `packages/types/type-tests/canvas-command.type-test.ts:48-52` — add
   `'composer-open-or-submit': 'non-traversal'` to the `CLASSIFICATION` map (the `satisfies
   Record<CanvasCommand, …>` fails to compile otherwise).
3. `packages/codev/src/agent-farm/servers/canvas-relay.ts:68-83` — add `'composer-open-or-submit'`
   to Tower's `CANVAS_COMMANDS` relay allowlist.
4. `apps/vscode/src/markdown-preview/canvas-view-registry.ts:34-49` — add `'composer-open-or-submit'`
   to the host `CANVAS_COMMANDS` allowlist.
5. `packages/artifact-canvas/src/components/ArtifactCanvas.tsx:920-952` — add the
   `'composer-open-or-submit'` entry to the `canvasActions` map:

   ```ts
   // Context-aware composer control (#1420): the canvas — the only party that knows whether a
   // composer is open — decides. Closed → open at the focused block; open → submit the draft
   // (an empty draft is CommentComposer's own no-op, so this never writes an empty comment and
   // never re-anchors/discards the draft). Reads composingLine like composer-cancel does; the
   // action map is rebuilt each render, so the read is current.
   'composer-open-or-submit': ({ originLine }) => {
     if (composingLine !== null) {
       composerHandleRef.current?.submit();
       return;
     }
     if (originLine === null) return;
     const line = Number(originLine);
     if (Number.isNaN(line)) return;
     openComposer(line);
   },
   ```

Optional doc touch-up (no behavior): `packages/artifact-canvas/src/adapters/CommandAdapter.ts:27`
mentions `composer-open`/`composer-submit` in prose; I will leave it unless review wants it noted.

## Command semantics — for streamdeck-architect review before the plan gate

Per the agreed process, this section routes to the streamdeck architect before `plan-approval`.
Exact behavior per composer state:

| Composer state | `composer-open-or-submit` does | Draft safety |
|---|---|---|
| Closed | Opens the inline composer at the focused block | n/a |
| Open, non-empty draft | Submits the draft (`onAddComment` / edit path) | Committed |
| Open, empty/whitespace draft | No-op; composer stays open, draft preserved | **Never** written, **never** discarded |
| No focused block resolvable (closed case) | No-op | n/a |

Rulings honored: (1) closed → open, open+content → submit; (2) empty-draft press never submits and
never discards; (3) failures stay in the existing closed `CanvasCommandClientErrorCode` union — no
new error channel; (4) `composer-cancel` is reused unchanged (the coarse-dial mapping lands in the
streamdeck lane).

## Risks & Alternatives Considered

- **Risk — the fourth allowlist is missed and the command silently 400s.** Mitigated: all four
  enumerations carry a `satisfies` + `Assert`/`AssertTrue` guard, so a missing update fails the
  build, not production. The file list above names all four explicitly.
- **Risk — stale `composingLine` closure resolves the branch wrong.** Mitigated: proven not stale —
  `canvasActions` and `runCanvasCommandRef.current` are rebuilt every render and `composer-cancel`
  already relies on this; a test asserts open→submit and closed→open on one control.
- **Alternative — deck remembers it sent `composer-open` and sends `composer-submit` itself.**
  Rejected in the issue's design constraint: the deck never learns composer state back, so a guess
  desyncs on any keyboard/self-close and a wrong `composer-open` re-fire discards the draft.
- **Alternative — name `composer-toggle`.** Rejected: "toggle" implies open↔close symmetry; this is
  open→**submit**, and cancel is a separate command. `composer-open-or-submit` names the two real
  outcomes.
- **Alternative — make the empty-open case cancel instead of no-op.** Rejected: cancel discards the
  (empty) composer the reviewer just opened to dictate into; a no-op that leaves it open is the safe
  reading of the ruling and matches the keyboard, where `Cmd+Enter` on an empty draft also does
  nothing.

## Test Plan

- **Unit (`packages/artifact-canvas/src/__tests__/remote-commands.test.tsx`)** — extend the existing
  remote-command suite (harness at line 246+):
  - Closed composer: `composer-open-or-submit` opens the composer at the focused block.
  - Open composer with typed draft, focus parked outside: `composer-open-or-submit` submits — one
    control opened then committed (`onAddComment` called once with the draft).
  - Open composer with **empty** draft: `composer-open-or-submit` writes nothing **and** the
    composer stays mounted (draft not discarded, no re-anchor).
- **Relay (`packages/codev/src/agent-farm/__tests__/canvas-relay.test.ts`)** — the new command
  round-trips through `/api/canvas/command` (accepted, not `invalid-request`); and it rejects a
  `count` (add it to the non-traversal list at line 288-292).
- **Type-tests** — `packages/types/type-tests/canvas-command.type-test.ts` compiles with the new
  classification entry; the four `satisfies` guards compile.
- **Build/lint** — `pnpm -w build` and the package test suites from the worktree.
- **Manual (dev-approval gate, in the worktree)** — with a canvas view open and Tower running, drive
  `composer-open-or-submit` via `sendCanvasCommand` (curl to `/api/canvas/command` or the sdk):
  first press opens the composer at the focused block; type a comment; second press submits it;
  confirm a keyboard `Esc` between presses is handled correctly (next press re-opens rather than
  submitting a discarded draft). Deck hardware verification of the dial mapping itself is the
  streamdeck follow-on lane, not this gate.
- **Cross-platform** — n/a (VS Code extension host + web canvas only; no mobile).

## Follow-on (not this lane)

`apps/streamdeck/src/actions.ts:605` currently sends `composer-open` on the review-dial press. The
remap (fine dial → `composer-open-or-submit`, coarse dial → `composer-cancel`) and touchstrip
legibility land in streamdeck's lane after this command merges, coordinated with #1410's layout
work.
