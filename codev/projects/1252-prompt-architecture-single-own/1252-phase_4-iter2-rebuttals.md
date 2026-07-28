# Phase 4 — rebuttal for porch iteration 2 (covers manual review rounds 2–5)

Porch's iteration counter and my manually-run review rounds diverged (I ran the
consults directly per porch's task instructions, producing iter2–iter5 files
within porch's single iteration-2 window). This file consolidates the record;
the full running detail is in `1252-phase_4-iter1-rebuttals.md`'s addenda.

## Round 2 (files `*-iter2-*`): Gemini APPROVE / Codex REQUEST_CHANGES ×2 / Claude APPROVE

1. **Preserved `release/protocol.md` still `cat`'d a deleted file** — accepted;
   repointed to `codev-skeleton/`, and the M7 sweep's blind spot (codev/'s own
   preserved content) recorded.
2. **`bugfix-742` parity became file-vs-itself** — accepted; the vacuous-parity
   class I claimed fixed in round 1 had a missed instance. De-vacuized.

## Round 3 (files `*-iter3-*`): Gemini APPROVE / Codex REQUEST_CHANGES ×2 / Claude APPROVE

1. **Repointed tests validate source, not the served embedded skeleton** —
   accepted with a different mechanism than suggested: new
   `skeleton-embed-sync.test.ts` enforces bidirectional byte-parity at the one
   copy boundary (source ↔ embedded), making source reads and resolver reads
   identical by construction while source tests keep failing at the commit
   surface. Single-owner pattern applied to the build boundary.
2. **Duplicate collapsed-mirror entries** — accepted; swept as a class:
   deduped 744 / governance-sweep / protocol-prompt-audit and collapsed three
   more vacuous pair loops inside baked-decisions.

## Round 4 (files `*-iter4-*`): Gemini APPROVE / Codex REQUEST_CHANGES ×2 / Claude APPROVE

1. **The spawn wrapper told builders to `Read codev/roles/builder.md`** — the
   live catch of the phase: a hardcoded sentence at four `spawn.ts` call sites,
   pointing at a deleted path (and always broken in fresh installs; #1011
   class — the role is harness-injected, never fetched). Fixed with a
   single-owner `builderPreamble()` + tests asserting the preamble and the
   full served prompt fetch nothing by literal framework path.
2. **Audit overstated the equivalence proof** — accepted; claim rewritten to
   state exactly what is proven.

## Round 5 (files `*-iter5-*`): Gemini APPROVE / Codex **COMMENT** (non-blocking) / Claude APPROVE

- Codex's remaining nit: the preamble said the role copy "is written" to
  `.builder-role.md`, which is false for `--no-role` spawns. **Fixed**: "with
  default role injection, a copy is also written…". No open issues remain.

## Final state

- All shadow copies deleted; skeleton is the single owner; local-only files
  preserved; `copyRoles`/`copyProtocols` gone.
- Equivalence proven at three layers: resolution tier (path-asserted),
  assembly (nine protocols, byte-identical to pre-deletion snapshots), and
  wrapper (no literal-path fetches).
- Embedded ↔ source skeleton sync mechanically enforced.
- Full suite: 3,728 passed, 0 failures.

Nothing was disputed in any round.
