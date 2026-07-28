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

| Class | Owner | Enforcement | Refs / retained restatements |
|---|---|---|---|
| no-skip-porch-checks | partial-flaky | automated | retained: bp-air, bp-maintain, bp-pir, bp-spike, pp-implement |
| no-skip-3way-review | partial-3way | automated | — |
| no-advance-phases-manually | partial-strict-restrictions | automated | — |
| baked-decisions-handling | partial-baked | automated | retained: bp-air, pp-specify, pp-implement, partial-pr-strategy, bp-spir, bp-aspir, spir-protocol-doc |
| pr-single-by-default | partial-pr-strategy | automated | — |
| porch-workflow-fidelity | partial-fidelity | automated | — |
| multi-pr-mechanics | partial-multi-pr | automated | — |
| notify-architect-key-moments | partial-notifications | automated | retained: bp-air, bp-bugfix |
| soft-mode-protocol-compliance | partial-soft-mode | automated | — |
| no-time-estimates | partial-no-time-estimates | automated | retained: spir-protocol-doc |

## Phase-6 measurement

<!-- t12-parity: total=158 mapped=9 scar=39 out-of-scope=110 classes=10 -->
158 normative candidates over the boundary post-Phase-7 (down from
190 at Phase 6 — dedup moved shared blocks into `codev-skeleton/partials/`,
which the boundary does not scan; every served prompt still receives the full
text at assembly): **9 mapped**, **39 scar** (registry-enforced),
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
