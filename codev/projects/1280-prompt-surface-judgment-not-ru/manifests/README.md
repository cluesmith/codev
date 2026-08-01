# Per-phase inspection manifests (Spec 1280, M11)

The architect inspects the **old-vs-new diff of every changed file**, per phase, before porch
advances. A manifest is what makes that inspection possible: **the architect cannot inspect what
is not listed**, so a changed prompt-bearing file absent from its phase's manifest fails the
phase (**T16**, `spec-1280-phase-manifest.test.ts`).

## File

`phase-<N>-<slug>.md`, one per implement phase, committed with that phase's work.

## Required shape

A manifest has one row per changed file with **all four fields**. Phases with more than 12
files declare explicit `## Batch N` sections, each ≤12 — the cap is on *what the architect reads
in one sitting*, which includes tests, registry and retirements entries, not only prompt files.

```markdown
# Phase 3 — protocol.md x10 (G3)

## Batch 1

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `codev-skeleton/protocols/spir/protocol.md` | 3703 | 690 | P6, P1, P7 | State machine now references protocol.json via `{{> }}`; deleted phase-body checklists |
| `codev-skeleton/protocols/air/protocol.md` | 643 | 380 | P1, P7 | Deleted worst-case padding; kept artifact contract |
```

- **Old / New** — served word counts from `scripts/measure-prompt-surface.sh`.
- **Principles** — which of P1–P7 were applied (or `none` for an inspected-but-unchanged file).
  P5 is N/A project-wide, with reason, per the spec.
- **Rationale** — one line. What was cut, and why it was safe to cut.

## What a manifest is not

It is not a substitute for reading the diff. It is the index that makes the diff review
complete and bounded.
