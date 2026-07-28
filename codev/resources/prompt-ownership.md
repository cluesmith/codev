# Prompt Ownership Map — human companion (Spec 1252, M1)

**The machine-readable source of truth is `prompt-ownership.yaml`** — tests
derive from it, and this companion summarizes it for humans. If they disagree,
the YAML wins; fix this file.

## The single-owner rule

Every instruction has exactly one owning surface; all other surfaces reference
or summarize it, never restate it. Two carve-outs, both deliberate:

- **Scar rules** (8, registered in `scar-rules.yaml`) replicate **verbatim** on
  every surface they apply to — their enforcement lives in that registry and
  `scar-rules.test.ts` (T6), not here, so ownership of scar enforcement itself
  stays single.
- **File-local process instructions** (a phase prompt's "don't start the next
  phase", a role doc's workflow steps) are implicitly owned by their file. The
  completeness machinery permits them via a catch-all that **cannot** absorb
  any text appearing on 2+ files — cross-surface duplication always demands an
  explicit disposition.

## Inventory boundary

What the extractor scans (out-of-boundary content is out of scope *by
declaration*): `CLAUDE.md`, the two hot-tier files, the 3 role docs, the 9
builder-prompts, and the 10 porch phase prompts. `AGENTS.md` is excluded from
scanning only because it is byte-identical to `CLAUDE.md` (enforced by T6).

Deliberately outside: protocol.md docs, templates, consult-types (on-demand,
correctly tiered), COLD `arch.md`/`lessons-learned.md`, and `codev/resources/`
generally — user-evolved files where divergence is legitimate, which is also
why `FRAMEWORK_DRIFT_DIRS` omits `resources` (Q7).

## Instruction classes (non-scar, cross-surface)

Discovered by the extractor at Phase 6. Phase 7 extracted the uniform blocks
into shared partials (single authored owner; served prompts still carry the
full text via `{{> partials/...}}` include expansion) and flipped those
classes to `automated`. Classes whose remaining copies are protocol-specific
variants stay `manual` or carry declared `retained_restatements` (each
justified in the YAML):

| Class | Owner | Currently restated on |
|---|---|---|
| no-skip-porch-checks | bp-spir | 7 other builder-prompts (not research) |
| no-skip-3way-review | bp-spir | 3 builder-prompts |
| no-advance-phases-manually | bp-spir | bp-aspir |
| baked-decisions-handling | bp-spir | bp-aspir, bp-air, 2 drafting prompts (Spec 746 coordination required) |
| pr-single-by-default | bp-spir | bp-aspir (bugfix-744 tests must move with the dedup) |
| porch-workflow-fidelity | bp-spir | bp-aspir, bp-pir |
| multi-pr-mechanics | bp-spir | bp-aspir |
| notify-architect-key-moments | bp-spir | 3 builder-prompts |
| soft-mode-protocol-compliance | bp-spir | 4 builder-prompts |
| no-time-estimates | spir-protocol-doc | pp-specify, pp-plan |

## Phase-6 measurement

<!-- t12-parity: total=173 mapped=24 scar=39 out-of-scope=110 classes=10 -->
173 normative candidates over the boundary post-Phase-7 (down from 190 —
dedup moved shared blocks into `codev-skeleton/partials/`, expanded into every
served prompt at assembly): **24 mapped**, **39 scar** (registry-enforced),
**110 file-local**. Zero undispositioned; zero multi-file texts hiding behind
the catch-all. The parity marker above is
asserted against the live extractor by `prompt-ownership.test.ts` — if these
numbers drift from reality, CI fails until this companion is updated.

## Enforcement

- `prompt-ownership.test.ts` — T12 completeness (zero undispositioned; no
  multi-file text via catch-all; seeded-line validated) and T7 single-owner
  (derived from the YAML; machinery fixture-proven; live classes activate as
  they flip to `automated`).
- `scar-rules.test.ts` — T6 verbatim replication for the eight scar rules.
- `shadow-drift-gate.test.ts` — tier-2 shadow copies of framework files fail CI.
- `skeleton-embed-sync.test.ts` — source skeleton ↔ embedded skeleton byte-parity.
