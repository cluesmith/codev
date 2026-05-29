# Plan iter1 — Rebuttal / Response to Review

**Verdicts**: Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES

Both of Codex's points were valid and have been **accepted and fixed** in the revised plan
(`[Spec 919] Plan with multi-agent review`). No disagreement.

## Codex point 1 — "Phase 3 is not actually independent of Phase 2"

**Accepted.** Codex is correct: today the terminal write is hard-coded `'verified'`
(`index.ts:523`, `next.ts:348`, `:777`), so Phase 3's end-to-end acceptance case ("rollback → re-run to
terminal → lands in `complete`") cannot pass until Phase 2's gate-derived terminal write lands.

**Change made**:
- Phase 3 `Dependencies` changed from "Phase 1" to "Phase 1 **and** Phase 2", with an explicit note
  that the metadata-clearing deliverable is independently testable but the re-completion assertion
  sequences after Phase 2.
- Dependency Map updated to `Phase 1 → Phase 2 → Phase 3`, with Phase 4 depending only on Phase 1.

## Codex point 2 — "Phase 4 read-site audit test coverage is underspecified"

**Accepted.** The spec requires *all* read sites verified by tests; the original Phase 4 test plan only
named overview and workspace-recover explicitly.

**Change made** — Phase 4 test plan now assigns explicit test ownership per audited site:
- `overview.ts` parser demotion (four cases)
- `derivePrReady` (BUGFIX `complete` → true; SPIR/ASPIR `verified` → false; `pr_ready_for_human`
  precedence)
- both progress paths (`overview.ts:373` and `:386`) → 100% for both terminal names
- `workspace-recover.ts` terminal skip (add `complete` case)
- **`next.ts` terminal short-circuit** — both `complete` and `verified` hit "already done", owned in
  Phase 4
- **`builder-helpers.ts` idle-waiting** — returns false for both terminal names (core test)
- `status.ts` display color — asserted if a display test exists, else relied on via audit (pure display
  branch already handling both names)
- cross-reader agreement test (`readState` vs `parseStatusYaml`) for all four cases

## Net effect
The plan's claimed phase independence is now honest, and the "all read sites verified by tests"
requirement has concrete per-site test ownership. Ready for re-verification.
