# aspir-1210 — codev doctor: detect protocol-file drift

## Context
Issue #1210. Add drift detection to `codev doctor`:
- **Shadow drift**: local `codev/**` (and `.codev/**`) files that also exist in the installed
  skeleton — diff them; identical = redundant, differs = "customized or stale? adjudicate".
- **Skeleton staleness**: installed package version vs npm latest (best-effort, offline-tolerant).
- **Known-default detection** (stretch): historical skeleton hashes → provably-rot local copies.
- **No auto-delete** — report only; adjudication stays human.

No "Baked Decisions" section in the issue → free to explore the design.

## Key codebase facts (gathered during Specify)
- `codev doctor` lives in `packages/codev/src/commands/doctor.ts`. It already has a mature
  pattern of section-by-section checks + `warningDetails` roll-up. Existing analogous audits:
  `pr-gate-audit.ts` (#943), `framework-ref-audit.ts` (#1011), `gitignore.ts`. Each is a pure
  lib returning findings + a formatter, wired into both `doctor.ts` and (some) `update.ts`.
- Four-tier resolver: `packages/codev/src/lib/skeleton.ts` → `resolveCodevFile()`
  (.codev/ → codev/ → cache → skeleton). `getSkeletonDir()` = built `packages/codev/skeleton/`.
  `listSkeletonFiles(subdir)` walks the skeleton. `hasLocalOverride()` checks tier-2.
- Skeleton relative path == local path minus the `codev/` prefix (e.g. skeleton
  `protocols/spir/protocol.md` ↔ local `codev/protocols/spir/protocol.md`).
- Installed pkg version: `version.ts` (reads package.json). No npm-latest check exists anywhere yet.

## Progress
- [done] Specify — spec drafted + committed. 3-way spec consult: gemini APPROVE, claude APPROVE,
  codex COMMENT. Folded codex/gemini tightenings into spec: explicit scan set, dual override roots
  (both `.codev/` and `codev/` reported, winner marked), staleness reports explicit `installed X;
  latest Y` (not "N behind"), item-2 marked non-blocking, ~2.5s timeout, raw-byte compare for EOL.
- [done] Plan — 3 phases: (1) `lib/protocol-drift-audit.ts` (shadow drift + staleness), (2) wire
  into doctor.ts, (3) unit + e2e tests. Item 2 (historical-hash known-default) deferred to follow-up;
  `codev update` wiring deferred (spec: optional). Checks pass.
- Plan 3-way consult: gemini APPROVE, claude APPROVE, **codex REQUEST_CHANGES** (legit): plan
  self-contradicted — Exec Summary "no-op when no overrides" vs Phase 2 "staleness always shown".
  Resolved with a single unambiguous rule in both spec + plan: Framework Drift section is
  **quiet by default** — prints nothing unless a shadow exists OR skeleton is behind. Staleness is
  silent when up-to-date/offline; warns only when genuinely behind (the issue's sibling failure mode).
  Re-running plan consult after the fix.

## Implement
- Worktree had NO node_modules on spawn — ran `pnpm install` + built `@cluesmith/codev-core` first
  (its .d.ts are needed or tsc floods with module-not-found). Noting for siblings.
- Phase 1 [done]: `lib/protocol-drift-audit.ts` — `auditProtocolDrift(root?, skeletonDir?)`,
  `hasFrameworkShadows`, `checkSkeletonStaleness(fetchLatest?)` + formatters. All injectable for tests.
  Raw-byte SHA-256 compare; scan set protocols/consult-types/roles; staleness via `npm view` (2.5s,
  offline→null). tsc clean, `npm run build` ✓, full suite 3555 passing. Committed. Phase_1 3-way consult running.

- Phase 1 iter2: codex REQUEST_CHANGES (used custom walk instead of `listSkeletonFiles`) → fixed
  (reuse `listSkeletonFiles(sub)` filtered to .md/.json). Re-consult: unanimous APPROVE. Committed.
- Phase 2 [done]: wired "Framework Drift" section into doctor.ts — quiet-by-default (prints only if a
  shadow exists OR skeleton behind). Manually verified against THIS repo's real codev/ overrides:
  differs→⚠ warnings, identical→○ redundant-copy info, staleness "up to date", `[resolved — live]`
  marker all render. e2e doctor tests unaffected (they run in an empty sandbox, no codev/ project).
  Committed. Next: phase_2 build+test checks + 3-way consult.

- Phase 2 iter2: codex REQUEST_CHANGES ×2 (differs line lacked skeleton version; header parenthetical
  false in staleness-only path) → both fixed (version threaded via staleness.installed; subtitle
  adapts). Re-consult: unanimous APPROVE.
- Phase 3 [done]: unit test (19 cases: identical/differs/no-copy/both-tiers/resources-excluded/
  EOL/no-op/staleness behind|uptodate|offline|throws/formatters/no-mutation/scan-set integrity) +
  e2e (3 cases). e2e forces unreachable npm registry so staleness is deterministic ("could not
  check") — keeps the no-overrides no-op assertion stable & offline. Unit 19/19, e2e 3/3. Committed.

- Phase 3 iter1: codex REQUEST_CHANGES + claude COMMENT (same gap): plan's e2e deliverable
  "no overrides + skeleton behind → staleness section shown" was unreachable because e2e forced npm
  offline everywhere. Fixed with a documented `CODEV_DOCTOR_FAKE_LATEST` env seam in doctor.ts →
  added e2e for the staleness-only behind branch; asserted identical=info-only (no adjudicate line);
  made EOL unit precondition explicit. Unit 19/19, e2e 4/4. Re-consult (iter2) running.

- Phase 3 iter2: codex REQUEST_CHANGES (MEDIUM) — plan's 2nd non-functional assertion (staleness
  bounded-when-offline) missing; only stub-offline covered. Fixed: exported real `fetchLatestVersion`
  + `NPM_LATEST_TIMEOUT_MS`; added unit test hitting unreachable registry asserting null + bounded
  time. Unit 20/20. iter3 re-consult running.

- Phase 3 iter3: unanimous APPROVE. All 3 implement phases done.
## Review
- Wrote review (codev/reviews/1210-...md) with Architecture Updates (cold: no change — faithful
  instance of the doctor audit-lib pattern) + Lessons Learned Updates (cold/Testing: test the real
  timeout path, not a stub). Creating PR next; will STOP at pr gate for human approval.

- PR #1223 created + pushed. Worktree clean (only builder-local .builder-*/.claude/hooks untracked).
- PR-review 3-way consult: gemini APPROVE, codex COMMENT (non-blocking), claude APPROVE.
  Codex comments both non-actionable: (1) `chore(porch)` commits aren't [Spec] format — those are
  porch's own auto-commits, not my feature commits; (2) reviewer couldn't run vitest in read-only
  sandbox (I ran full suite green). No changes made.
- **STOPPED at pr gate — awaiting human approval.** Not auto-approving (human-only gate). Architect
  notified. Builder will run `porch approve 1210 pr` only after the human explicitly approves.

- pr gate APPROVED (Waleed, relayed by architect) → ran `porch approve 1210 pr --a-human-explicitly-approved-this`.
- CI: all 6 checks GREEN (Unit, CLI ubuntu/macos, CLI Integration, Tower Integration, Package Install).
  Not merging — branch protection requires architect admin-merge. Reported to architect.
