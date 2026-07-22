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
