# air-1119 — Replace hot-context managed block with @import lines

Issue #1119 (AIR, strict mode). Replace the materialized hot-context managed block
in CLAUDE.md/AGENTS.md with Claude Code `@import` lines → single source of truth,
no drift footgun.

## Phase: Implement

### Findings from recon
- `renderHotContextBlock` (lib/managed-block.ts) is the only thing to change for the
  block content. It currently calls `readHotTierFiles` and inlines verbatim content.
- `readHotTierFiles` is ALSO used by porch's `buildHotTierContext` (prompts.ts) which
  must keep inlining live content (model never expands @import). So I leave
  `readHotTierFiles` untouched; `renderHotContextBlock` stops calling it and instead
  emits `@import` lines per-file-that-resolves.
- `packages/codev/skeleton/` is a BUILD ARTIFACT (gitignored; `cp -r ../../codev-skeleton
  skeleton` at build). So I edit the 4 SOURCE template docs:
  `codev-skeleton/templates/{CLAUDE,AGENTS}.md` + `codev/templates/{CLAUDE,AGENTS}.md`.
  The two `packages/codev/skeleton/templates/*` come for free at build.
- DISCREPANCY vs issue text: the template docs currently carry NO hot block at all
  (no markers, no inlined content) — the block is injected at `codev init` time via
  `syncHotContextBlock`. The issue's "three copies" is source + root CLAUDE.md + root
  AGENTS.md. Acceptance still asks the six templates to carry the @import lines inside
  markers, so I add the (idempotent, drift-free) @import block to the 4 source templates
  after their first H1, matching `renderHotContextBlock`'s exact output so init's sync
  is a no-op on them.
- Resolution check: `renderHotContextBlock` emits a line iff `resolveCodevFile` finds the
  hot file (same notion as the rest of the system); import path is fixed `@codev/resources/X`.

### Plan
1. managed-block.ts: new renderHotContextBlock emitting @import lines (+ HOT_IMPORTS const).
2. Regenerate root CLAUDE.md/AGENTS.md via the real syncHotContextBlock (build first).
3. Add matching @import block to the 4 source template docs.
4. Update tests: managed-block.test.ts, hot-tier-materialization.test.ts (assert @import,
   not inlined content; add adopter-migration case). governance-sweep marker checks stay.
5. Full suite green; CLAUDE.md ≡ AGENTS.md byte-identical.

## Progress
- managed-block.ts: renderHotContextBlock now emits @import lines.
- IMPORTANT subtlety caught by a test: the emit predicate must be a LITERAL
  fs.existsSync at `codev/resources/<file>`, NOT resolveCodevFile (four-tier).
  resolveCodevFile falls back to the package skeleton (tier 4), so it returns
  non-null even when codev/resources/ is empty → would emit a DANGLING @import.
  readHotTierFiles (porch inline path) keeps four-tier on purpose — different
  mechanism (inline live content, skeleton fallback is legit there).
- Regenerated 2 root docs + 4 source templates via the REAL syncHotContextBlock/
  upsertHotContextBlock code path (scratchpad regen.mjs against built dist).
- Root CLAUDE.md ≡ AGENTS.md byte-identical ✓; no inlined hot content ✓;
  all 6 docs carry the 2 @import lines inside markers ✓.
- copy-skeleton re-run so the gitignored build artifact reflects template edits.
- Hot-tier tests (19) green. Full suite running.
- Diff: 9 tracked files (~172 ins / 155 del, well under 300 LOC).

## Phase: PR
- Committed (9e6379a2), pushed builder/air-1119.
- PR #1120 opened with AIR review in the body.
- porch check: pr_exists + e2e_tests green. porch done → GATE: pr requested.
- WAITING for human approval at the `pr` gate. Will not call porch approve (human-only).
