# bugfix-1990 thread

Issue #1990: the root-doc tests (`bugfix-1982-update-root-docs.test.ts`, and the
`air-1985-update-older-root-docs.test.ts` beside it) fail on native Windows. The architect's
rule: settle "tests only, or product?" with a Windows run of the built package before fixing.

## 2026-11-25 — investigate

- Branch is cut from `main` @ `9fc63f2cc`, which already has PR #1987 (#1985) merged.
- Code path: `copyRootFiles` (scaffold.ts) decides conflict vs up to date with
  `matchesTemplate`, which normalises CR LF → LF on both sides first. Then
  `syncHotContextBlock` → `upsertHotContextBlock` (managed-block.ts) splices the block in,
  and the block is always rendered with LF.
- Local simulation (source `init` + `update`, LF templates as published): a CR LF doc gives
  **no conflict**, but `update` writes the LF block into the CR LF doc → the doc is mixed
  (CLAUDE.md: 154 CR LF + 14 LF lines). Same for a CR LF doc missing the block. So the
  product writes mixed line endings; the conflicts the issue lists look like test artefacts
  of a CR LF checkout (`init` itself produces a mixed doc there, then the CRLF test turns
  `\r\n` into `\r\r\n`; the block-missing test slices `end + 2`, assuming LF).
- Not proof: next is a probe on a Windows runner (packed + installed package, skeleton as
  git stores it), from a probe branch that is never merged.

## 2026-11-25 — Windows probe: the product is wrong (mixed endings, not conflicts)

Run https://github.com/cluesmith/codev/actions/runs/45709493779 on `builder/bugfix-1990-probe`
(probe test only; never merged). Packed + globally installed codev, skeleton replaced by the
git blobs (installed template 0 CR LF / 168 LF, as published).

- LF project: 0 conflicts, docs untouched.
- CR LF project (commit + re-checkout with `core.autocrlf=true`), unedited: 0 conflicts, but
  the block is rewritten in LF → CLAUDE.md 154 CR LF + 14 LF. Mixed.
- CR LF doc missing the block: 0 conflicts, block inserted in LF → mixed.
- CR LF doc edited outside the block: one conflict (right), but the doc itself is modified.
- Same run, `main`'s code: air-1985 green; bugfix-1982 has 4 failures. Two (`.codev-new`
  byte comparisons) are this bug (`init` writes a mixed doc on a CR LF checkout); two are
  the tests (`replace(/\n/g, '\r\n')` doubling CRs; `slice(end + 2)` assuming LF).
- Root cause: `renderHotContextBlock` joins with `\n`; `upsertHotContextBlock` splices it
  into a CR LF doc unchanged. `matchesTemplate` already normalises, so conflicts are right.
- Told the architect; fix = write the block in the doc's own line ending.

## 2026-11-25 — fix

- Architect accepted the finding and added: read the line ending from the text OUTSIDE the
  block (heal docs this bug already left mixed), cover init on a CR LF checkout, and put the
  measured before/after table in the PR with after-fix numbers from a Windows run on the head.
- Rule chosen: all line breaks outside the block CR LF → CR LF; anything else (all LF, both
  kinds, none) → LF, the published templates' ending. `managed-block.ts` only; replacement of
  an older shipped doc (#1985) still writes the template as init would (not mixed).
- Tests: new `bugfix-1990-crlf-root-docs.test.ts` mocks `getTemplatesDir` to skeletons built in
  LF and CR LF, so it holds on any checkout; rule unit tests in `managed-block.test.ts`; the two
  LF-assuming bugfix-1982 tests fixed. 10 tests fail without the fix.
- Fast loop: converting the gitignored `packages/codev/skeleton` copy to CR LF reproduces
  exactly the 4 Windows failures with the old code, and is green with the fix.
- Findings posted on the issue: issuecomment-7176007177.
- Windows: branch run 45710698393 (suites + `update-` filter), probe-after-fix 45710704421.

## 2026-11-25 — PR #1991, CMAP round 1

- First Windows runs at `87b9202b6`: branch run 45710698393 all green (1982 13/13, 1985 22/22,
  codev unit 458 files 0 failed, incl. the new file 7/7); probe 45710704421: all four projects
  correct after the fix (CR LF unedited 168/0 untouched, block missing 152/0 → 168/0, edited
  kept byte for byte). Probe branch deleted, then recreated for the final head (see below).
- codex: REQUEST_CHANGES: no code defects. (a) reword the `chore(porch): …` commits: rebutted,
  those are porch's own state commits, the same on every project on `main`; (b) Windows unit
  job pending: since green.
- claude: APPROVE, with a real finding: a CR LF doc from before Spec 987 that a pre-fix update
  gave its block by INSERTION also got the blank line before the block and the break after it
  in LF, outside the markers (`# T\r\n\n<block>\n\r\nbody`), so the outside rule read it as
  mixed and it would never heal. Confirmed against the old code. Fixed by counting the line
  break on each side of the markers as part of the block (excluded from detection, written in
  the doc's ending). Rejected the suggested majority vote: it contradicts the architect's
  "genuinely mixed → template's ending" and would still leave two stray LFs.
- Final head `1526cd9f3`: branch run 45712624268, probe 45712627797 (5th scenario:
  insert-damaged docs). CMAP re-run on it.
- Final head green on Windows: branch run 45712624268 (1982 13/13, 1985 22/22, codev unit 458
  files 0 failed, incl. bugfix-1990 8/8, managed-block 16/16); probe 45712627797: the
  insert-damaged doc (152/16) healed to 168/0 by the installed package; other rows as before.
  13 tests fail on main's managed-block.ts. Probe branch deleted for good.
- CMAP round 2: claude APPROVE; codex REQUEST_CHANGES only on porch's `chore(porch):` commits
  (rebutted). Open for the architect: `.codev-new` is still the template's line ending (LF) for
  a CR LF doc — pre-existing, a design call, not changed here.
