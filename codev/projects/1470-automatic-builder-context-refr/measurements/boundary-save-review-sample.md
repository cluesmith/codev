<!-- context-refresh-nonce: 0000000000ab -->

# Boundary save — spir-1470 @ enter:review

## 1. Receipts (done AND verified)

- Phases 1–7 complete and porch-recorded. `porch status 1470` shows ✓ through
  `phase_7_docs_and_parity`; phase 8 in progress.
- Commits on `builder/spir-1470`, all with build+suite green at the time:
  `bd5cbc615` (phase 6 iter2), `ba1b5d497` (phase 7), `b5a22d1f4` (phase 7 iter1),
  `61951925c` (phase 7 iter2), `491d82b10` (phase 8 simulation).
- Suite at last full run: 5265 passed, 48 skipped, 0 failed. Build exit 0.
- Artifacts committed: spec + plan (both carry approved/validated frontmatter and an
  Amendments section), 12 rebuttal docs under
  `codev/projects/1470-automatic-builder-context-refr/`.
- NOT yet written: `codev/reviews/1470-automatic-builder-context-refr.md`.
- NOT yet done: PR. No PR number exists yet.

## 2. Deviations from the plan

- Plan named only `codev/protocols/spir/protocol.json` for the `$schema` fix; all nine
  in `codev/` were broken and so was the skeleton generator. Fixed all, plus
  `codev-skeleton/`, because `copyProtocols` was emitting the bug into every adopter.
- Plan did not anticipate extracting a shared test fixture; done at phase 8 to stop the
  simulation drifting from the Phase 2 protocol shape.
- `--boundary` suppression at the pre-approval site: human ruled SUPPRESS; spec line 266
  and plan line 206 amended.

## 3. Flaky / skipped tests

None encountered. 48 suite-wide skips are pre-existing and unrelated.

## 4. Deferred work (knowingly left)

- `codev-skeleton/protocol-schema.json` now unreferenced — NOT deleted; two schemas
  differ in content, so deleting the unreferenced one may be backwards. MAINTAIN candidate.
- Two divergent protocol schemas (draft-07 vs 2020-12) left as-is; pre-existing.
- `runReset`'s log-after-clear ordering: driven-path, out of scope, architect asked for a
  one-line note in the review's follow-ups.
- `porch done`→`porch next` chained in one shell never reaches verification; worked around,
  recorded as a follow-up.

## 5. Standing orders still binding

- Plan phases are commits in ONE PR. Do NOT open a PR per phase.
- Phase 8 live runs are ARCHITECT-DRIVEN on a disposable subject builder. Flag the
  architect only when the runbook is ready, not before.
- Tests 37 and 38 are BLOCKING. Do not merge past a red live acceptance criterion.
- Report every porch force-advance to the architect immediately, with verdicts-at-ceiling.
- PR body must carry a "pre-existing fix" section referencing #1503, which closes with it.
- Do NOT retroactively repair in-flight ASPIR projects.
- Never `git add -A`; stage each path explicitly.

## 6. Next concrete action

Write the Phase 8 runbook including the preflight (`afx self-refresh --begin` from the
subject worktree, verifying identity resolution before anything approaches a clear), then
`afx send architect` that Phase 8 is entered and the runbook is ready.
