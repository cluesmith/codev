# PIR #1347 — Iteration 1 dispositions

Verdicts: claude APPROVE (3 non-blocking minors), codex REQUEST_CHANGES (2 findings).
All five points were verified against the actual source before acting; all five were real.
Everything below landed in commit `bfd6c4753` (52/52 tests, `streamdeck validate` ✓, PR body synced).

## Codex finding 1 — boundary scanner misses side-effect imports (CONFIRMED, FIXED)

`importSpecifiers` matched only `import|export … from '…'`, so `import '@cluesmith/codev-core'`
(and dynamic `import('…')`) bypassed the guard. The extractor now covers static, re-export,
side-effect, and dynamic forms, and a fixture regression test pins all four
(`import-boundary.test.ts`, `importSpecifiers extraction` describe block).

## Codex finding 2 — tooltips/README contradict implementation (CONFIRMED, FIXED)

Verified against `actions.ts`: diff-dial **press** forwards the file/hunk and **touch** jumps to
first (the code comments — "was the touch strip" / "was the dial press" — show the behavior was
swapped in the pre-migration repo without the docs following); ScrollNav forwards on **press**,
not touch. Fixed all three manifest tooltips, corrected the README's two diff-dial bullets, and
added the previously missing Scroll dial bullet.

## Claude minor 1 — review's lockstep claim wrong in mechanism (CONFIRMED, FIXED)

`bump-all.sh` covered neither `apps/streamdeck/package.json` nor the manifest, so version drift
would have been *silent* (both files stale together keeps `version-sync.test.ts` green), not the
loud failure the review claimed. Fixed by extending `bump-all.sh` to bump both (manifest gets
`{version}.0`; pre-releases skipped, mirroring the vscode marketplace constraint), and the review
bullet now describes the true mechanism.

## Claude minor 2 — stale README status (CONFIRMED, FIXED)

"V0.1 … not yet validated on physical hardware" was doubly false post-gate; rewritten.

## Claude minor 3 — same scanner gap as Codex finding 1

Same fix as above.

## Not changed

Nothing was rebutted — every finding survived verification. The out-of-scope live-testing
findings (workspace name collision, broad Tower workspace registrations) remain follow-ups for
the architect, recorded in the review file.
