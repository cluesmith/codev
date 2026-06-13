---
approved: 2026-06-06
validated: [codex, claude]
---

# Specification: Symmetric Hot/Cold Governance Docs — Make `arch.md` and `lessons-learned.md` Consumed at Decision Time

## Metadata
- **ID**: spec-2026-06-05-987-engineering-wisdom-write-only
- **Issue**: #987
- **Status**: approved 2026-06-06 (codex, claude; gemini lane scoped out — defect #1032/#1033)
- **Created**: 2026-06-04 · **Revised**: 2026-06-05
- **Protocol**: SPIR (strict)

## Clarifying Questions Asked

The issue framed this as a genuine design fork. An initial round of architect answers (2026-06-04) chose "retire `lessons-learned.md` + single design-heuristics digest." After the architect and Waleed worked through it at the spec-approval gate, that approach was **superseded** by the model specified below (2026-06-05). The superseding decisions are **baked** (treated as fixed; see Constraints).

**Why the model changed (the reframe):** the problem is **not lessons-only**. `arch.md` is **identically write-only** — `buildPhasePrompt()` injects *neither* `arch.md` *nor* `lessons-learned.md` (verified: it injects only the GitHub/spec summary, the current plan phase, retry history, and user answers). Both governance docs are merely *written* by the review phase and *pruned* by MAINTAIN; neither is ever in context at decision time. So the fix must be **symmetric across both docs**, and retiring one of them was solving half the problem with an asymmetry. **Nothing is retired** in the new model.

## Problem Statement

Codev's two durable-knowledge governance documents — `codev/resources/arch.md` (system shape) and `codev/resources/lessons-learned.md` (engineering wisdom) — are both **write-only**. Knowledge accretes into them, but nothing in the framework *consumes* either one at the moment a decision is being made, so neither can change agent behavior under load.

Every framework reference to both files is producer-side or prune-side:
- The SPIR / ASPIR / PIR **review** phase (and `porch/prompts/review.md`) **append** to both (`## Architecture Updates` → `arch.md`; `## Lessons Learned Updates` → `lessons-learned.md`).
- **MAINTAIN** + the `update-arch-docs` skill **extract into / prune** both.
- Porch **checks** only enforce that the *review file* contains those two sections — never that anyone *reads* the docs.

**Nothing reads or injects either doc at decision time, and nothing enforces that it is read.** They are append-only archives with no consumer: documentation that hopes to be grepped, which under load agents do not do. The concrete downstream failure cited in the issue — a boolean-vs-role auth design miss — is exactly the class of mistake a *written-but-unread* governance doc can never prevent, because it is not in context when the design is chosen.

The governing principle (from the issue): **knowledge only changes behavior if it lives in always-on context, an executed protocol step, or an enforced check.** A markdown archive nobody reads is none of those.

## Current State

**The docs (verified):**
- `codev/resources/lessons-learned.md` — ~400 lines / ~250 one-line entries across topical sections; a large fraction are spec-narrow implementation recipes alongside a smaller set of genuinely behavior-changing, cross-cutting lessons.
- `codev/resources/arch.md` — the system-shape governance doc, maintained by the same review/MAINTAIN machinery.

**Producers (write/prune) — verified:**
- `codev-skeleton/protocols/{spir,aspir}/prompts/review.md` (§4 "Update Architecture and Lessons Learned Documentation") and `codev-skeleton/protocols/pir/prompts/review.md`: instruct the builder to **append** to both docs and record what was added in the review's `## Architecture Updates` / `## Lessons Learned Updates` sections.
- `codev-skeleton/porch/prompts/review.md`: same pattern.
- `codev-skeleton/protocols/maintain/{protocol.md,prompts/maintain.md}`: scan `codev/reviews/`, extract, and prune both docs.
- `update-arch-docs` skill (both trees): owns the pruning discipline and the arch.md-vs-lessons-learned two-doc routing.

**Enforcement — verified:** `protocol.json` for spir/aspir/pir defines review-phase checks `review_has_arch_updates` and `review_has_lessons_updates` (grep the review file for the two section headers). These police the **producer**, never the **consumer**.

**Consumers (read at decision time) — verified: NONE for either doc.**
- `packages/codev/src/commands/porch/prompts.ts` (`buildPhasePrompt()`) injects the project summary, current plan-phase metadata, retry-history header, and user answers via `{{variable}}` substitution (`substituteVariables`). It **reads neither `arch.md` nor `lessons-learned.md`.**
- The phase prompts (`specify.md`, `plan.md`, `implement.md`, …) never read either doc.
- Role files and `CLAUDE.md` / `AGENTS.md` mention them only as MAINTAIN *targets* / directory-map entries — no "consult before deciding" instruction, and no `@import` mechanism is in use today.

**Injection feasibility (verified):** prompts are markdown with `{{variable}}` placeholders filled by `substituteVariables`; framework files resolve through Codev's **four-tier fallback** (`.codev/` override → `codev/` project copy → runtime cache → installed-package skeleton). A new always-on injection can therefore be implemented as variables filled from resolver-located files.

**Scaffold / install / update path (verified — corrected at plan-iter1):**
- `packages/codev/src/lib/scaffold.ts` defines `copyResourceTemplates()` (copies `['lessons-learned.md', 'arch.md', 'cheatsheet.md', 'lifecycle.md']` into `resources/`), but **it is dead code**: `init.ts`, `adopt.ts`, and `update.ts` do **not** call it (only its own test does). `init.ts` explicitly states framework files resolve at runtime from the package, and seeds only user dirs + skills + root files. So **new projects do not get `codev/resources/*` copied today** — those files are created on first write (review/MAINTAIN) or resolved at runtime.
- `init.ts`/`adopt.ts` seed via `copySkills` + `copyRootFiles`; `update.ts` refreshes only `.claude/skills/` + `CLAUDE.md`/`AGENTS.md` (never `codev/resources/`). `UPDATABLE_PREFIXES` drives one-time hash-migration cleanup, not resource creation.
- `packages/codev/src/lib/templates.ts` `USER_DATA_PATTERNS` lists `resources/arch.md` and `resources/lessons-learned.md` (protection if ever copied).
- **Implication**: materializing the hot files into a project requires an **explicit new creation step** wired into `init`/`adopt`/`update` (mirroring `copySkills`) — modifying the dead `copyResourceTemplates`/`UPDATABLE_PREFIXES` would be a no-op.

**Scale & shape (verified):** the docs/term are referenced across **both** the `codev/` instance tree and the `codev-skeleton/` distribution tree (mirrored protocol copies for spir/aspir/pir/maintain, the skill in two places, `CLAUDE.md`, `AGENTS.md`, `templates.ts`), plus **historical** artifacts that must NOT be edited (`codev/maintain/*`, `codev/plans/*`, `codev/projects/*`, archives, prior reviews, the release protocol's historical references). This is a multi-file change across two mirrored trees, with the well-known dual-directory footgun.

## Desired State

Each governance doc is split into a **two-tier (hot/cold)** pair, **symmetrically**:

| Tier | Files | Size | Consumed how |
|---|---|---|---|
| **HOT** | `arch-critical.md`, `lessons-critical.md` | **Hard-capped** — a handful of lines each (capped facts **+** a bounded cold-doc map) | **Always injected into context** (every porch phase prompt + interactive sessions, CLAUDE.md-style). The behavior-changer. |
| **COLD** | `arch.md`, `lessons-learned.md` | Full, may expand | **Kept** as on-demand reference (grep/read for depth). Not retired, not deleted; spec-narrow recipes stay. Made *discoverable* by the hot file's cold-doc map. |

1. **Two new HOT files** (`codev/resources/arch-critical.md`, `codev/resources/lessons-critical.md`, mirrored into the template trees). Each hot file has **two parts**, both inside the same hard cap:
   - **(a) Capped facts** — the small set of cross-cutting facts/heuristics that should change a decision *right now*.
   - **(b) A bounded cold-doc map** — a terse, curated index of *its cold doc's top-level topics*, each with a one-line **"consult when…"**. E.g. `arch-critical.md` maps `arch.md`'s top-level sections (Tower, porch state machine, shellper/PTY, consult, four-tier resolver, …); `lessons-critical.md` maps `lessons-learned.md`'s top-level sections. This is the bridge that makes the always-on hot tier surface *what deeper reference exists and when to consult it* — so the cold tier is genuinely discoverable rather than write-mostly.

   The map is **bounded exactly like the facts**: top-level topic headings + when-to-consult only — **NOT** a full table of contents enumerating every cold entry, and **NOT** auto-generated from every cold line (a growing full TOC would re-accrete on the always-on surface, the very failure being fixed). The map **counts against the hot file's cap** and is subject to the same displacement + MAINTAIN-policing discipline.

2. **Both COLD docs are kept intact** — `arch.md` and `lessons-learned.md` continue to exist as the full reference archives. Nothing is deleted; spec-narrow content remains as honest reference. The cold tier stops *pretending* to change behavior (the hot facts do that) and becomes *reliably discoverable* via the hot file's cold-doc map — "on-demand" no longer assumes the agent already knows the doc exists and covers the topic.

3. **The hot tier reaches both consumption surfaces — but the surfaces are mechanically different and resolve the source at different times:**
   - **porch-driven builders (runtime injection)** — `buildPhasePrompt()` resolves each hot file through the **runtime four-tier resolver** (`resolveCodevFile()`, verified to exist) and injects it into **every** phase prompt. Fallback is genuine *runtime* fallback: an upgraded-but-not-yet-seeded repo gets the installed-skeleton copy at injection time.
   - **interactive sessions (generation-time managed block)** — `CLAUDE.md` / `AGENTS.md` are **static files with no runtime loader/import** (verified). The hot content therefore reaches interactive sessions as a **generated managed block** written into `CLAUDE.md` and `AGENTS.md` at **`codev init` / `codev update` (generation) time**, regenerated from the hot files (which the generator resolves through the four-tier chain *at generation time*). There is no runtime fallback on this surface — there cannot be, because nothing loads these files at runtime; the always-on property comes from the block being auto-loaded by the agent harness, the freshness from regeneration on update.

   The **single source of truth** for both surfaces is the two hot files; the interactive block is a *generated mirror*, never hand-maintained. The "four-tier" guarantee thus means **runtime resolution for the porch surface** and **generation-time resolution for the interactive surface** — these are stated separately and tested separately.

4. **The hard cap is load-bearing** and covers the **whole** hot file (facts **+** cold-doc map together). It is the mechanism that makes "inject into every prompt" affordable (negligible per-prompt tokens) and that prevents re-accretion on either part. Adding a fact requires **demoting** a weaker fact into the corresponding cold doc; the map likewise stays at top-level topics only. The cap is policed by MAINTAIN; honored by the producer at capture time.

5. **Producers route hot-vs-cold, not append-everywhere.** At review time, each new architecture fact and each new lesson is **routed**: does it belong in the hot file (behavior-changing, earns/displaces a capped slot) or the cold doc (reference)? This replaces today's "append to the archive."

6. **MAINTAIN polices the cap (per hot file), keeps the cold-doc map bounded AND accurate, and maintains the cold docs as reference.** It no longer treats accretion in the cold tier as the primary failure mode (the cold docs are allowed to be full reference); the discipline that matters moves to the hot-tier cap + correct hot/cold routing + **map accuracy**. Specifically, as cold-doc top-level sections are added or removed, MAINTAIN updates the hot file's cold-doc map to match (kept bounded — top-level topics only). The arch-vs-lessons routing the skill already owns is extended with the hot/cold axis.

Net effect: the small amount of knowledge that actually changes decisions is unavoidably in front of every agent at every step, while the full reference archives remain available on demand — symmetrically for system shape and engineering wisdom.

## Stakeholders
- **Primary Users**: every agent at every porch phase (consume the hot tier); interactive architect sessions (consume the hot tier); review-phase agents (route hot-vs-cold).
- **Secondary Users**: architects (curate the hot files, set/keep the cap); MAINTAIN runs (police the cap, maintain cold docs).
- **Technical Team**: Codev framework maintainers (this repo + downstream adopters who inherit the skeleton).
- **Business Owners**: M Waleed Kadous (architect / decision authority).

## Success Criteria
- [ ] **Two HOT files exist** — `codev/resources/arch-critical.md` and `codev/resources/lessons-critical.md` — as the live instance files and as starter templates in the trees scaffold reads from (`codev-skeleton/templates/` and `codev/templates/`), each with an explicit **hard cap** (stated as entry count and/or "fits in a handful of lines") and a documented **displacement discipline**.
- [ ] **HOT files are seeded by curation** — the genuinely behavior-changing, cross-cutting subset is lifted from the cold docs into the hot files. This is curation, **not** deletion: the cold docs are unchanged in content except for any demoted/duplicated framing.
- [ ] **Each HOT file carries a bounded cold-doc map** — a curated index of its cold doc's **top-level topics** with a one-line "consult when…" each, sized within the hot file's cap. It is explicitly **not** a full/auto-generated TOC of every cold entry. The map is part of the hot content that gets injected (porch) and mirrored into the managed block (interactive), so the cold tier is discoverable from always-on context.
- [ ] **Both COLD docs are KEPT** — `codev/resources/arch.md` and `codev/resources/lessons-learned.md` still exist with their reference content intact (no deletion, no wholesale gutting, spec-narrow recipes retained).
- [ ] **porch injects both hot files into every phase prompt** — `buildPhasePrompt()` injects `arch-critical.md` and `lessons-critical.md` content into the assembled prompt for **all** phases (specify, plan, implement, defend, evaluate, review). Verifiable: assemble a phase prompt for ≥2 distinct phases and confirm both hot files' text appears **verbatim and unconditionally** (not a "go read this file" pointer).
- [ ] **Interactive sessions get the hot tier always-on, via a testable generated managed block** — `CLAUDE.md` and `AGENTS.md` contain a delimited managed block (explicit begin/end markers) holding the hot content, generated from the two hot files. Concretely verifiable: after `codev init`/`codev update`, the markers + hot content are present in both root docs; editing a hot file and re-running the generator updates the block; user content **outside** the markers is preserved across regeneration; the block is identical in `CLAUDE.md` and `AGENTS.md`. The block is a **generated mirror only** — never hand-edited (single source of truth = the hot files).
- [ ] **Surface-appropriate four-tier resolution** — the **porch** surface resolves hot files through the **runtime** resolver (`resolveCodevFile()`), so an upgraded-but-not-yet-seeded repo injects the installed-skeleton copy at runtime; the **interactive** surface resolves the source through the four-tier chain **at generation time** (no runtime fallback exists for static root docs). Both are stated and tested as distinct behaviors.
- [ ] **Tier-4 placement** — the hot files are present at the installed-skeleton location the runtime resolver reads for tier-4 fallback (`skeleton/resources/…`), **in addition** to the `templates/` trees scaffold copies from, so runtime fallback actually finds them.
- [ ] **Fresh projects and upgrades materialize the hot files** — `codev init` and `codev adopt` create `arch-critical.md` / `lessons-critical.md` in `codev/resources/`, and `codev update` creates them for existing adopters when absent (skip-existing so a curated copy is never clobbered), with `USER_DATA_PATTERNS` protecting them once present. **Mechanism correction (plan-iter1 finding):** this is done via an explicit creation step wired into `init`/`adopt`/`update` (the way `copySkills`/`copyRootFiles` already are) — **not** via the existing `copyResourceTemplates()` (verified dead: only its own test calls it) and **not** via `UPDATABLE_PREFIXES` (verified: used for hash-migration cleanup, not resource creation). Porch injection does not depend on local creation — it falls back to the tier-4 skeleton copy via `resolveCodevFile()` — but local creation is required so the hot tier is **visible and editable** for per-project curation.
- [ ] **`codev update` refreshes the interactive managed block** without clobbering user edits (replace-in-place between markers; insert at a defined anchor if markers are absent — not whole-file `.codev-new`), and tests cover an `update` run on a fixture lacking both the hot files and the markers (both get created).
- [ ] **Cold docs preserved through update** — `codev update` keeps `arch.md` and `lessons-learned.md` intact (they remain `USER_DATA`); no crash for existing adopters. (Hot-file creation + managed-block refresh specifics are covered in the dedicated criterion below.)
- [ ] **Producers route hot-vs-cold** — the spir/aspir/pir + `porch/prompts/review.md` review prompts are changed from "append to `arch.md` / `lessons-learned.md`" to "**route** each new fact to the hot file (cap+displacement) or the cold doc," for **both** docs. The review sections reflect routing.
- [ ] **Porch review checks remain valid** — the existing `review_has_arch_updates` / `review_has_lessons_updates` checks still pass on a correctly-routed review (renamed if the review section names change). **No new consumption check is added** (consumption is via always-on injection, per the principle and the prior "executed step, no hard consumption check" decision).
- [ ] **MAINTAIN polices the cap and the map** — the MAINTAIN protocol + `maintain.md` prompt + `update-arch-docs` skill (both trees) gain hot-tier cap-policing + displacement, **and** keep each hot file's cold-doc map **bounded and accurate**: as the cold doc's top-level sections change, the map is updated to match (top-level only — never expanded into a full TOC). The skill's cold-tier philosophy is updated so the cold docs may retain spec-narrow reference content (the anti-accretion discipline moves to the hot cap). Arch-vs-lessons routing is extended with the hot/cold axis.
- [ ] **Explicit live-surface sweep (both trees)** — every live surface is updated, not left to grep alone: spir/aspir/pir/maintain `protocol.md`, the `protocols/*/templates/review.md` review templates, MAINTAIN templates, the PIR builder-prompt + implement prompt, `porch/prompts/review.md`, the `update-arch-docs` skill (frontmatter + body), `CLAUDE.md`/`AGENTS.md` (directory map + the new always-on model), role files, and `templates.ts` — each audited in **both** `codev/` and `codev-skeleton/`.
- [ ] All existing tests pass; tests referencing the old copy list / section names are updated.

## Constraints

### Architect's binding decisions (2026-06-05 — baked, treat as fixed)
- **Symmetric two-tier (hot/cold) across BOTH `arch.md` and `lessons-learned.md`.** Not a lessons-only change.
- **Nothing is retired / deleted.** The cold docs are kept and may expand; spec-narrow recipes stay as reference.
- **Hot files (`arch-critical.md`, `lessons-critical.md`) are HARD-CAPPED** (a handful of lines each). The cap is load-bearing and non-negotiable; growth happens by **demotion to cold**, not by raising the cap.
- **Injection scope = ALWAYS-ON** (every prompt, CLAUDE.md-style), not design-time-only.
- **Hot tier must reach BOTH surfaces** — porch builders (`buildPhasePrompt()`) **and** interactive sessions (CLAUDE.md-style) — via the four-tier fallback chain.
- **Producer = route hot-vs-cold at capture; MAINTAIN polices the cap.**

### Technical constraints
- Dual mirrored trees (`codev/` + `codev-skeleton/`) kept consistent; every edit audited in both.
- Historical artifacts are read-only history — do not rewrite them.
- Single source of truth for the hot content across the two consumption surfaces — no hand-maintained duplicate that can drift.
- Interactive-surface mechanism must be tool-agnostic (CLAUDE.md + AGENTS.md), not Claude-only, unless the architect accepts a Claude-only mechanism at the gate.
- Downstream adopters inherit the skeleton; it must ship a coherent hot/cold model with seeded hot-file templates and routing-based review prompts.

### Process constraints
- No time estimates (per protocol).
- Run the dual-directory audit + exhaustive `rg` before claiming "all surfaces updated."

## Assumptions
- The hot files' value comes from being *tiny and always-present*; the cap is the structural guarantee against re-accretion and the reason always-on injection is affordable.
- The behavior-changing subset distilled into each hot file is small (order a handful of entries); the bulk of each cold doc stays put as reference.
- Injecting into **every** phase (not just design) is correct per decision A; the marginal token cost is negligible given the cap.
- A single-source-of-truth file per hot tier can feed both the programmatic (porch) and interactive (CLAUDE/AGENTS) surfaces without a hand-maintained duplicate.

## Solution Approaches

### The two consumption surfaces (the meaty part — now locked, not deferred)
The hot files are the single source of truth. The two consumers are mechanically different; the spec **commits** to a mechanism for each (the choice is too central to defer — `@import` and generated-block have materially different guarantees, so leaving it open would leave the success criteria ambiguous).

**Surface 1 — porch-driven builders (runtime resolver injection).** `buildPhasePrompt()` resolves `arch-critical.md` + `lessons-critical.md` via `resolveCodevFile()` (the existing runtime four-tier resolver) and injects them into **every** phase prompt. Genuine runtime fallback; low-risk; mirrors existing code. **The injection *form*** — an unconditional prepended block in `buildPhasePrompt()` vs. per-template `{{arch_critical}}`/`{{lessons_critical}}` variables — **is decided in the plan.** (An earlier draft of this spec over-stated this as "locked to variables" in one place while the Notes said it was deferred; that internal contradiction is resolved here: the *what* (always-on, every phase, runtime-resolved) is fixed; the *form* is a plan decision. The prepend form is favored because it guarantees presence without requiring every phase-prompt template to carry the variable.)

**Surface 2 — interactive sessions (LOCKED: generated managed block; `@import` rejected).** A delimited **managed block** is generated into `CLAUDE.md` and `AGENTS.md`:
- **Markers**: explicit begin/end sentinels (e.g. `<!-- BEGIN CODEV HOT CONTEXT (generated — do not edit) -->` … `<!-- END CODEV HOT CONTEXT -->`). Everything between the markers is owned by the generator; everything outside is user content.
- **Source**: the two hot files, resolved through the four-tier chain **at generation time**.
- **Regeneration**: written by `codev init` (new repos) and refreshed by `codev update` (existing repos) — and by any `codev`-side sync entry point the plan defines. The generator **replaces only the managed block in place**, preserving all user content outside the markers; if no markers exist yet (pre-existing adopter), it **inserts** the block at a defined anchor rather than routing the whole file to `.codev-new`.
- **Tool-agnostic**: it is plain markdown, so it works identically for `CLAUDE.md` (Claude Code) and `AGENTS.md` (Cursor/Copilot/etc.). `CLAUDE.md` ≡ `AGENTS.md` is preserved because both get the same generated block.

*Why `@import` is rejected:* it is Claude-Code-specific (AGENTS.md consumers don't honor it) and its path resolution does not follow the four-tier chain — it fails the tool-agnostic and single-source guarantees this surface requires.

*Why not runtime fallback for Surface 2:* verified there is no runtime loader for `CLAUDE.md`/`AGENTS.md`; the harness auto-loads them as static files. Freshness therefore comes from regeneration at update time, which is the correct and only available point to apply the four-tier source resolution for this surface.

**Mandatory guarantees for Surface 2 (locked before approval):** always-on (inside the auto-loaded root docs), single-source-of-truth (generated from the hot files, never hand-edited), tool-agnostic (plain markdown in both root docs), and non-clobbering on update (managed-block replace-in-place; user content preserved). The remaining plan-level latitude is the *marker spelling*, the *insertion anchor*, and the *exact `codev` sync entry point* — not the mechanism class.

### Approaches considered and rejected
- **Retire `lessons-learned.md` + single design-heuristics digest** (the prior 2026-06-04 model). Rejected by the architect because it is asymmetric — it ignores that `arch.md` is identically write-only — and because deleting reference content loses the on-demand archive. Replaced by hot/cold, which keeps the archives and fixes both docs.
- **Inject the whole cold docs at design time.** Rejected — re-creates unbounded context cost and drowns the few behavior-changing facts; the cap-bounded hot tier is the disciplined alternative.
- **Relevance-retrieval / tagging engine.** Rejected — the hard cap makes "always inject in full" viable, so no retrieval machinery is needed.

## Open Questions

### Critical (Blocks Progress)
- None — the model and its baked decisions are fixed by the architect instruction.

### Important (Affects Design)
- [ ] **Exact cap per hot file** (covering facts **+** cold-doc map together). Proposed: each hot file ≤ ~10 single-line fact entries plus a top-level cold-doc map / "fits in a handful of lines at a glance." Final number set in the plan / confirmed at the plan gate.
- [ ] **Review-section naming** — keep `## Architecture Updates` / `## Lessons Learned Updates` (with routing instructions inside) vs rename to signal hot/cold routing. Keeping preserves the existing porch checks with minimal churn. Lean: keep names, change the instructions. Resolve in plan.

*(Resolved at spec time — no longer open:)* the interactive-surface **mechanism** is locked to the generated managed block (`@import` rejected). The porch **injection form** (prepend vs per-template variable) is a **plan decision** (the plan pins it). Remaining interactive-surface latitude: marker spelling, insertion anchor, exact `codev` sync entry point.

### Nice-to-Know (Optimization)
- [ ] Whether the hot files should carry a one-line "how to curate / demote" header for architects.
- [ ] Whether a lightweight cap-check (line count) belongs in MAINTAIN tooling vs. left to human judgment at MAINTAIN time.

## Test Scenarios

This is a methodology/mechanism change; "tests" are structural assertions plus prompt-assembly verification.

### Functional Tests
1. **Always-on injection (porch)**: assemble phase prompts for ≥2 phases (e.g. specify and implement) and assert both `arch-critical.md` and `lessons-critical.md` text appears verbatim in each.
2. **Runtime fallback (porch)**: with no `codev/resources/arch-critical.md` present, `buildPhasePrompt()` injects the installed-skeleton copy (no empty/failed injection) via `resolveCodevFile()`.
3. **Interactive managed block (generation)**: after `codev init`, `CLAUDE.md` and `AGENTS.md` each contain the begin/end markers + hot content, identical between the two files.
4. **Managed-block refresh, non-clobbering**: editing a hot file and re-running the generator updates the block; user content placed outside the markers survives unchanged; a root doc with no markers (existing adopter) gets the block inserted, not routed to `.codev-new`.
5. **Single source of truth**: a hot-file edit is the *only* edit needed to change both the porch prompt (runtime) and the regenerated interactive block — no hand-maintained duplicate.
6. **Cold docs preserved**: `arch.md` and `lessons-learned.md` still exist with reference content after the change, and across `codev update`.
7. **Producer routes**: review prompts instruct hot-vs-cold routing for both docs; no "append everything to the archive" instruction remains.
8. **Checks valid**: porch review checks pass on a correctly-routed review.
9. **Scaffold**: a freshly scaffolded project contains all four files (`arch.md`, `arch-critical.md`, `lessons-learned.md`, `lessons-critical.md`); tier-4 skeleton copies exist where the runtime resolver reads them.
10. **Bounded cold-doc map**: each hot file's map lists only top-level cold-doc topics (each with a "consult when…"), is within the cap, and is **not** a full enumeration of cold entries; the map text is part of what the porch injection and the interactive managed block carry.

### Non-Functional Tests
1. **Cap respected**: each seeded hot file fits the stated cap.
2. **Cross-tree consistency**: every changed file present in both trees is changed in both; the two new hot files exist in both template trees.
3. **Suite green**: existing unit/e2e tests pass; tests referencing the old copy list / sections updated.

## Dependencies
- **Internal**: `buildPhasePrompt()` + `substituteVariables` (`packages/codev/src/commands/porch/prompts.ts`); `resolveCodevFile()` (`packages/codev/src/lib/skeleton.ts`, runtime four-tier resolver); `copyRootFiles()` (`scaffold.ts`, current `CLAUDE.md`/`AGENTS.md` copy + `.codev-new` conflict behavior) — to be extended with managed-block generation; the new managed-block generator/sync entry point; the spir/aspir/pir/maintain protocol definitions + prompts + templates (both trees); `porch/prompts/review.md`; the `update-arch-docs` skill (both trees); `scaffold.ts` + `scaffold.test.ts` + `templates.test.ts`; `templates.ts` (`USER_DATA_PATTERNS`, `UPDATABLE_PREFIXES`); the installed-skeleton `resources/` tier-4 location; `CLAUDE.md`/`AGENTS.md`; role files.
- **External**: none.
- **Libraries/Frameworks**: none new.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-------------|
| Hot files silently grow past the cap (re-accretion) | Med | High | Explicit hard cap + demote-on-add discipline + MAINTAIN cap-policing; producer prompt forbids "append, trim later." |
| "Inject" implemented as a weak pointer (the very failure being fixed) | Med | High | Success criterion requires verbatim, unconditional text in the assembled prompt and always-on interactive context — not a file reference. |
| Interactive surface drifts from the source of truth | Med | Med | Locked to a generated managed block (no hand-editing); begin/end markers; regenerated on `codev update`; CLAUDE≡AGENTS check. |
| Managed-block regeneration clobbers user edits to `CLAUDE.md`/`AGENTS.md` | Med | High | Replace **only** between markers; preserve content outside; insert-at-anchor (not whole-file `.codev-new`) when markers are absent; covered by a non-clobber test. |
| Tool-specific interactive mechanism leaves AGENTS.md consumers without the hot tier | Low | Med | Mechanism locked to a plain-markdown generated block (tool-agnostic); `@import` rejected. |
| Missed surfaces in the dual tree (footgun) | High | Med | Explicit live-surface sweep list + exhaustive `rg` in both trees; CMAP reviewers historically catch this. |
| Always-on injection bloats every prompt | Low | Med | The hard cap keeps per-prompt cost negligible by construction; that is the cap's primary justification. |
| Editing historical artifacts to "tidy" them | Low | Med | Explicit out-of-scope list; leave history intact. |
| Cold-tier philosophy change misread as "stop maintaining arch.md/lessons-learned" | Low | Med | Spec is explicit: cold docs are kept and maintained as reference; only the *anti-accretion* emphasis moves to the hot cap. |

## Expert Consultation
**Date (iter 1, prior model)**: 2026-06-04 — Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES (four completeness gaps, all incorporated). That round reviewed the now-superseded retire-and-route model; its surviving, still-applicable findings (four-tier resolver, scaffold + tests, explicit live-surface sweep, route-not-append, MAINTAIN cap-policing, `codev update` coherence) are carried into this revision and re-scoped to the hot/cold split.

**Date (iter 2, hot/cold model)**: 2026-06-05 — Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. Both Codex and Claude converged on the **interactive-session surface** being underspecified. Changes made in response:
- **Separated runtime vs generation-time resolution.** Verified `CLAUDE.md`/`AGENTS.md` are static with no runtime loader and `resolveCodevFile()` is the runtime resolver; the spec now states the porch surface resolves at runtime and the interactive surface resolves the source at **generation time** (no runtime fallback for static root docs). *(Codex #1)*
- **Locked the interactive mechanism** to a generated managed block and **rejected `@import`** — no longer deferred to plan, because the guarantees differ materially by mechanism. *(Codex #4)*
- **Defined the migration / non-clobber path**: managed block with begin/end markers, replace-in-place, preserve user content outside markers, insert-at-anchor when markers absent (not whole-file `.codev-new`); verified against current `copyRootFiles()` behavior. *(Codex #2, Claude #3)*
- **Made the interactive criteria testable**: markers + content present after generation, refresh-on-edit, non-clobber, CLAUDE≡AGENTS. *(Codex #3)*
- **Tier-4 placement**: hot files must also live where the runtime resolver reads tier-4, in addition to the `templates/` trees. *(Claude #1)*
- **`codev update` file creation**: `UPDATABLE_PREFIXES`/copy logic must create the new hot files for existing adopters; `USER_DATA_PATTERNS` protects them once present. *(Claude #3)*

**Plan-iter1 correction (2026-06-06)**: plan-phase CMAP (Gemini/Codex REQUEST_CHANGES, Claude COMMENT) surfaced that this spec's install/update criteria were built on a **dead-code assumption**: `copyResourceTemplates()` (which copied `lessons-learned.md`/`arch.md`) is not called by `init`/`adopt`/`update`. The spec's Current State, the two install/update success criteria, and the porch injection-form text are corrected above to reflect the real architecture (framework files resolve at runtime; hot files materialized via an explicit wired-in creation step; injection *form* is a plan decision, resolving an internal contradiction the reviewers caught). The feature's **goals are unchanged** — every project gets the always-on hot tier; only the mechanism is corrected.

**Architect refinement (2026-06-06)**: added the **bounded cold-doc map** to the hot-file model — each hot file now = capped facts + a curated top-level map of its cold doc (with "consult when…"), so the always-on hot tier makes the cold reference discoverable (closing the "agents don't grep what they don't know exists" gap that motivated the spec). Folded into the hot/cold model, the success criteria, MAINTAIN policing (bounded **and** accurate), and a test scenario. Re-consult was left to builder discretion for this bounded, additive change; given it is a self-contained model addition (not a re-architecture) over an already-validated model, a full 3-way re-consult was judged unnecessary — flagged here so the architect can request one at the gate if desired.

## Approval
- [ ] Architect Review (human gate: spec-approval)
- [ ] Expert AI Consultation Complete (iter 2, on the hot/cold model)

## Notes
Spec altitude is intentionally WHAT/WHY. The two consumption surfaces and the cap value are described, but the final injection mechanism (template variable vs block; generated managed block vs `@import`), the exact cap number, and the precise seed contents of each hot file are deferred to the plan. The **one-time curation** that seeds the hot files (lifting the behavior-changing subset out of the cold docs) is meaningful work and should be its own plan phase, kept separate from the mechanical injection + scaffold + sweep changes.

---

## Amendments

<!-- TICK amendments, if any, recorded here in chronological order. -->
