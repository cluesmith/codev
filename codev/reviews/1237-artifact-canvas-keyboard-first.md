# PIR Review: artifact-canvas batch — keyboard-first navigation, '+' affordance hover fix, arrow cursor

Fixes #1232, Fixes #1236, Fixes #1237

## Summary

One PR covering the architect-directed artifact-canvas batch. The '+' add-comment affordance no longer vanishes while the mouse travels toward it (a 200ms grace timer absorbs both the mouseleave dismiss and the block-crossing re-anchor, and the overlay pins while the pointer is on it) and now sizes against the prose with a 24×24px hit target (#1236). The read-only content body shows the arrow cursor uniformly, code blocks included (#1232). The review loop became keyboard-first: jump keys (`n`/`p` commented blocks, `]`/`[` headings, `Home`/`End`), focus restoration across the post-write body rebuild (submit/delete no longer strand focus at the document root), minimap dots that hand focus to their target block, and a `?`-toggled keys legend (#1237).

## Files Changed

Versus the merge-base with `main` (excluding porch state and the plan/thread artifacts):

- `packages/artifact-canvas/src/components/ArtifactCanvas.tsx` (+235 / −17) — hover grace/pin machine, jump keys, focus restoration
- `packages/artifact-canvas/src/overlays/KeyboardHelp.tsx` (+33 / −0) — new keys legend panel
- `packages/artifact-canvas/src/overlays/MarkerMinimap.tsx` (+6 / −1) — dot activation focuses the target block
- `packages/artifact-canvas/src/styles/default-theme.css` (+51 / −2) — cursor rule, affordance sizing, legend styles
- `packages/artifact-canvas/src/components/__tests__/hover-affordance.test.tsx` (+125 / −0) — new
- `packages/artifact-canvas/src/components/__tests__/keyboard-nav.test.tsx` (+234 / −0) — new
- `packages/artifact-canvas/src/overlays/__tests__/marker-minimap.test.tsx` (+12 / −2)
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts` (+15 / −0)
- `codev/plans/1237-artifact-canvas-keyboard-first.md`, `codev/state/pir-1237_thread.md`, `codev/resources/lessons-learned.md` — protocol artifacts + lessons routing

## Commits

- `83a54648` [PIR #1237] Plan draft (batch: #1236, #1232, #1237)
- `031f13d7` [PIR #1237] #1236 hover grace+pin and 24px affordance sizing; #1232 arrow cursor over content
- `9d5b2dcd` [PIR #1237] Jump keys, focus restoration, minimap focus handoff, keys legend; tests for all three issues
- `07864a48` [PIR #1237] Thread: record full-row affordance scope decision (architect: option a)

(plus porch's own gate/phase state commits)

## Test Results

- `pnpm --filter @cluesmith/codev-artifact-canvas build`: ✓ pass
- `pnpm --filter @cluesmith/codev-artifact-canvas test`: ✓ pass — 93 tests across 12 files, ~18 new (fake-timer hover-grace machine; jump keys incl. nested-list dedupe and composer guard; Esc/submit/delete focus restoration incl. the vanished-line fallback; minimap focus handoff; `?` legend; CSS rule assertions)
- Manual verification at the `dev-approval` gate: the human reviewer exercised the running worktree, confirmed the keyboard loop, and probed the hover model's edges — which surfaced the inert-zone finding below (resolved by architect scope decision, not a code change).

## Architecture Updates

No arch changes — the batch is interaction behavior internal to the `@cluesmith/codev-artifact-canvas` component (hover state machine, keyboard handling, CSS). No module boundaries, state stores, ports, or cross-package contracts changed; the package's D2/D5/D6 adapter contracts and the #863 overlay anchoring model are unchanged in shape.

## Lessons Learned Updates

Two entries routed to the COLD tier (`codev/resources/lessons-learned.md`, UI/UX section — spec-narrow recipes, not cross-cutting rules, so no HOT displacement):

1. The hover-overlay "travel gap" class: why absolutely-positioned affordances anchored away from the pointer's element vanish en route, the grace+pin damping pattern (keyboard path stays instant), and that the structural fix is the full-row hover target — with the at-gate-discovered inert zones recorded so the follow-up inherits them.
2. Focus restoration across write → watch-reload → imperative DOM rebuilds: record the logical anchor (source line) in a ref before emitting the intent, consume it in the decoration effect, nearest-preceding fallback for shifted lines.

## Things to Look At During PR Review

- **The grace machine's edge cases** (`ArtifactCanvas.tsx`, `activateFromHover`/`scheduleDismiss`): one shared timer covers dismiss and re-anchor — a fresh hover, focus move, or overlay-enter cancels it. The stale-pin escape hatch (overlay unmounted under the pointer without a mouseleave: pin is ignored when no overlay is up, and reset in `openComposer`) is the trickiest branch; it's what keeps the machine from wedging after a click on '+'.
- **Focus restoration consumes inside the decoration effect** — it runs on `html`/`markers` changes, which is exactly when the reload lands; if the host never writes (rejected intent), the pending ref is simply consumed by the next rebuild, which is harmless but worth knowing.
- **Scope decision at the dev-approval gate**: reviewer testing found the gutter-anchored model's inert zones (webview page padding, block margins) and the far-anchor effect (right-side hover on a tall block shows the '+' at the block's first line, far left). Architect ruled option (a): ship grace+pin as scoped; the structural GitHub-style full-row affordance is a separate architect-filed follow-up with its own plan gate, inheriting those scenarios as test cases. This PR deliberately does not attempt it.
- The 3-way consultation verdicts (single advisory pass) land in `codev/projects/1237-*/` — see the architect notification for dispositions if any returned REQUEST_CHANGES.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1237` → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1237`; package playground: `pnpm --filter @cluesmith/codev-artifact-canvas dev:example` from the worktree
- **What to verify** (maps to the plan's Test Plan):
  - Diagonal mouse travel from mid-paragraph to the '+' — no vanish, no jump; a brief overshoot past the left edge survives the 200ms grace
  - '+' size proportionate to 16px prose in a VS Code webview (13px host default)
  - Arrow cursor over prose, headings, and code blocks; pointer hand on links; the five pre-existing cursor spots unchanged
  - Keyboard-only pass: Tab in → `]`/`[` between headings → `n`/`p` between commented blocks → Enter → type → ⌘/Ctrl+Enter → focus returns to the block → delete via card action → focus returns to the block → `?` toggles the legend, Esc closes it
