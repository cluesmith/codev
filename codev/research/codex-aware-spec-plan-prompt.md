# Codex-Aware Spec & Plan Checklist (Drop-in Prompt Fragment)

> **Purpose**: Append to the architect's and builder's system prompts when drafting specs/plans that will go through CMAP. Mirrors [codex-false-alarm-prompt.md](codex-false-alarm-prompt.md) — both derive from the same 71-rebuttal corpus. False-alarm prompt = what Codex should stop doing. This = what to do up-front to avoid the iteration.
> **Why**: ~62% of Codex's REQUEST_CHANGES are genuinely actionable. The checklist below pre-empts the recurring categories so the spec/plan ships clean.
> **Companion**: [codex-request-changes-patterns.md](codex-request-changes-patterns.md) — full pattern catalogue and evidence.

---

Before publishing a spec or plan that will go through CMAP, verify each item. If you skip one, expect Codex to flag it.

**1. Defaults, errors, and edge cases for every new surface.** For every new field, flag, parser, or external dependency: specify default value, behavior when the source is unavailable (fail-fast or degraded), nullability, parsing rules (empty strings, NaN, unknowns), mutual exclusivity of conflicting flags, exact user-facing format. *Codex's #1 spec-review move.*

**2. Per-phase test matrix in the plan.** Name the test layer for each new behavior (`unit` / `handler` / `integration` / `Playwright/E2E`), the expected files, and what counts as sufficient coverage. If a layer is intentionally deferred, say so ("E2E coverage deferred to Phase 4"). Include negative-path tests for state-machine guards.

**3. Lock external contracts early.** For boundary-crossing changes (API, GraphQL, CLI ↔ data, persistence ↔ rendering): pin in the plan the exact ID contract, response shape (flat vs nested, field names), fallback matching rules, cache-key derivation, numeric limits, summary-vs-rich output.

**4. Phased migrations: name what survives this phase.** Write down the legacy path that remains active *this phase*, *why*, and *which phase removes it*. Use words like "dual-mode," "transitional fallback," "intentional coexistence." Without this annotation, Codex reads intentional coexistence as incomplete migration.

**5. Deprecation/removal: list every reference site.** When removing a concept, terminology, or feature, enumerate: source, tests, CLI flag registrations, types, **docs (CLAUDE.md, AGENTS.md, arch.md, lessons-learned.md)**, **skeleton templates**, examples. Run the grep up-front; treat each hit as a deliverable.

**6. Protocol/state-machine work: write the command and state flow as prose.** When touching an orchestrator (porch, gates, status files), include the exact command flow, who runs each command (builder vs human), which transitions are automatic vs human-driven, what each state means. Numbered prose beats bullets.

**7. Thin orchestrator handlers: point Codex at where real logic is tested.** If the handler is a thin wrapper over already-tested primitives, add: "underlying primitives X, Y, Z are tested in `…test.ts`; this handler is contract-tested via Z." Pre-empts Codex's #1 false alarm without arguing in the rebuttal.

**8. Documentation touchpoints are deliverables.** In the plan, enumerate every doc file (arch.md, CLAUDE.md/AGENTS.md, lessons-learned.md, skeleton template docs, INSTALL.md, README excerpts) the change will affect and list each as an explicit deliverable.

**9. Mark out-of-scope explicitly.** Add an `## Out of scope` section naming what the change deliberately does not cover (multi-repo support, full-paragraph summaries, skeleton template updates in a feature phase, etc.). Codex reads `Out of scope` as deliberate boundary, not oversight.

**10. Watch — security hardening.** Shell commands: `execFile` with args array, never string interpolation. File/socket creation: explicit permissions (0600/0700). Tools/skills that run commands: explicit safety-constraint section. *(Lower-confidence single-source pattern; high cost-of-miss.)*

When in doubt, write more spec/plan, not less. Specs that pre-empt these objections ship in one CMAP pass instead of two.
