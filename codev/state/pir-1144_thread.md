# Builder thread — pir-1144 (vscode IDE-mode foundation)

## 2026-07-07 — Plan phase

- Read issue #1144 + its two comments. Key context deltas from the fork side: Part 3 is the IDE's ONLY first-run UX (core onboarding removed in the fork), and nothing first-launch-visible may ride on `configurationDefaults` (async registration races first render) — all runtime code.
- Architect instruction received mid-investigation: the fork rebrand has NOT landed; the exact `product.json` `nameLong` ('Codev' vs 'Codev IDE') is still being confirmed. Plan single-sources the string as `CODEV_IDE_APP_NAME` in a new `src/ide-mode.ts` so a differing confirmed value is a one-line edit. Flagged as pending in the plan.
- Investigation findings:
  - Part 1 root cause confirmed: `views/workspace.ts` `getChildren` builds Architects/Spawn/Shell rows unconditionally; no view in `contributes.views` gates on workspace presence. Data views (Agents/Backlog/PRs/Recently Closed) already render empty on null cache data; Status renders rows unconditionally.
  - The inertness risk for Part 2 is real: `connectionManager.initialize()` (extension.ts:1308) auto-starts Tower even with `detectWorkspacePath() === null`. Full side-effect inventory in the plan: initialize(), runPreflight (walkthrough focus steal), one-time panel reveal, statusBarItem.show(), workspaceState/globalState writes. Constructors are inert.
- Plan written to `codev/plans/1144-vscode-ide-mode-foundation-dua.md`: activation-tier model (full / ide-empty / dormant) computed from `detectIdeMode` + `detectWorkspacePath`, a pure `activationPolicy(tier)` so the quadrant matrix is unit-provable, `codev.hasWorkspace` + `codev.ideMode` context keys, view-level `when` gating + `viewsWelcome` per quadrant, dev seam `CODEV_SIMULATE_IDE=1` honored only in ExtensionMode.Development.
- Sitting at `plan-approval` gate.

## 2026-07-07 — Implement phase

- `plan-approval` approved; implemented per plan with no deviations:
  - New `packages/vscode/src/ide-mode.ts`: `CODEV_IDE_APP_NAME` (single-sourced contract constant, still pending fork confirmation of 'Codev' vs 'Codev IDE'), `detectIdeMode` (exact match + `CODEV_SIMULATE_IDE=1` seam gated to ExtensionMode.Development), `decideActivationTier` (full / ide-empty / dormant), `activationPolicy` (the side-effect switchboard).
  - `extension.ts`: tier computed first-thing in `activate()`; `codev.ideMode` + `codev.hasWorkspace` context keys (latter live on folder changes); gated the five side effects (initialize/Tower auto-start, preflight, one-time panel reveal, status bar show, workspaceState cleanup writes); IDE empty-window surface (container focus + one-time first-run notification + walkthrough via the preflight's once-gate); registered palette-hidden `codev.openGettingStarted`.
  - `package.json`: `onStartupFinished` added (both `workspaceContains` kept); `when` gates on Workspace/Backlog/PRs/Recently Closed (+`codev.hasWorkspace`), Team (`&& codev.hasWorkspace`), Status (`codev.hasWorkspace || codev.ideMode`); new `viewsWelcome` with the two no-workspace quadrants on `codev.agents`.
  - `preflight.ts`: exported `openWalkthrough` / `maybeOpenWalkthrough`.
- Build note for siblings: fresh worktree needed `pnpm --filter @cluesmith/codev-types --filter @cluesmith/codev-core --filter @cluesmith/codev-artifact-canvas build` before `pnpm compile` in packages/vscode would pass (TS2307 on workspace dists).
- Verified: `pnpm compile` ✓ (check-types + lint + esbuild), `pnpm test:unit` ✓ 570/570 (24 new across `ide-mode.test.ts` + `contributes-view-gating.test.ts`).
- Sitting at `dev-approval` gate.

## 2026-07-07 — dev-approval feedback iterations

1. **Pre-activation welcome flash** (user observed "Open a folder to use Codev" for ~2s inside a codev workspace): unset context keys evaluate false, so the guest-quadrant viewsWelcome matched during the workbench-restore → activation gap. Fix: third context key `codev.stateKnown` set at top of activate(); both welcome quadrants now require it. (`c18f3a01`)
2. **Raw "no data provider" message** during the same gap: replaced with a `"Loading Codev…"` viewsWelcome entry on `when: "!codev.stateKnown"` (welcome content also renders pre-provider-registration). (`3a4b2e51`)
3. **Ancestor-walk leak** (user screenshot: full Workspace view in a non-codev project): `findProjectRoot` walked up to filesystem root and matched the user's codev-enabled HOME (`~/codev` + `~/.codev` both exist), so every window under home computed tier=full and connected Tower. Agreed deviation from plan (Option A, chosen over a git-boundary-bounded walk): detection is now "the opened folder itself contains `codev/` or `.codev/`", no walk; `codev.workspacePath` setting remains the escape hatch for layouts with the marker above the opened folder. Subfolder-of-repo windows go dormant by design; worktrees unaffected (they carry their own `codev/`). Matches CLI semantics (afx runs from workspace root). Regression test added (`workspace-detector.test.ts`).
