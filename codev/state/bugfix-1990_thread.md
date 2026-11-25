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
