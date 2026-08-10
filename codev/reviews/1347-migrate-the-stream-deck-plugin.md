# PIR Review: Migrate the Stream Deck plugin into the monorepo as `apps/streamdeck`

Fixes #1347

## Summary

The Stream Deck plugin moved from the `codev-integrations` repo into this monorepo as
`apps/streamdeck`, becoming `@cluesmith/codev-sdk`'s first consumer outside the original in-repo
trio (issue #1189's absorption plan). The migration replaced every `@cluesmith/codev-client` import
with sdk subpaths (`controller`, `node`), with one behavioral change: auth is now an explicit
`getAuthKey: readLocalKey` injection instead of the old client's implicit local-key read. CI gained
streamdeck steps in the unit job plus a manual-only published-SDK canary workflow (the
external-fidelity check that replaces the dogfooding lost by moving in-repo). During the
dev-approval gate's live-hardware review, the owner directed three scope additions, all landed
here: Marketplace-compliant icons per Elgato's guidelines, watermark removal from key faces, and
workspace version lockstep (3.3.0).

## Files Changed

Icon assets summarized; full stat is `git diff --stat $(git merge-base main HEAD)`.

- `apps/streamdeck/src/` — plugin.ts (+70), store.ts (+207), actions.ts (+540), nav/cursor.ts (+90)
- `apps/streamdeck/src/__tests__/` — actions.test.ts (+381), cursor.test.ts (+69), import-boundary.test.ts (+81, new), version-sync.test.ts (+26, new)
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/` — manifest.json (+139), layouts (+48), PI ui (+98), icons (59 files: key faces, white list/category set, 256/512 plugin tile)
- `apps/streamdeck/` — package.json, tsconfig.json, vitest.config.ts, esbuild.js, README.md (+200), .gitignore
- `.github/workflows/test.yml` (+14) — streamdeck steps in the unit job
- `.github/workflows/sdk-canary.yml` (+57, new) — manual-only published-SDK canary
- `codev/plans/1347-migrate-the-stream-deck-plugin.md` (+228), `codev/state/pir-1347_thread.md` (+54)
- `codev/resources/arch.md` (+6), `codev/resources/lessons-learned.md` (+3)
- `pnpm-lock.yaml` (+549/−2) — elgato toolchain (+49 packages)

## Commits

- `39232c390` Import Stream Deck plugin verbatim from cluesmith/codev-integrations@77be3d0
- `b5125be02` Migrate imports: codev-client → codev-sdk subpaths
- `6332687a5` Workspace wiring: sdk dep, catalog TS, tsconfig base path, README
- `3e1d50c8a` Add import-boundary guard; complete TowerWorkspace test fixtures
- `c0898643e` CI: streamdeck steps in unit job + manual-only published-SDK canary
- `a7d531c2c` Marketplace-compliant icons per Elgato guidelines *(gate-directed)*
- `6e3ceca12` / `e2422c020` / `d938bc422` Plugin icon: full-bleed tile → white-on-black; SVG source updated *(gate-directed)*
- `894babf86` Remove watermark from key faces *(gate-directed — it overlapped rendered key titles)*
- `1a4b82026` Version: join the workspace lockstep (3.3.0)

The verbatim import commit is the documented history boundary: byte-for-byte copy of the old
repo's 55 tracked files, `cmp`-verified against `codev-integrations@77be3d0`; pre-migration
history (2 commits) lives in that repo, pointed to from the README's History section. All
migration edits sit on top as reviewable diffs: `git diff 39232c390..HEAD -- apps/streamdeck`.

## Test Results

- `pnpm --filter @cluesmith/codev-streamdeck check-types && build && validate`: ✓ (bundle 634 kb; `streamdeck validate` confirmed headless-capable, so the linux-CI risk flagged in the plan didn't materialize)
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ 51/51 across 4 files (2 migrated verbatim; import-boundary + version-sync new)
- Workspace-wide: `pnpm -r check-types` ✓; all package suites ✓ after standard build prereqs (sdk/core/codev builds + copy-skeleton — same ordering CI uses). Not run: `apps/vscode`'s `vscode-test` Electron harness (no downloaded VS Code binary here; CI runs `test:unit`, which passes 643/643).
- Manual (dev-approval gate, live Stream Deck + Tower, 2026-08-10): online badge/auth via injected local key ✓; SSE refresh ✓; follow-focus deep links verified live in both directions with log monitoring ✓; icon rendering on hardware ✓.

## Architecture Updates

Routed COLD → `codev/resources/arch.md` (this commit): `apps/streamdeck` row in the Monorepo
Structure table, a dependency-graph entry (imports sdk only; own import-boundary test), and a
**Published-SDK canary** paragraph documenting `sdk-canary.yml` and its enable-after-first-publish
condition. Nothing hot-tier: the #1189 isolation invariant already covers the boundary story, and
this migration adds no new cross-cutting constraint.

## Lessons Learned Updates

Routed COLD → `codev/resources/lessons-learned.md` (this commit):

- **Process**: PIR's dev-approval gate earns its cost on device-facing surfaces — the live pass caught Marketplace icon-spec violations, a watermark colliding with runtime-rendered key titles, and a stale extension host breaking follow-focus; none visible to automated checks.
- **Debugging**: verify image transforms numerically (channel means), never visually — white-on-transparent renders invisibly on light grounds, and IM7's `-channel`+`-colorize` produced silently broken output.

An observed corroboration of the existing #1150 lesson (tail-piping verification output hides
which package failed) — no duplicate entry added.

## Things to Look At During PR Review

- **The one behavioral change**: `plugin.ts` constructs `TowerClient({ getAuthKey: readLocalKey })`; the old client read the key implicitly. Verified live (badge online ⇒ auth header worked).
- **Icon pipeline**: key faces keep color (spec-allowed); list/category icons are new white-monochrome derivations; plugin icon is a 256/512 white-on-black tile rendered from the updated `plugin.svg`. Watermark removal repainted bottom-left regions to each tile's background — glyphs verified intact via montage inspection.
- **Version lockstep**: `scripts/bump-all.sh` now bumps `apps/streamdeck/package.json` and the Elgato manifest's four-part `Version` (`<version>.0`) alongside the other workspace packages, skipping pre-releases (Elgato's manifest is numeric-only, mirroring the vscode constraint). `version-sync.test.ts` remains the guard against the pair drifting through manual edits. (The consultation caught that this review originally claimed the test would fail loudly at release — in fact `bump-all.sh` covered neither file, so drift would have been silent; fixed by extending the script.)
- **Canary caveat**: `sdk-canary.yml` is dispatch-only; its cron must be enabled after the sdk's first npm publish. It assumes default `link-workspace-packages: false` (guard comment in the file).
- **Follow-up findings from live testing** (out of scope here, for the architect): workspace display-name collision (two workspaces named `codev` are indistinguishable on the touch strip); Tower registers overly broad workspaces (`~`, `~/repos/cluesmith`) that can hijack follow-focus.

## Consultation Findings & Dispositions (single advisory pass)

PIR runs the 3-way consultation once — these findings were **not** independently re-reviewed, so
the human at the `pr` gate is the remaining check on each disposition. Gemini lane skipped
(agy unauthenticated, non-blocking). Full texts in `codev/projects/1347-*/1347-review-iter1-*.txt`.

- **Codex — REQUEST_CHANGES (2 findings, both confirmed and fixed):**
  1. *Boundary scanner missed side-effect imports* (`import '@cluesmith/codev-core'`) and dynamic `import()`. Real gap — the regex required a `from` clause. Fixed: extractor now covers static/re-export/side-effect/dynamic forms, with a fixture regression test pinning all four.
  2. *Tooltips and README contradicted the implementation* for the diff dials (press forwards, touch jumps to first — docs said press = first) and ScrollNav (press forwards selection — docs said touch). Confirmed against `actions.ts`; the verbatim-imported docs lagged a behavior swap made in the old repo. Fixed in `manifest.json` tooltips and README, plus a previously missing Scroll dial bullet.
- **Claude — non-blocking, 3 minors, all fixed:** the `bump-all.sh` gap above (its analysis corrected this review's original claim); stale README status prose ("V0.1… not yet validated on hardware"); the same boundary-scanner gap Codex flagged.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1347 → Review Diff.
- **Sideload** (real parity check; needs Stream Deck hardware + Tower): `pnpm --filter @cluesmith/codev-sdk build && pnpm --filter @cluesmith/codev-streamdeck build`, then `streamdeck link apps/streamdeck/com.cluesmith.codev.sdPlugin && streamdeck restart com.cluesmith.codev` (unlink any prior checkout's link first; `streamdeck list` to confirm the path).
- **Verify**: online badge (exercises injected auth), navigators/dials, action keys POST verbs, PR nav opens browser, follow-focus tracks focused VS Code windows (hook already in `~/.codev/config.json`).
- **Boundary**: `grep -rn "codev-client" apps/streamdeck/src` → only prose comments; the import-boundary test enforces specifiers.
