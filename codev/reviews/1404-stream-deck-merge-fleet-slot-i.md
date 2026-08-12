# PIR Review: Merge Fleet Slot into Builder Action (phase-aware press)

Fixes #1404

## Summary

The Stream Deck plugin had two near-identical keys per builder — Fleet Slot (live status tile, default press `open-terminal`) and Builder Action (default press `view-diff`). This merges them into a single **Builder Action**: it renders the live tile (issue + phase/blocked) and its new default **Automatic** press opens the artifact for the builder's current phase (spec → plan → diff, terminal as fallback), re-openable on every press, and also selects the builder so the diff dials follow. Fleet Slot is removed from the manifest, PI, icons, and the bundled SD+ profile. One key per builder now covers what that builder needs; approval stays on the separate Approve Gate key.

## Files Changed

- `apps/streamdeck/src/actions.ts` (+65 / -~25) — extract `phaseArtifactVerb`; `zoomInVerb` wraps it; `BuilderAction` gets Automatic resolution, two-line render, press-selects; `FleetSlot` deleted
- `apps/streamdeck/src/plugin.ts` (-2) — drop `FleetSlot` import + registration
- `apps/streamdeck/src/__tests__/actions.test.ts` (+78) — `phaseArtifactVerb` suite, Automatic/explicit/fallback/select tests, slot tests moved to `BuilderAction`
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (18) — remove `fleet-slot` action, truthful `builder-action` tooltip
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/builder-action.html` (11) — Automatic option (default, first), "On press" relabel, helper text
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/ui/fleet-slot.html` (-36) — deleted
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile` (bin) — 3 fleet-slot keys → builder-action Automatic (slots preserved)
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/icons/fleet-slot*.png`, `icons/list/fleet-slot*.png` (bin) — deleted (unreferenced)
- `apps/streamdeck/README.md` (24), `apps/streamdeck/marketplace/release-notes.md` (3) — fold Fleet Slot into Builder Action

## Commits

- `c231e8fe7` [PIR #1404] Merge Fleet Slot into Builder Action: Automatic phase-aware press + select
- `4106b8ade` [PIR #1404] Plugin assets: builder-action tooltip + PI Automatic default, SD+ profile rev
- `05996921a` [PIR #1404] Docs: fold Fleet Slot into Builder Action (README, release notes); builder thread

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck build`: ✓ pass (esbuild)
- `pnpm exec tsc --noEmit`: ✓ pass (esbuild does not typecheck, so this is run separately)
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ pass — 72 tests, ~10 new/changed (`phaseArtifactVerb`, Automatic press, fallback, select, two-line render)
- Manual verification (human, dev-approval gate): plugin sideloaded from the worktree (`streamdeck link` + `streamdeck list` confirms the pir-1404 path), revved profile imported; Automatic press opens the phase artifact across builder states. **Note:** a repeated-firing observation surfaced during this session — see "Things to Look At".

## Architecture Updates

No arch changes. This is a Stream Deck plugin change (`apps/streamdeck`) that consolidates two UI actions into one; it touches no system-shape invariant (framework resolution, Tower state, server/client isolation, gates). The phase→verb resolver and press-selects behavior are module-internal to the plugin, not a cross-cutting boundary. `codev-skeleton/` is unaffected — the plugin is our product, not template content shipped to adopters, so no dual-tree mirror is required.

## Lessons Learned Updates

No new cross-cutting lesson warranting a hot/cold governance-doc edit. Two spec-narrow notes, kept here rather than promoted:

- **Reuse over duplication (already-encoded lesson):** the issue's own note directed reusing the existing `zoomInVerb` phase→verb mapping rather than writing a second one. Extracting `phaseArtifactVerb` (recognised verb or `undefined`, each caller supplying its fallback) preserved `zoomInVerb`'s behaviour exactly (its tests are unchanged) while giving Automatic its distinct `open-terminal` fallback. This is the existing "single source of truth / extract shared resolver" lesson in practice.
- **Fresh builder worktree needs a dependency build:** this worktree had no linked/built workspace packages, so the app build failed resolving `@cluesmith/codev-sdk/*` until `pnpm install` + building the chain (`codev-types` → `codev-sdk`) first. Environmental, not a durable framework rule.

## Things to Look At During PR Review

- **Profile rev (hand-edited zip).** `Codev.streamDeckProfile` is a zip; its inner manifest was edited programmatically (3 `fleet-slot` keys → `builder-action`, verbs dropped for Automatic, slots and cached `Name` updated) and re-zipped. Verified statically: integrity OK, 0 `fleet-slot` refs, 4 `builder-action` refs, 11 files preserved. The human confirmed import on hardware at dev-approval.
- **The one behavioral fork between callers.** `phaseArtifactVerb` returns `undefined` for unknown/no-status builders; `zoomInVerb` falls back to `view-diff` (a dial always has an editor), Builder Action Automatic falls back to `open-terminal`. Covered by tests, but the asymmetry is intentional and worth a glance.
- **Repeated-firing observation (open, likely NOT this PR).** During hardware testing the human saw the Automatic verb (e.g. `open-plan`) re-fire every few seconds. Traced statically end-to-end: the deck sends exactly one command per tap (every `sendCommand` is in an input handler; the six `onChange` subscriptions only re-render), the Tower relay broadcasts once per POST (`command-relay.ts:105`, stateless), `broadcastNotification` writes once (30s heartbeat only; command events are not replayed on reconnect — that buffer is terminal-only, #1047), and the VSCode relay is wired once and focus-gated. `streamdeck list` showed a single link. Every layer resolves to "once", so this points to a runtime reconnect / multi-window / delivery effect independent of the merge — the prior default (`view-diff`) would have masked it (re-focusing a diff looks benign) where `open-plan` re-opening a document is loud. Decisive test pending: quit the Stream Deck app and observe whether it continues. Flagged to the architect; if confirmed it is a separate delivery-loop bug, not part of #1404.

## How to Test Locally

For reviewers pulling the branch:

- **Sideload** (from the worktree root): `pnpm --filter @cluesmith/codev-streamdeck build`, then `streamdeck unlink com.cluesmith.codev` / `streamdeck link "$PWD/apps/streamdeck/com.cluesmith.codev.sdPlugin"` / `streamdeck restart com.cluesmith.codev`; confirm with `streamdeck list` (path under `.builders/pir-1404`). Import `Codev.streamDeckProfile` separately.
- **View diff**: VSCode sidebar → right-click builder pir-1404 → **Review Diff**.
- **What to verify** (maps to the plan's Test Plan; needs Tower + an active workspace with builders):
  - Builder Action renders `#issue` + phase/blocked on two lines; no "Fleet Slot" action in the picker.
  - PI "On press" defaults to **Automatic** (first option).
  - Automatic press: specify/spec-approval → spec, plan/plan-approval → plan, implement/review/dev-approval/pr → diff, no-status → terminal; press again re-opens.
  - Pressing a key selects the builder (rotate a Files/Changes dial → it acts on the pressed builder).
  - An explicit verb in the PI fires verbatim regardless of phase; the key never approves a gate.
  - Imported profile: the 3 former Fleet Slot keys appear as Builder Action / Automatic (slots 1, default, 3), no blank/unknown keys.

## Follow-ups

- **#1410** — SD+ two-zone builder workflow (Row 1 selectors + Row 2 action palette; dial queue/send following a VSCode setting). This PR's merged key is its Row 1 selector foundation.
- **#1414** — Automatic's diff branch should open the builder's **first file** (dial-ready per-file) rather than `view-diff`'s aggregate editor. Needs a vscode-side builder-id-scoped open-first-file verb (`diff-first-file` ignores the builder-id arg, `diff-nav.ts:118`); the verify-first check was folded into this dev-approval hardware session.
