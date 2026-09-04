# air-1474 — Render gate: tighten the loose agy prompt marker

Protocol: AIR (strict). Issue #1474. Branch `builder/air-1474`.

## What the issue asks

`AGY_MARKER = /^> /` in `gate-profiles.ts:72` treats *any* line starting with `> ` as agy's
composer prompt. Tighten it using signals the agy classifier already has (cursor row,
placeholder-fg palette, region boundary). Risk direction is **false-CLEAN** — deliver onto a
busy screen — so every ambiguity resolves to HOLD.

## Real-agy measurement (this is the load-bearing part)

agy 1.1.13 is authenticated in this environment, so the fixtures are **real captures**, not
synthesized. Captured under `node-pty` at 110×32 (`TERM=xterm-256color`), one capture per state,
then rendered through `@xterm/headless` and probed cell-by-cell.

| state | last `> `-matching row | that row's fg | cursor row | today's marker pick | actual composer |
|---|---|---|---|---|---|
| idle (accept-edits) | 11 | palette 12 | 11 | 11 ✅ | 11 |
| idle (bare `>`, no hint) | none — `trimEnd()` leaves `>` | palette 12 | 11 | **-1 ✗ false-HOLD** | 11 |
| draft | 24 | palette 12 | 24 | 24 ✅ | 24 |
| slash menu (`/`) | 13 — *menu selection cursor* | palette 12 | 11 | **13 ✗ wrong row** | 11 |
| trust dialog | 8 — *selected option* | palette 12 | 12 (off-row) | **8 ✗ wrong row** | none |
| settled after an answer | 20 | palette 12 | 20 | 20 ✅ | 20 |
| mid-repaint (torn prefix) | 10 — *user-turn echo* | palette **4** | varies | **10 ✗ wrong row** | absent |

Three findings that changed the design:

1. **agy echoes every submitted user turn into the transcript as a `> ` line** (SGR 34;1 →
   palette 4). So non-composer `> ` rows are not hypothetical — they accumulate one per turn.
2. **The slash menu's selection cursor is also `> ` and also palette-12**, and it renders
   *below* the composer — so `findMarkerRow`'s last-match-wins picks the menu item, not the
   composer. A palette anchor alone does NOT separate these; the **cursor row does**.
3. **In agy's no-hint mode the composer row is a bare `>`**, which `/^> /` never matches →
   the gate holds every message forever in that mode. Pre-existing false-HOLD, fixed here
   (the marker must match the *actual* composer, which is the issue's ask).

Markdown blockquotes render as `│`, not `> ` — so the issue's "quoted output" risk arrives via
the user-turn echo rather than via blockquotes.

I could not reproduce an actual false-CLEAN from the real captures: on every mis-bounded frame
the wrong region still contained counted text, so the verdict landed busy anyway. The defect is
real (the classifier bounds the wrong region on real frames); the corruption is latent. Said
plainly in the PR rather than overclaimed.

## Design

Two new optional `GateProfile` fields, both per-app data, both set only on agy:
`markerRequiresCursorRow` (the marker row must hold the cursor) and `markerFgPalette` (the
marker glyph cell must render in that palette index). Marker text pattern relaxed to
`/^>(\s|$)/` so the bare-`>` mode matches. Net effect: strictly more evidence required to call a
row the composer, and no new false-CLEAN surface.

Known accepted cost: a mid-repaint frame can park the cursor on the status line for one frame,
which now HOLDs where it previously classified clean. Transient and fail-safe — retried on the
next check — and every *settled* capture puts the cursor on the composer row.

## Pre-existing e2e failures (NOT from this change)

The AIR `pr` phase's `e2e_tests` check is `npm run test:e2e … || echo 'skipped'` and the repo root
has no `test:e2e` script, so it passes in 0.1s having run nothing. Ran the real suite instead
(`pnpm --filter @cluesmith/codev test:e2e`): **3 failed | 171 passed | 21 skipped**, all three in
`tower-api.e2e.test.ts` — `POST /api/terminals` returning 500 where 201 is expected.

Confirmed pre-existing, not flaky: reverted both changed source files to the branch base
(141b4935), rebuilt, re-ran that file — **identical 3 failures**. Restored the files afterwards
(everything was committed, so lossless; verified clean against HEAD). Not skipped or annotated,
since they are neither mine nor flaky — flagged for the maintainer instead. Plausibly
environmental: this box is running four-plus live builder sessions plus Tower, and the failures
are all PTY-spawn-via-API.

## Status

- [x] Real agy fixtures captured across idle / draft / trust / menu / echo / bare-marker / torn
- [x] Classifier + profile change
- [x] Tests (55 pass; build ✓, unit ✓ via `porch check`)
- [x] PR #1491 opened — parked for maintainer review
- [x] 3-way CMAP: gemini APPROVE, codex APPROVE, claude COMMENT — zero blocking correctness issues
- [x] CMAP blocking item: agy parity case on the production mirror path (7 fixtures × 2 chunk sizes)
- [x] CMAP follow-ups all taken in-PR: arch.md entry, capture harness, cosmetic title
- [x] `pr` gate approved by the human (relayed by the architect), `porch approve` run by me
- [x] **PROTOCOL COMPLETE** — verified PR #1491 still OPEN / unmerged

## CMAP round (2026-08-18)

The one requested item was a parity case in the production-mirror-path suite: these anchors are
the first classifier input that depends on **cursor state**, so the transient-replay vs
`SessionScreen`-mirror seam became load-bearing. Added one case per agy fixture (7, not a
representative), `toEqual` on the whole verdict, each fed twice — production-sized chunks and
7-byte chunks that split the cursor-positioning CSI across `feed()` calls, since a mis-parsed
cursor is now a verdict change. Both pass.

Committing the capture harness turned up a real defect in my own tooling: the sanitizer's leak
check tested for the bare prefix `/home/`, while the replacement path IS `/home/agent/project` —
so it reported a leak on every successful run. A check that always fires checks nothing. Fixed to
match non-placeholder paths and to refuse to write on a leak. The committed fixtures were always
clean (independent grep before the first push; confirmed again by re-deriving four of them
byte-identically from the raw captures) — the defect was in the check, not the fixtures.

## For whoever picks this up

- The PR is **not merged** — deliberately. This cohort is not a maintainer of cluesmith/codev.
- Merge-order note from the architect: PR #1487 (issue #1471) also touches `render-gate.test.ts`
  in a different region; whichever merges second may need a trivial rebase.
- `codev/air-1474-captures/` regenerates the fixtures. Set `EMAIL` in `sanitize.py` first, and
  keep the 110×32 geometry — the cursor anchor compares row indices, so a different width moves
  the wrap points and invalidates the committed fixtures.
- Related issue filed by the architect: #1488 (the AIR `e2e_tests` check is a no-op).

## Merge of main (2026-09-03, resumed session)

The branch had gone 770 commits behind and PR #1491 reported CONFLICTING. Merged `origin/main`
in (not rebased — this repo merges, never squashes). Exactly one file conflicted,
`packages/codev/src/agent-farm/servers/render-gate.ts`, and it was adjacency, not disagreement:
#1573 inserted a new exported `bufferLines(term)` directly above `findMarkerRow`, whose doc
comment and signature this branch had rewritten for the cursor-row/palette anchors. Kept both
sides verbatim; nothing of #1573's was dropped.

The two functions are worth keeping straight, since they now sit adjacent:

- `screenLines()` — viewport only. The gate's classification path; the #1474 anchoring lives here.
- `bufferLines()` — viewport plus scrollback (#1573), for post-delivery echo verification only.
  Not a classification input, and the marker anchoring does not touch it.

Premise re-verified on current main: `AGY_MARKER = /^> /` is still at `gate-profiles.ts:72`;
the only commit to that file since the merge-base was the unrelated `afx reset` → `afx refresh`
rename, which nothing of ours references.

### A false alarm worth recording

The first post-merge `pnpm test` reported 14 failures in `request-auth.test.ts` and
`tower-routes.test.ts` — `WS_KEY_PROTOCOL_PREFIX` and `TOWER_KEY_HEADER` arriving `undefined`.
None were ours and none were real: `packages/types/dist` was from Aug 17, so the constants main
had added since simply did not exist in the built artifact the tests import. `pnpm build` then
failed too, but only at the asset step — main added a `three` dependency this worktree's
`node_modules` predated.

`pnpm install` → `pnpm build` (exit 0) → `pnpm test`: **275 files passed, 3 skipped, 0 failed;
5477 tests passed, 48 skipped.** Typecheck clean. The render-gate suite is 66 now rather than
the 55 recorded above — main's own additions to that file merged in cleanly alongside ours.

So: a stale worktree, not a broken merge. Anyone resuming a long-parked builder here should
`pnpm install && pnpm build` *before* believing a test failure.

Merge commit `818337fa2`, pushed. PR #1491 now reports MERGEABLE. Still **not merged** and the
issue is still open — deliberate, unchanged: this cohort is not a maintainer of cluesmith/codev.

## Maintainer review round (2026-09-03)

CHANGES_REQUESTED on PR #1491 — one blocking item, two non-blocking. The render-gate change
itself reviewed as approve-quality; the blocking item was in my capture tooling.

### Blocking: sanitize.py wrote the unsafe file before checking for leaks

The ordering was write-then-check, so on a leak the fixture was already on disk and the
"REFUSING to sanitize" message was false by the time it printed — `git add` could reach it in
the window. My earlier fix had corrected the leak *predicate* and left the *ordering* alone,
which is a good reminder that fixing the thing you noticed is not the same as fixing the thing
that is wrong. Now check-then-write: nothing reaches the filesystem until every check has run.
Chose that over delete-on-failure — a guarantee that depends on cleanup running is weaker than
one that never creates the file.

Also added `/Users/…` to `PATH_RE`. Without it a macOS capture sanitizes "successfully" while
leaking a username, because the leak check only inspects what that same pattern finds. The
scrubber's prefixes and the checker's prefixes have to be one list, not two.

Writing the `--selftest` turned up a **second** defect, in the predicate I had already "fixed":
same-length substitution truncates a cwd shorter than the placeholder, so `/home/ab/x` becomes
`/home/agent/p`, which failed `startswith(PLACEHOLDER_PATH)` and was reported as a leak. Every
short-cwd capture would have been unsanitizable. Fail-safe, so it would have looked like a
mysterious refusal rather than a leak — the kind of thing that gets worked around by disabling
the check. `is_placeholder()` now accepts prefixes of the placeholder too. Re-verified all seven
committed fixtures against the widened predicate: still `leaks=[]`.

The selftest is wired into CI (`air-1474-sanitize-ordering.test.ts`, skips if python3 is
absent). The rest of the harness stays out of CI — it needs an authenticated agy and a PTY —
but this one part's failure mode is committing someone's username, so it runs.

### Non-blocking, taken: cursorY is baseY-relative

`classifyBuffer` read `buf.cursorY` alongside `top = buf.viewportY`, which assumes
`viewportY === baseY`. True for every screen the mirror produces today, but not xterm's
contract, and the anchors had just made the cursor row the thing that gates delivery.

I expected to write a defensive test and instead measured a real false clean. Scroll the
viewport up, and the unconverted row lands on a **stale composer still in scrollback** — empty,
palette-12, rule beneath it — so the region bounds and classifies `empty`. CLEAN, while the
live composer sits off-view holding a half-typed draft. Verified against the built old code
(`{clean: true, detail: 'empty'}`) and the fixed code (`no-composer-marker`). So this was not
hygiene: reachable any time something scrolls the mirror's viewport, and nothing in the tree
promises nothing ever will. `buf.baseY + buf.cursorY - top` removes it.

The regression test pins the rigging itself — that the viewport is genuinely off the bottom,
that the two conventions disagree, and that the row the old reading picked really was a
marker+rule pair — so it fails loudly if a future xterm turns it into a tautology. Both new
tests mutation-checked: revert either fix and the matching test fails.

### Non-blocking, deliberately NOT done here

Idle-session profile drift is silent: `onLiveness` gates on recent output, so a re-themed agy
sitting idle holds forever with no alarm — the same shape as the bare-`>` bug this PR fixes.
The maintainer suggests classifier-stuck escalation or an `afx doctor` check that classifies
each live mirror once. Real gap, genuinely good catch, separate feature; the architect is
filing it. Same for `markerFgPalette` needing to accept multiple colors before agy ships a
truecolor theme.
