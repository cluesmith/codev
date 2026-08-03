# spir-1338 — Retire Gemini CLI as a builder harness

## Phase: Specify (started)

Strict-mode SPIR builder. Porch drives; I write artifacts + `porch done`.

### Architect constraint (2026-08-03T19:12Z)
We are NOT cluesmith/codev maintainers on this repo. The PR needs an upstream
maintainer to approve/merge — do NOT expect self-merge. Spec/plan/impl must stand
on their own for external review; architect handles merge coordination.

### Scope (issue #1338)
Retire the standalone **Gemini CLI (`gemini`) builder harness**. NON-goals (leave
alone): `agy`/Antigravity consult lane, `consult -m gemini`, `agy` architect (#1063).
No "Baked Decisions" section in the issue body.

### Verified surface (builder-harness only)
Core: `packages/codev/src/agent-farm/utils/harness.ts`
  - 177-186 `GEMINI_HARNESS` (GEMINI_SYSTEM_MD injection)
  - 212 `gemini:` in `BUILTIN_HARNESSES`
  - 338 `basename.includes('gemini')` in `detectHarnessFromCommand`
  - 358-393 `resolveHarness` (throws generic "Unknown harness" on miss; auto-detect
    branch silently returns CLAUDE_HARNESS on undetected — the footgun)
  - 4-6 module header comment
Config/types: `types.ts:207`, `lib/config.ts:26,28` — `builderHarness?: string` (free-form).
Doctor: `doctor.ts:816-828` — warns only about gemini-as-ARCHITECT; message
  "gemini is supported for builders, not architects" becomes STALE/wrong after retirement.
Reset: `reset/context.ts:414` iterates `Object.keys(BUILTIN_HARNESSES)` to recognize a
  running builder's harness (edge case if gemini leaves the registry).
Tests: `harness.test.ts`, `harness-integration.test.ts`, `discover-resume-session.test.ts`,
  `config.test.ts:138-141`.
Docs (user-facing): `README.md:392,436,448-460` (config example presents gemini builder;
  prose already has a soft "will stop working / follow-up" caveat — strengthen to "retired").
Governance (Review-phase updates): `codev/resources/arch.md:291,311,313,317`,
  `lessons-learned.md:80`.

### Corrections to Explore agent's inventory
- FALSE: `packages/codev/skeleton/resources/commands/agent-farm.md:618-627` "Builder
  harnesses" section naming gemini. That dir does NOT exist on disk; canonical
  `codev-skeleton/resources/commands/agent-farm.md` has no harness/gemini section.
  → No skeleton doc presents gemini as a builder. No dual-tree doc mirror needed for
  this change (only self-hosted `codev/resources/*` governance docs, no skeleton twin).

### Design through-line (for Solution Approaches)
Must recognize `gemini` as a RETIRED name and fail with a SPECIFIC retirement message at
BOTH resolution paths — explicit `builderHarness: "gemini"` AND auto-detected
`builder: "gemini ..."`. A pure delete (a) throws a generic "Unknown harness" on the
explicit path (no retirement explanation) and (b) SILENTLY falls back to CLAUDE_HARNESS on
the auto-detect path (#929-class dangerous mismatch). Recommend a retirement-sentinel in
the resolver + correct doctor's stale builder-support message + fix README example.
